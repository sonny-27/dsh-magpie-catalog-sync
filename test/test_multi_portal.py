import http.client
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'server/gemini-video'))
from multi_login_portal import Manager, manager_handler


class SSH:
    config = {'host': 'server.example'}
    lock = threading.RLock()
    def execute(self, command, input_data=None):
        return '{}'


class MultiPortalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='magpie-multi-portal-test-')
        self.manager = Manager(SSH(), self.temp.name)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), manager_handler(self.manager))
        self.server.daemon_threads = True
        self.manager.url = f'http://127.0.0.1:{self.server.server_port}/setup'
        self.manager.update({'state': 'needs_login', 'accounts': [
            {'id':'primary','name':'账号1','enabled':True,'state':'needs_login'},
            {'id':'a12345678','name':'账号2','enabled':True,'state':'needs_login'},
        ],'strategy':'priority','defaultAccount':'primary','maxAccounts':5,'readyAccounts':0})
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close()
        for server, _portal in self.manager.viewers.values():
            server.shutdown();server.server_close()
        self.temp.cleanup()
    def call(self, port, method, path, body=None, headers=None):
        client = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        client.request(method,path,body=body,headers=headers or {})
        response=client.getresponse();result=response.status,dict(response.getheaders()),response.read();client.close();return result
    def open(self, identity):
        body=urllib.parse.urlencode({'id':identity,'csrf':self.manager.nonce})
        return self.call(self.server.server_port,'POST','/accounts/open',body,{'Content-Type':'application/x-www-form-urlencoded'})

    def test_each_account_has_a_different_viewer_and_cookie_and_cannot_use_the_other_session(self):
        first=self.open('primary');second=self.open('a12345678')
        self.assertEqual([first[0],second[0]],[303,303])
        first_url=urllib.parse.urlsplit(first[1]['Location']);second_url=urllib.parse.urlsplit(second[1]['Location'])
        self.assertNotEqual(first_url.port,second_url.port)
        first_cookie=first[1]['Set-Cookie'].split(';')[0];second_cookie=second[1]['Set-Cookie'].split(';')[0]
        self.assertNotEqual(first_cookie.split('=')[0],second_cookie.split('=')[0])
        self.assertEqual(self.call(first_url.port,'GET','/console',headers={'Cookie':second_cookie})[0],403)
        status, _headers, body=self.call(first_url.port,'GET','/console',headers={'Cookie':first_cookie})
        self.assertEqual(status,200);self.assertIn('账号1'.encode(),body)
        self.assertEqual(self.manager.viewers['primary'][1].ssh.config['browser_container'],'magpie-gemini-browser')
        self.assertEqual(self.manager.viewers['a12345678'][1].ssh.config['browser_container'],'magpie-gemini-browser-a12345678')

    def test_account_opening_requires_a_valid_private_form_token(self):
        self.assertEqual(self.open('../private')[0],400)
        body=urllib.parse.urlencode({'id':'primary','csrf':'wrong'})
        self.assertEqual(self.call(self.server.server_port,'POST','/accounts/open',body,{'Content-Type':'application/x-www-form-urlencoded'})[0],403)
        self.assertEqual(self.call(self.server.server_port,'GET','/status')[0],403)
        self.assertEqual(self.manager.viewers,{})

    def test_script_handoff_sets_cookie_without_cross_origin_form_redirect(self):
        status,headers,data=self.call(self.server.server_port,'POST','/accounts/open',json.dumps({'id':'primary'}),{'Content-Type':'application/json','X-Portal-Nonce':self.manager.nonce})
        self.assertEqual(status,200)
        self.assertIn('gemini_console_primary=',headers['Set-Cookie'])
        self.assertEqual(urllib.parse.urlsplit(json.loads(data)['url']).path,'/console')


if __name__ == '__main__':
    unittest.main()
