import http.client
import importlib.util
import json
import pathlib
import socket
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

file = pathlib.Path(__file__).parents[1] / 'server/gemini-video/login_portal.py'
spec = importlib.util.spec_from_file_location('portal_under_test', file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Upstream(BaseHTTPRequestHandler):
    rbufsize = 0
    def log_message(self, *_):
        pass
    def do_GET(self):
        self.server.last_path = self.path
        self.server.last_cookie = self.headers.get('Cookie')
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.end_headers()
            data = self.connection.recv(100)
            self.connection.sendall(data)
        else:
            data = b'fixture-browser-interface'
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='magpie-login-portal-test-')
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.upstream.daemon_threads = True
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        owner = self
        class SSH:
            config = {'host': 'server.example', 'password': 'fake-private-ssh-password'}
            calls = 0
            def browser_channel(self):
                self.calls += 1
                return socket.create_connection(('127.0.0.1', owner.upstream.server_port), timeout=5)
        self.ssh = SSH()
        self.portal = module.Portal(self.ssh, self.temp.name)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), module.handler(self.portal))
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        for server in [self.server, self.upstream]:
            server.shutdown(); server.server_close()
        self.temp.cleanup()

    def call(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def cookie(self):
        body = urllib.parse.urlencode({'csrf': self.portal.nonce})
        status, headers, data = self.call('POST', '/open-browser', body, {'Origin': self.origin, 'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/browser/')
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        return headers['Set-Cookie'].split(';')[0]

    def test_requires_csrf_and_same_origin_without_exposing_root_credentials(self):
        status, headers, data = self.call('GET', '/setup')
        self.assertEqual(status, 200)
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertNotIn(b'fake-private-ssh-password', data)
        self.assertEqual(self.call('GET', '/browser/')[0], 403)
        self.assertEqual(self.call('GET', '/status')[0], 403)
        self.assertEqual(self.call('POST', '/open-browser', 'csrf=wrong', {'Origin': self.origin})[0], 403)
        self.assertEqual(self.call('POST', '/open-browser', 'csrf=' + self.portal.nonce, {'Origin': 'https://untrusted.example'})[0], 403)
        self.assertEqual(self.call('GET', '/setup', headers={'Host': 'untrusted.example'})[0], 403)
        self.assertEqual(self.ssh.calls, 0)

    def test_native_webview_form_without_origin_still_requires_the_private_form_token(self):
        body = urllib.parse.urlencode({'csrf': self.portal.nonce})
        self.assertEqual(self.call('POST', '/open-browser', body)[0], 303)
        self.assertEqual(self.call('POST', '/open-browser', 'csrf=wrong')[0], 403)

    def test_browser_proxy_removes_management_cookie_and_strips_only_its_prefix(self):
        cookie = self.cookie()
        status, headers, data = self.call('GET', '/browser/assets/browser.js?fixture=1', headers={'Cookie': cookie})
        self.assertEqual(status, 200)
        self.assertEqual(data, b'fixture-browser-interface')
        self.assertEqual(self.upstream.last_path, '/assets/browser.js?fixture=1')
        self.assertIsNone(self.upstream.last_cookie)
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(self.call('GET', '/browser/', headers={'Cookie': cookie, 'Origin': 'https://untrusted.example'})[0], 403)

    def test_websocket_transport_is_bidirectional_after_authenticated_handshake(self):
        cookie = self.cookie()
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=5) as client:
            request = f'GET /browser/ws HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\nOrigin: {self.origin}\r\nCookie: {cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
            client.sendall(request.encode())
            header = b''
            while b'\r\n\r\n' not in header:
                header += client.recv(1024)
            self.assertIn(b'101', header.split(b'\r\n')[0])
            client.sendall(b'fixture-websocket-payload')
            self.assertEqual(client.recv(100), b'fixture-websocket-payload')


if __name__ == '__main__':
    unittest.main()
