import asyncio
import base64
import importlib.util
import json
import pathlib
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('gemini_video_bridge', pathlib.Path(__file__).parents[1] / 'server/gemini-video/bridge.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MP4 = b'\x00\x00\x00\x18ftypmp42test-video-bytes'
IMAGE = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()


class FakeClient:
    def __init__(self):
        self.calls = 0
        self.files = []
        self.fail = False
        self.no_video = False
        self.bad_file = False

    async def close(self):
        pass

    async def generate_content(self, prompt, files=None):
        self.calls += 1
        self.files = [pathlib.Path(file).read_bytes() for file in files or []]
        owner = self
        class Video:
            async def save(self, path, filename, verbose=False):
                if owner.fail:
                    raise RuntimeError('HTTP 403 [private download URL]')
                file = pathlib.Path(path) / filename
                file.write_bytes(b'<html>login</html>' if owner.bad_file else MP4)
                return {'video': str(file)}
        return SimpleNamespace(videos=[] if self.no_video else [Video()], media=[])


class VideoBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='magpie-video-test-')
        self.client = FakeClient()
        async def factory(account):
            if account.get('__Secure-1PSID') != 'fake-session-value':
                raise RuntimeError('private-cookie-value')
            return self.client
        self.factory = factory
        self.bridge = module.Bridge(self.temp.name, factory)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), module.handler(self.bridge))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.bridge.close()
        self.temp.cleanup()

    def request(self, path, body=None, key=None, origin=None):
        headers = {'Authorization': 'Bearer ' + (key or self.bridge.api_key), 'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            return response.status, json.loads(data) if 'json' in response.headers.get('Content-Type', '') else data

    def login(self):
        status, result = self.request('/admin/session', {'__Secure-1PSID': 'fake-session-value'}, self.bridge.admin_key)
        self.assertEqual(status, 200)
        self.assertEqual(result['state'], 'ready')

    def finish(self, job):
        for _ in range(100):
            value = self.bridge.get(job['id'])
            if value['status'] in ['completed', 'failed']:
                return value
            time.sleep(.01)
        self.fail('Video did not finish')

    def test_needs_login_and_separate_admin_authorization(self):
        self.assertEqual(self.bridge.status()['state'], 'needs_login')
        self.assertEqual(self.request('/v1/models')[1]['data'], [])
        self.assertEqual(self.request('/admin/session', {'__Secure-1PSID': 'fake-session-value'})[0], 401)
        self.assertEqual(self.request('/v1/models', key='not-the-key')[0], 401)
        self.assertEqual(self.request('/v1/models', origin='https://untrusted.example')[0], 401)
        self.assertEqual(self.request('/v1/videos', {'prompt': 'test'})[0], 400)

    def test_login_validation_does_not_replace_good_session(self):
        self.login()
        before = (pathlib.Path(self.temp.name) / 'account.json').read_bytes()
        self.assertEqual(self.request('/admin/session', {'__Secure-1PSID': 'invalid'}, self.bridge.admin_key)[0], 400)
        self.assertEqual((pathlib.Path(self.temp.name) / 'account.json').read_bytes(), before)
        self.assertEqual(self.bridge.state, 'ready')

    def test_two_references_single_submission_poll_and_authenticated_download(self):
        self.login()
        self.assertEqual(self.request('/v1/models')[1]['data'][0]['kind'], 'video')
        status, job = self.request('/v1/videos', {'model': module.MODEL, 'prompt': 'move softly', 'input_reference': {'image_url': IMAGE}, 'reference_images': [{'image_url': IMAGE}]})
        self.assertEqual(status, 200)
        self.assertEqual(self.finish(job)['status'], 'completed')
        for _ in range(3):
            self.assertEqual(self.request('/v1/videos/' + job['id'])[0], 200)
        self.assertEqual(self.client.calls, 1)
        self.assertEqual(len(self.client.files), 2)
        self.assertEqual(self.request('/v1/videos/' + job['id'] + '/content')[1], MP4)
        self.assertEqual(self.request('/v1/videos/' + job['id'] + '/content', key='wrong')[0], 401)
        self.assertFalse(list((pathlib.Path(self.temp.name) / job['id']).glob('reference-*')))
        stored = (pathlib.Path(self.temp.name) / job['id'] / 'job.json').read_text()
        self.assertNotIn('move softly', stored)
        self.assertNotIn('fake-session-value', stored)

    def test_rejects_remote_local_and_oversized_reference_inputs(self):
        for value in ['http://127.0.0.1/private', 'file:///etc/passwd', '/etc/passwd', 'data:text/plain;base64,YQ==']:
            with self.assertRaises(ValueError):
                module.validate({'prompt': 'video', 'reference_images': [value]})
        with self.assertRaises(ValueError):
            module.validate({'prompt': 'video', 'reference_images': [IMAGE] * 6})
        with self.assertRaises(ValueError):
            module.validate({'prompt': 'video', 'seconds': 1.5})
        with self.assertRaises(ValueError):
            module.validate({'prompt': 'video', 'model': 'a-chat-model'})

    def test_no_video_or_bad_download_never_becomes_success(self):
        self.login()
        for field in ['no_video', 'fail', 'bad_file']:
            setattr(self.client, field, True)
            job = self.bridge.create({'prompt': 'test'})
            value = self.finish(job)
            self.assertEqual(value['status'], 'failed')
            self.assertNotIn('private download URL', json.dumps(value))
            self.assertFalse((pathlib.Path(self.temp.name) / job['id'] / 'output.mp4').exists())
            setattr(self.client, field, False)

    def test_completed_jobs_survive_restart_and_expired_files_are_removed(self):
        self.login()
        job = self.bridge.create({'prompt': 'test'})
        self.assertEqual(self.finish(job)['status'], 'completed')
        self.bridge.close()
        self.bridge = module.Bridge(self.temp.name, self.factory)
        self.assertEqual(self.bridge.get(job['id'])['status'], 'completed')
        self.bridge.jobs[job['id']]['expires_at'] = 0
        self.bridge.cleanup()
        self.assertIsNone(self.bridge.get(job['id']))
        self.assertFalse((pathlib.Path(self.temp.name) / job['id']).exists())
        self.assertEqual(self.client.calls, 1)


if __name__ == '__main__':
    unittest.main()
