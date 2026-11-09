"""Local multi-account console. Each viewer is fixed to one isolated browser."""
import argparse
import getpass
import hmac
import html
import json
import os
import pathlib
import re
import shlex
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from login_portal import Portal, SSH, handler as console_handler

ACCOUNT = re.compile(r'(?:primary|a[0-9a-f]{8})')


class AccountSSH:
    """Reuse the pinned SSH transport, not another account's browser target."""
    browser_channel = SSH.browser_channel
    def __init__(self, ssh, identity):
        self.parent = ssh
        self.config = dict(ssh.config, browser_container='magpie-gemini-browser' + ('' if identity == 'primary' else '-' + identity))
        self.lock = ssh.lock
        self.browser_target = None
    def connection(self):
        return self.parent.connection()
    def execute(self, command):
        return self.parent.execute(command)


class Manager(Portal):
    def __init__(self, ssh, setup_dir, after_authorize='', provision_command=''):
        super().__init__(ssh, setup_dir, after_authorize)
        self.provision_command = provision_command
        self.viewers = {}
        self.action_lock = threading.Lock()
        self.url = None

    def update(self, data, activated=False):
        states = {'ready': '网页会话已自动保存。新任务会按所选策略分配，已提交任务继续使用原账号。',
                  'paused': '所有账号均已停用新任务。已有任务仍可查询和下载，启用账号后恢复接收新任务。',
                  'authorizing': '正在验证已检测到的网页登录会话…',
                  'needs_login': '账号管理已就绪。你可以稍后分别登录，各账号会自动保存会话。'}
        safe = {name: data.get(name) for name in ['state', 'accounts', 'strategy', 'defaultAccount', 'maxAccounts', 'readyAccounts']}
        safe.update(message=states.get(data.get('state'), '正在连接多账号服务…'), magpieEnabled=activated)
        with self.lock:
            self.state = safe
        (self.root / 'status.json').write_text(json.dumps(safe, ensure_ascii=False), encoding='utf-8')

    def poll(self):
        activated = False
        while not self.stop.is_set():
            try:
                data = json.loads(self.ssh.execute('docker exec magpie-gemini-video python /app/manage.py accounts-list'))
                if data.get('state') == 'ready' and not activated:
                    if self.after_authorize:
                        result = self.ssh.execute(self.after_authorize)
                        activated = any(json.loads(line).get('registered') for line in result.splitlines() if line.startswith('{'))
                    else:
                        activated = True
                self.update(data, activated)
            except Exception:
                with self.lock:
                    self.state = {'state': 'unavailable', 'message': '多账号服务暂未连接，请稍后刷新。', 'accounts': [], 'magpieEnabled': activated}
            self.stop.wait(5)

    def provision(self, identity):
        if not ACCOUNT.fullmatch(identity):
            raise ValueError('Invalid account')
        if self.provision_command:
            command = self.provision_command.replace('{account}', shlex.quote(identity))
            result = self.ssh.execute(command)
            if not any(json.loads(line).get('provisioned') for line in result.splitlines() if line.startswith('{')):
                raise RuntimeError('Browser was not provisioned')

    def mutate(self, operation, body):
        commands = {'add': 'accounts-add', 'update': 'accounts-update', 'settings': 'accounts-settings'}
        if operation not in commands:
            raise ValueError('Unknown account action')
        with self.action_lock:
            result = json.loads(self.ssh.execute('docker exec -i magpie-gemini-video python /app/manage.py ' + commands[operation], body))
            if 'error' in result:
                raise ValueError('账号设置未完成')
            self.update(result, self.state.get('magpieEnabled', False))
            if operation == 'add':
                identity = result.get('createdAccount', '')
                try:
                    self.provision(identity)
                except Exception:
                    return {'message': '账号已添加，但浏览器尚未启动。点击该账号的“启动/重试”即可继续。', 'account': identity}
            return {'message': '账号设置已保存。'}

    def viewer(self, identity):
        with self.action_lock:
            rows = self.state.get('accounts') or []
            row = next((row for row in rows if row['id'] == identity), None)
            if not row or not ACCOUNT.fullmatch(identity):
                raise ValueError('Unknown account')
            if identity not in self.viewers:
                portal = Portal(AccountSSH(self.ssh, identity), self.root / 'viewers' / identity)
                portal.cookie_name = 'gemini_console_' + identity
                parent_handler = console_handler(portal)
                owner = self
                label = row['name']
                class Viewer(parent_handler):
                    def do_GET(self):
                        if self.path == '/console':
                            if not self.valid_host() or not self.console_authorized():
                                return self.respond(403, {'message': '请从账号管理页打开此窗口'})
                            current = next((row['name'] for row in owner.state.get('accounts', []) if row['id'] == identity), label)
                            page = '<!doctype html><meta charset="utf-8"><title>' + html.escape(current) + ' · Gemini 登录</title><style>body{margin:0;font:14px system-ui;background:#eef2f9}header{box-sizing:border-box;height:42px;padding:10px 18px;display:flex;justify-content:space-between}iframe{width:100%;height:calc(100vh - 42px);border:0}</style><header><b>' + html.escape(current) + ' · 独立登录窗口</b><a href="' + html.escape(owner.url) + '" target="_blank" rel="noreferrer">账号管理</a></header><iframe title="专用账号浏览器" src="/browser/"></iframe>'
                            return self.respond(200, page, page=True)
                        if self.path == '/setup':
                            return self.respond(303, {}, headers={'Location': owner.url})
                        return super().do_GET()
                server = ThreadingHTTPServer(('127.0.0.1', 0), Viewer)
                server.daemon_threads = True
                threading.Thread(target=server.serve_forever, daemon=True).start()
                self.viewers[identity] = (server, portal)
            return self.viewers[identity]


PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gemini 多账号管理</title>
<style>body{font:15px system-ui;max-width:940px;margin:34px auto;padding:0 24px;background:#f5f7fc;color:#202532}main{background:white;padding:28px;border:1px solid #dce2ed;border-radius:18px}h1{font-size:25px}p{line-height:1.7}button,input,select{font:inherit;border-radius:7px;padding:9px 12px;border:1px solid #c9d2e2}button{cursor:pointer;background:#f8faff}button.primary{background:#345fd3;color:white;border-color:#345fd3}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:13px 0}.card{border:1px solid #dce2ed;border-radius:11px;padding:15px;margin:12px 0}.grow{flex:1}#message,#status{padding:13px;background:#eef3fd;border-radius:9px}small{color:#536177}form{margin:0}</style>
<main><h1>Gemini 多账号管理</h1><p>每个账号使用独立的服务器浏览器和持久化目录。分别登录后自动保存会话，客户端共用 Magpie 的一个视频模型与 API 入口。</p>
<p id="status">正在连接多账号服务…</p><div class="row"><label>新任务分配 <select id="strategy"><option value="priority">优先默认账号，可用账号备用</option><option value="round_robin">在可用账号间轮询</option></select></label><button id="save-strategy">保存策略</button><small id="count"></small></div>
<form id="add" class="row"><input id="new-name" placeholder="新账号名称（可留空）" maxlength="64"><button class="primary" id="add-button" type="submit">添加账号</button></form>
<div id="accounts"></div><p id="message" hidden></p><p><small>每个窗口固定登录一个 Google 账号，有任务运行时请勿在该窗口更换 Google 登录身份。切换默认账号或停用新任务不会重新生成已有任务。自动选择仅依据会话就绪和启用状态，不代表已探测到剩余视频额度；任务失败不会跨账号自动重提。你可以稍后再分别登录。</small></p></main>
<script nonce="NONCE">const nonce='NONCE';const $=id=>document.getElementById(id);let busy=false;
const el=(tag,text)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;return x};
async function action(path,body){if(busy)return false;busy=true;try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Portal-Nonce':nonce},body:JSON.stringify(body)});const s=await r.json();$('message').hidden=false;$('message').textContent=s.message;if(!r.ok)throw Error();await refresh();return true}catch{$('message').hidden=false;if(!$('message').textContent)$('message').textContent='操作未完成，请刷新后重试。';return false}finally{busy=false}}
function control(text,fn){const b=el('button',text);b.type='button';b.onclick=fn;return b}
async function refresh(){try{const r=await fetch('/status',{headers:{'X-Portal-Nonce':nonce}});const data=await r.json();$('status').textContent=data.message;$('count').textContent=`账号 ${data.accounts?.length||0}/${data.maxAccounts||5} · 会话就绪 ${data.readyAccounts||0}`;if(document.activeElement!==$('strategy'))$('strategy').value=data.strategy||'priority';$('add-button').disabled=(data.accounts?.length||0)>=(data.maxAccounts||5)||busy;
if($('accounts').contains(document.activeElement)&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))return;const box=$('accounts');box.replaceChildren();for(const row of data.accounts||[]){const card=el('section');card.className='card';const head=el('div');head.className='row';const title=el('strong',row.name+(row.isDefault?' · 默认':''));title.className='grow';head.append(title,el('span',row.enabled?({ready:'会话就绪',authorizing:'验证中',needs_login:'待登录'}[row.state]||row.state):'已停用'));card.append(head);
const line=el('div');line.className='row';const form=el('form');form.method='post';form.action='/accounts/open';for(const [name,value]of Object.entries({csrf:nonce,id:row.id})){const input=el('input');input.type='hidden';input.name=name;input.value=value;form.append(input)}const open=el('button','打开登录窗口');open.className='primary';open.type='submit';form.append(open);form.onsubmit=async e=>{e.preventDefault();open.disabled=true;try{const r=await fetch('/accounts/open',{method:'POST',headers:{'Content-Type':'application/json','X-Portal-Nonce':nonce},body:JSON.stringify({id:row.id})});const result=await r.json();if(!r.ok)throw Error();const url=new URL(result.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/console')throw Error();location.assign(url.href)}catch{$('message').hidden=false;$('message').textContent='窗口未能打开，请刷新后重试。';open.disabled=false}};line.append(form,control('启动/重试',()=>action('/accounts/start',{id:row.id})),control(row.enabled?'停用新任务':'启用账号',()=>action('/accounts/update',{id:row.id,enabled:!row.enabled})));if(!row.isDefault)line.append(control('设为默认',()=>action('/accounts/settings',{defaultAccount:row.id})));
const name=el('input');name.value=row.name;name.maxLength=64;name.setAttribute('aria-label',row.name+' 新名称');line.append(name,control('保存名称',()=>action('/accounts/update',{id:row.id,name:name.value})));card.append(line,el('small',`进行中/排队任务：${row.pendingJobs||0}；登录会话独立保存。`));box.append(card)}}catch{$('status').textContent='多账号服务暂不可用，请稍后刷新。'}}
$('add').onsubmit=async e=>{e.preventDefault();if(await action('/accounts/add',{name:$('new-name').value}))$('new-name').value=''};$('save-strategy').onclick=()=>action('/accounts/settings',{strategy:$('strategy').value});refresh();setInterval(refresh,5000);</script></html>'''


def manager_handler(manager):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def origin(self):
            return 'http://127.0.0.1:' + str(self.server.server_port)
        def valid_host(self):
            return self.headers.get('Host') == '127.0.0.1:' + str(self.server.server_port)
        def respond(self, code, value, page=False, headers=None):
            data = value.encode() if page else json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if page else 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-" + manager.nonce + "'; frame-ancestors 'none'; form-action 'self'")
            self.send_header('Content-Length', str(len(data)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if not self.valid_host():
                return self.respond(403, {'message': '仅限本机访问'})
            if self.path in ['/', '/setup', '/open-browser']:
                return self.respond(200, PAGE.replace('NONCE', manager.nonce), page=True)
            if self.path == '/status' and hmac.compare_digest(self.headers.get('X-Portal-Nonce', ''), manager.nonce):
                with manager.lock:
                    return self.respond(200, dict(manager.state))
            return self.respond(403, {'message': '需要本机管理会话'})
        def do_POST(self):
            if not self.valid_host() or self.headers.get('Origin') not in [None, 'null', self.origin()]:
                return self.respond(403, {'message': '请求来源无效'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 32768:
                    raise ValueError()
                raw = self.rfile.read(length).decode()
                form = self.path == '/accounts/open' and self.headers.get('Content-Type','').startswith('application/x-www-form-urlencoded')
                body = {key:values[0] for key,values in urllib.parse.parse_qs(raw).items()} if form else json.loads(raw)
                token = body.get('csrf', '') if form else self.headers.get('X-Portal-Nonce', '')
                if not hmac.compare_digest(token, manager.nonce):
                    return self.respond(403, {'message': '本机管理会话无效'})
                if self.path == '/accounts/open':
                    server, portal = manager.viewer(body.get('id', ''))
                    url = f'http://127.0.0.1:{server.server_port}/console'
                    headers = {'Set-Cookie': portal.cookie_name + '=' + portal.console_cookie + '; HttpOnly; SameSite=Strict; Path=/'}
                    if form:
                        headers['Location'] = url
                    return self.respond(303 if form else 200, {} if form else {'url':url}, headers=headers)
                if self.path == '/accounts/start':
                    identity = body.get('id', '')
                    if identity not in [row['id'] for row in manager.state.get('accounts', [])]:
                        raise ValueError()
                    with manager.action_lock:
                        manager.provision(identity)
                    return self.respond(200, {'message': '该账号的浏览器已请求启动。'})
                action = self.path.removeprefix('/accounts/')
                if self.path != '/accounts/' + action:
                    raise ValueError()
                return self.respond(200, manager.mutate(action, body))
            except Exception:
                return self.respond(400, {'message': '账号操作未完成，请检查名称、数量上限或服务器连接后重试。'})
    return Handler


def main():
    parser = argparse.ArgumentParser(description='Manage isolated Gemini browser accounts over SSH')
    parser.add_argument('--host');parser.add_argument('--user', default='root');parser.add_argument('--known-hosts')
    parser.add_argument('--port', type=int, default=58627)
    parser.add_argument('--setup-dir', default=str(pathlib.Path.home()/'.cache/magpie-gemini-login'))
    parser.add_argument('--after-authorize', default='')
    parser.add_argument('--provision-command', default='')
    parser.add_argument('--connection-stdin', action='store_true')
    args = parser.parse_args()
    config = json.loads(sys.stdin.readline().lstrip('\ufeff')) if args.connection_stdin else {'host':args.host,'user':args.user,'known_hosts':args.known_hosts,'password':getpass.getpass('SSH password (empty for keys): ')}
    if not config.get('host'):
        parser.error('--host is required')
    ssh = SSH(config);ssh.connection()
    manager = Manager(ssh,args.setup_dir,args.after_authorize,args.provision_command)
    server = ThreadingHTTPServer(('127.0.0.1',args.port),manager_handler(manager));server.daemon_threads=True
    manager.url = f'http://127.0.0.1:{server.server_port}/setup'
    threading.Thread(target=manager.poll,daemon=True).start()
    (manager.root/'launch.json').write_text(json.dumps({'url':manager.url,'port':server.server_port,'pid':os.getpid()}))
    try:
        server.serve_forever()
    finally:
        manager.stop.set()
        for child, _portal in manager.viewers.values():
            child.shutdown();child.server_close()
        if ssh.client:
            ssh.client.close()


if __name__ == '__main__':
    main()
