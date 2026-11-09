import asyncio
import base64
import contextlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from test_gemini_video import FakeClient, MP4, module as bridge_module

path = pathlib.Path(__file__).parents[1] / 'server/gemini-video/browser_session.py'
spec = importlib.util.spec_from_file_location('browser_session_under_test', path)
browser_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser_module)


class FakeCDP:
    def __init__(self):
        self.calls = []
        self.cookies = [
            {'name': '__Secure-1PSID', 'value': 'fake-browser-session', 'domain': '.google.com', 'path': '/'},
            {'name': '__Secure-1PSIDTS', 'value': 'fake-browser-ts', 'domain': '.google.com', 'path': '/'},
            {'name': 'unrelated-cookie', 'value': 'never-retain-me', 'domain': '.google.com', 'path': '/'},
            {'name': '__Secure-1PSID', 'value': 'foreign-cookie', 'domain': '.google.com.evil.example', 'path': '/'},
        ]
        self.data = [MP4[:10], MP4[10:]]

    async def call(self, method, params=None, session=None, timeout=30):
        self.calls.append((method, params))
        if method == 'Network.getCookies':
            return {'cookies': self.cookies}
        if method == 'Target.createTarget':
            return {'targetId': 'ephemeral-test-tab'}
        if method == 'Target.attachToTarget':
            return {'sessionId': 'test-session'}
        if method == 'Runtime.evaluate':
            if params['expression'] == '({url:location.href,ready:!!document.body})':
                return {'result': {'value': {'url': 'https://gemini.google.com/u/0/app/test', 'ready': True}}}
            return {'result': {'objectId': 'opaque-video-reader'}}
        if method == 'Runtime.callFunctionOn':
            item = {'done': False, 'data': base64.b64encode(self.data.pop(0)).decode()} if self.data else {'done': True}
            return {'result': {'value': item}}
        return {}


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_owns_cookie_refresh_while_legacy_session_mode_can_refresh_itself(self):
        options = []
        class Client:
            def __init__(self, *_args, **_kwargs):
                pass
            async def init(self, **kwargs):
                options.append(kwargs)
            async def close(self):
                pass
        fake_modules = {'gemini_webapi': types.SimpleNamespace(GeminiClient=Client), 'loguru': types.SimpleNamespace(logger=types.SimpleNamespace(remove=lambda: None))}
        with patch.dict(sys.modules, fake_modules):
            with patch.dict(os.environ, {'GEMINI_BROWSER_CDP': 'http://managed-browser:9222'}):
                await bridge_module.new_client({'__Secure-1PSID': 'fake-session'})
            with patch.dict(os.environ, {'GEMINI_BROWSER_CDP': ''}):
                await bridge_module.new_client({'__Secure-1PSID': 'fake-session'})
        self.assertFalse(options[0]['auto_refresh'])
        self.assertTrue(options[1]['auto_refresh'])

    def fixture(self):
        browser = browser_module.BrowserSession('http://127.0.0.1:9222')
        cdp = FakeCDP()
        def metadata(path):
            if path == '/json/list':
                return [
                    {'type': 'page', 'url': 'https://unrelated.example/', 'webSocketDebuggerUrl': 'unused'},
                    {'type': 'page', 'url': 'https://gemini.google.com/app', 'webSocketDebuggerUrl': 'test-socket'},
                ]
            return {'webSocketDebuggerUrl': 'browser-socket'}
        @contextlib.asynccontextmanager
        async def connection(_url):
            yield cdp
        browser._json = metadata
        browser.connection = connection
        return browser, cdp

    async def test_retains_only_gemini_cookies_without_exposing_them_in_status(self):
        browser, cdp = self.fixture()
        account = await browser.account()
        self.assertEqual(account, {'__Secure-1PSID': 'fake-browser-session', '__Secure-1PSIDTS': 'fake-browser-ts'})
        self.assertEqual(cdp.calls, [('Network.getCookies', {'urls': ['https://gemini.google.com/']})])
        self.assertNotIn('fake-browser-session', json.dumps(browser.status()))
        self.assertNotIn('never-retain-me', json.dumps(account))

    async def test_requires_a_gemini_app_page_and_does_not_use_other_google_accounts(self):
        browser, cdp = self.fixture()
        browser._json = lambda _path: [{'type': 'page', 'url': 'https://gemini.google.com/u/1/app', 'webSocketDebuggerUrl': 'wrong-account'}]
        self.assertIsNone(await browser.account())
        self.assertEqual(cdp.calls, [])
        self.assertEqual(browser.state, 'needs_login')

    async def test_download_streams_into_one_job_file_and_closes_ephemeral_tab(self):
        browser, cdp = self.fixture()
        with tempfile.TemporaryDirectory(prefix='magpie-browser-download-test-') as root:
            output = pathlib.Path(root) / 'output.mp4'
            await browser.download(types.SimpleNamespace(url='https://media.usercontent.google.com/download?fixture=1', cid='c_test'), output)
            self.assertEqual(output.read_bytes(), MP4)
            self.assertEqual(cdp.calls[-1], ('Target.closeTarget', {'targetId': 'ephemeral-test-tab'}))
            self.assertFalse(output.with_suffix('.download').exists())

    async def test_browser_download_waits_for_rendering_then_streams_bounded_chunks(self):
        browser, cdp = self.fixture()
        with tempfile.TemporaryDirectory(prefix='magpie-browser-render-test-') as root:
            await browser.download(types.SimpleNamespace(url='https://media.usercontent.google.com/download'), pathlib.Path(root) / 'output.mp4')
        expression = next(params['expression'] for method, params in cdp.calls if method == 'Runtime.evaluate' and params.get('awaitPromise'))
        # Execute the app's download routine with a fake transport, not a browser.
        program = '''const fs=require('fs');const expression=JSON.parse(fs.readFileSync(0,'utf8'));let requests=0,chunkSent=false;global.setTimeout=fn=>{fn();return 0};
        global.fetch=async()=>{requests++;return {status:requests===1?206:200,headers:{get:n=>n==='content-type'?'video/mp4':'300000'},body:{cancel:async()=>{},getReader:()=>({read:async()=>chunkSent?{done:true}:(chunkSent=true,{done:false,value:new Uint8Array(300000).fill(7)})})}}};
        (async()=>{const reader=await eval(expression);let count=0,max=0;for(;;){const part=await reader.read();if(part.done)break;const n=Buffer.from(part.data,'base64').length;count+=n;max=Math.max(max,n)}process.stdout.write(JSON.stringify({requests,count,max}))})().catch(()=>process.exit(1));'''
        result = await asyncio.to_thread(subprocess.run, ['node', '-e', program], input=json.dumps(expression), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'requests': 2, 'count': 300000, 'max': 131072})

    async def test_rejects_foreign_urls_and_html_instead_of_reporting_download_success(self):
        browser, cdp = self.fixture()
        with tempfile.TemporaryDirectory(prefix='magpie-browser-invalid-test-') as root:
            output = pathlib.Path(root) / 'output.mp4'
            for url in ['http://127.0.0.1/private', 'https://googleusercontent.com.evil.example/video', 'file:///private', 'https://googleusercontent.com:8443/video']:
                with self.assertRaises(ValueError):
                    await browser.download(types.SimpleNamespace(url=url), output)
            self.assertEqual(cdp.calls, [])
            cdp.data = [b'<html>sign in</html>']
            with self.assertRaises(ValueError):
                await browser.download(types.SimpleNamespace(url='https://media.usercontent.google.com/video'), output)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix('.download').exists())
            self.assertEqual(cdp.calls[-1][0], 'Target.closeTarget')

    async def test_cdp_commands_handle_events_without_consuming_them_as_replies(self):
        class Socket:
            async def send(self, text):
                self.sent = json.loads(text)
            async def recv(self):
                if not hasattr(self, 'event_sent'):
                    self.event_sent = True
                    return '{"method":"Page.loadEventFired"}'
                return json.dumps({'id': self.sent['id'], 'result': {'ok': True}})
        self.assertEqual(await browser_module.CDP(Socket()).call('fixture'), {'ok': True})


class ManagedBrowser:
    def __init__(self):
        self.value = None
        self.state = 'needs_login'
        self.saved = False

    async def account(self):
        return dict(self.value) if self.value else None

    def status(self):
        return {'enabled': True, 'state': self.state, 'sessionSaved': self.saved}

    async def download(self, video, output):
        output.write_bytes(MP4)


class AutomaticSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='magpie-browser-session-test-')
        self.browser = ManagedBrowser()
        self.calls = 0
        self.client = FakeClient()
        class Jar:
            def __init__(self):
                self.data = {}
            def set(self, name, value, **_kwargs):
                self.data[name] = value
        self.client.cookies = Jar()
        async def factory(account):
            self.calls += 1
            if account.get('__Secure-1PSID') == 'invalid-session':
                raise ValueError('bad session')
            return self.client
        self.bridge = bridge_module.Bridge(self.temp.name, factory, self.browser)
        self.bridge.submit(self.bridge.sync_browser()).result(5)

    def tearDown(self):
        self.bridge.close()
        self.temp.cleanup()

    def sync(self):
        self.bridge.submit(self.bridge.sync_browser()).result(5)

    def test_login_saves_and_refreshes_session_without_repeating_login_or_exposing_values(self):
        self.assertEqual(self.calls, 0)
        self.browser.value = {'__Secure-1PSID': 'fake-managed-session', '__Secure-1PSIDTS': 'first-ts'}
        self.sync()
        self.assertEqual(self.bridge.state, 'ready')
        self.assertTrue(self.browser.saved)
        self.assertEqual(self.calls, 1)
        self.sync()
        self.assertEqual(self.calls, 1)
        self.browser.value['__Secure-1PSIDTS'] = 'updated-ts'
        self.sync()
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.client.cookies.data['__Secure-1PSIDTS'], 'updated-ts')
        stored = json.loads((pathlib.Path(self.temp.name) / 'account.json').read_text())
        self.assertEqual(stored['__Secure-1PSIDTS'], 'updated-ts')
        self.assertNotIn('fake-managed-session', json.dumps(self.bridge.status()))

    def test_logout_blocks_new_jobs_and_invalid_session_checks_have_backoff(self):
        self.browser.value = {'__Secure-1PSID': 'invalid-session', '__Secure-1PSIDTS': ''}
        self.sync(); self.sync()
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.bridge.state, 'needs_login')
        self.browser.value = {'__Secure-1PSID': 'fake-managed-session', '__Secure-1PSIDTS': ''}
        self.sync()
        self.assertEqual(self.bridge.state, 'ready')
        self.browser.value = None
        self.sync()
        with self.assertRaises(ValueError):
            self.bridge.create({'prompt': 'test'})


if __name__ == '__main__':
    unittest.main()
