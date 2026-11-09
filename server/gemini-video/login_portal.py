"""Operator-only local portal and SSH tunnel for a dedicated server browser.

The browser GUI is protected by a same-origin session and CSRF check; no raw
unauthenticated TCP forwarding port or Chromium debugging port is exposed.
"""
import argparse
import getpass
import hmac
import html
import ipaddress
import json
import os
import pathlib
import re
import secrets
import socket
import sys
import threading
import time
import urllib.parse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class SSH:
    def __init__(self, config):
        self.config = config
        self.client = None
        self.lock = threading.RLock()
        self.browser_target = None

    def connection(self):
        import paramiko
        with self.lock:
            if self.client and self.client.get_transport() and self.client.get_transport().is_active():
                return self.client
            client = paramiko.SSHClient()
            client.load_system_host_keys()
            if self.config.get('known_hosts'):
                client.load_host_keys(self.config['known_hosts'])
            client.set_missing_host_key_policy(paramiko.RejectPolicy())
            options = dict(hostname=self.config['host'], port=int(self.config.get('ssh_port', 22)),
                           username=self.config.get('user', 'root'), timeout=10, auth_timeout=10)
            password = self.config.get('password')
            if password:
                try:
                    client.connect(**options, password=password, look_for_keys=False, allow_agent=False)
                except paramiko.AuthenticationException:
                    client.connect(**options, password=password.rstrip(','), look_for_keys=False, allow_agent=False)
            else:
                client.connect(**options)
            client.get_transport().set_keepalive(15)
            self.client = client
            return client

    def execute(self, command):
        client = self.connection()
        _stdin, stdout, stderr = client.exec_command(command, timeout=35)
        data = stdout.read(65537)
        error = stderr.read(8192)
        if len(data) > 65536 or stdout.channel.recv_exit_status():
            raise RuntimeError('服务器管理操作未完成')
        return data.decode('utf-8', 'replace')

    def browser_channel(self):
        transport = self.connection().get_transport()
        with self.lock:
            if not self.browser_target or self.browser_target[0] < time.monotonic():
                name = self.config.get('browser_container', 'magpie-gemini-browser')
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', name):
                    raise ValueError('Invalid browser container name')
                raw = self.execute("docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' " + name)
                addresses = raw.split()
                if len(addresses) != 1 or not ipaddress.ip_address(addresses[0]).is_private:
                    raise ValueError('Dedicated browser must have one private network')
                self.browser_target = (time.monotonic() + 30, addresses[0])
            target = (self.browser_target[1], 5800)
        try:
            return transport.open_channel('direct-tcpip', target, ('127.0.0.1', 0), timeout=10)
        except Exception:
            self.browser_target = None
            raise


class Portal:
    def __init__(self, ssh, setup_dir, after_authorize=''):
        self.ssh = ssh
        self.root = pathlib.Path(setup_dir)
        self.root.mkdir(parents=True, exist_ok=True)
        self.nonce = secrets.token_urlsafe(32)
        self.console_cookie = secrets.token_urlsafe(32)
        self.after_authorize = after_authorize
        self.state = {'state': 'starting', 'message': '正在连接服务器的专用登录浏览器…', 'sessionSaved': False, 'magpieEnabled': False}
        self.lock = threading.Lock()
        self.stop = threading.Event()

    def poll(self):
        activated = False
        while not self.stop.is_set():
            try:
                data = json.loads(self.ssh.execute('docker exec magpie-gemini-video python /app/manage.py browser-status'))
                state = data.get('state', 'needs_login')
                browser = data.get('browser', {})
                if state == 'ready' and not activated:
                    if self.after_authorize:
                        result = self.ssh.execute(self.after_authorize)
                        activated = any(json.loads(line).get('registered') for line in result.splitlines() if line.startswith('{'))
                    else:
                        activated = True
                messages = {
                    'ready': '网页会话已自动保存，Magpie 视频通道已启用。真实生成和 MP4 下载仍需进行一次验收。' if activated else '网页会话已自动保存，正在接入 Magpie。',
                    'authorizing': '已检测到网页登录，正在验证并保存会话，请稍候…',
                    'needs_login': '请打开下方登录窗口，在专用浏览器中登录 Gemini。完成后会自动保存，无需复制 Cookie。',
                }
                if browser.get('state') == 'browser_unavailable':
                    messages['needs_login'] = '服务器浏览器正在启动或暂时不可用，请稍后再打开登录窗口。'
                value = {'state': state, 'message': messages.get(state, '正在检查专用浏览器会话…'),
                         'sessionSaved': bool(browser.get('sessionSaved')), 'magpieEnabled': activated,
                         'browserState': browser.get('state', 'starting')}
                with self.lock:
                    self.state = value
                (self.root / 'status.json').write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            except Exception:
                with self.lock:
                    self.state = {'state': 'unavailable', 'message': '服务器连接暂未完成，请确认 SSH 连接和专用浏览器容器可用。', 'sessionSaved': False, 'magpieEnabled': activated}
            self.stop.wait(5)


def handler(portal):
    class Handler(BaseHTTPRequestHandler):
        rbufsize = 0

        def log_message(self, *_):
            pass

        def origin(self):
            return 'http://127.0.0.1:' + str(self.server.server_port)

        def valid_host(self):
            return self.headers.get('Host') == '127.0.0.1:' + str(self.server.server_port)

        def console_authorized(self):
            try:
                cookie = SimpleCookie(self.headers.get('Cookie', '')).get('gemini_console')
                return bool(cookie and hmac.compare_digest(cookie.value, portal.console_cookie))
            except Exception:
                return False

        def respond(self, code, value, page=False, headers=None):
            data = value.encode() if page else json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if page else 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-" + portal.nonce + "'; frame-ancestors 'none'; form-action 'self'")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)

        def proxy_browser(self):
            if not self.console_authorized() or (self.headers.get('Origin') and self.headers['Origin'] != self.origin()):
                return self.respond(403, {'message': '请先从本机管理页打开网页登录窗口'})
            url = urllib.parse.urlsplit(self.path)
            if url.scheme or url.netloc:
                return self.respond(400, {'message': '无效的浏览器请求'})
            path = url.path.removeprefix('/browser') if url.path.startswith('/browser/') else url.path
            path = (path or '/') + ('?' + url.query if url.query else '')
            upgrade = self.headers.get('Upgrade', '').lower() == 'websocket'
            channel = None
            sent = False
            try:
                channel = portal.ssh.browser_channel()
                lines = [self.command + ' ' + path + ' HTTP/1.1']
                for name, value in self.headers.items():
                    if name.lower() not in ['cookie', 'connection', 'proxy-authorization']:
                        lines.append(name + ': ' + value)
                lines.append('Connection: ' + ('Upgrade' if upgrade else 'close'))
                channel.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1'))
                buffer = bytearray()
                while b'\r\n\r\n' not in buffer:
                    data = channel.recv(4096)
                    if not data or len(buffer) > 65536:
                        raise RuntimeError('Browser HTTP failed')
                    buffer.extend(data)
                end = buffer.index(b'\r\n\r\n')
                header, rest = bytes(buffer[:end]), bytes(buffer[end + 4:])
                self.connection.sendall(header + b'\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: SAMEORIGIN\r\n\r\n' + rest)
                sent = True
                self.close_connection = True
                if upgrade:
                    def upload():
                        try:
                            while True:
                                data = self.connection.recv(65536)
                                if not data:
                                    break
                                channel.sendall(data)
                        except OSError:
                            pass
                        finally:
                            channel.close()
                    threading.Thread(target=upload, daemon=True).start()
                while True:
                    data = channel.recv(65536)
                    if not data:
                        break
                    self.connection.sendall(data)
            except Exception:
                if not sent:
                    self.respond(502, {'message': '专用浏览器尚未就绪，请稍后重试'})
            finally:
                if channel:
                    channel.close()

        def do_GET(self):
            if not self.valid_host():
                return self.respond(403, {'message': '仅限本机访问'})
            if self.path == '/setup' or (self.path == '/' and not self.console_authorized()):
                server = html.escape(portal.ssh.config['host'])
                page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gemini 浏览器登录</title>
                <style>body{font:16px system-ui;max-width:760px;margin:48px auto;padding:0 24px;background:#f5f7fc;color:#202532}main{background:white;padding:30px;border:1px solid #dce2ed;border-radius:18px}h1{font-size:26px}p,li{line-height:1.8}button{font:inherit;background:#345fd3;color:white;border:0;border-radius:9px;padding:13px 20px;cursor:pointer}#status{padding:16px;background:#eef3fd;border-radius:10px}small{color:#526076}</style>
                <main><h1>Gemini 浏览器登录</h1><p>专用浏览器部署在你的服务器 SERVER 上。登录后会自动保存网页会话，并接入 Magpie 的统一视频 API。</p>
                <ol><li>打开下方登录窗口。</li><li>只登录要使用的 Gemini Pro 账号，并完成 Google 要求的二次验证或首次设置。</li><li>回到此页面查看“会话已自动保存”。无需复制 Cookie。</li></ol>
                <form method="post" action="/open-browser"><input type="hidden" name="csrf" value="NONCE"><button type="submit">打开网页登录窗口</button></form>
                <p id="status">正在检查服务器浏览器…</p><p><small>Google 密码和二次验证由你直接在专用浏览器中输入。登录窗口经 SSH 加密隧道连接，浏览器配置与会话保存在服务器。会话失效时需要重新登录。</small></p></main>
                <script nonce="NONCE">async function refresh(){try{const r=await fetch('/status',{headers:{'X-Portal-Nonce':'NONCE'}});const s=await r.json();document.getElementById('status').textContent=s.message}catch{document.getElementById('status').textContent='管理连接暂不可用，请稍后重试。'}}refresh();setInterval(refresh,5000);</script></html>'''.replace('NONCE', portal.nonce).replace('SERVER', server)
                return self.respond(200, page, page=True)
            if self.path == '/status':
                if not hmac.compare_digest(self.headers.get('X-Portal-Nonce', ''), portal.nonce):
                    return self.respond(403, {'message': '需要本机管理会话'})
                with portal.lock:
                    return self.respond(200, dict(portal.state))
            return self.proxy_browser()

        def do_POST(self):
            # Native webviews may omit Origin on a form navigation. The unguessable
            # form token is still mandatory; an explicit foreign Origin is refused.
            if not self.valid_host() or self.path != '/open-browser' or self.headers.get('Origin') not in [None, 'null', self.origin()]:
                return self.respond(403, {'message': '请求来源无效'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 1024:
                    raise ValueError()
                data = urllib.parse.parse_qs(self.rfile.read(length).decode())
                if not hmac.compare_digest((data.get('csrf') or [''])[0], portal.nonce):
                    raise ValueError()
            except Exception:
                return self.respond(403, {'message': '本机管理会话无效'})
            return self.respond(303, {}, headers={'Set-Cookie': 'gemini_console=' + portal.console_cookie + '; HttpOnly; SameSite=Strict; Path=/', 'Location': '/browser/'})
    return Handler


def main():
    parser = argparse.ArgumentParser(description='Open the dedicated Gemini browser over SSH')
    parser.add_argument('--host')
    parser.add_argument('--user', default='root')
    parser.add_argument('--known-hosts')
    parser.add_argument('--port', type=int, default=58627)
    parser.add_argument('--setup-dir', default=str(pathlib.Path.home() / '.cache/magpie-gemini-login'))
    parser.add_argument('--after-authorize', default='')
    parser.add_argument('--connection-stdin', action='store_true')
    args = parser.parse_args()
    config = json.loads(sys.stdin.readline().lstrip('\ufeff')) if args.connection_stdin else {'host': args.host, 'user': args.user, 'known_hosts': args.known_hosts, 'password': getpass.getpass('SSH password (leave empty to use SSH keys): ')}
    if not config.get('host'):
        parser.error('--host is required')
    ssh = SSH(config)
    ssh.connection()  # Fail before opening the portal if the pinned SSH identity doesn't match.
    portal = Portal(ssh, args.setup_dir, args.after_authorize)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(portal))
    server.daemon_threads = True
    worker = threading.Thread(target=portal.poll, daemon=True)
    worker.start()
    (portal.root / 'launch.json').write_text(json.dumps({'url': 'http://127.0.0.1:' + str(server.server_port) + '/setup', 'port': server.server_port, 'pid': os.getpid()}), encoding='utf-8')
    try:
        server.serve_forever()
    finally:
        portal.stop.set()
        if ssh.client:
            ssh.client.close()


if __name__ == '__main__':
    main()
