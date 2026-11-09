import importlib.util
import json
import http.client
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from test_gemini_video import FakeClient, MP4, module as bridge_module

source = pathlib.Path(__file__).parents[1] / 'server/gemini-video'
sys.path.insert(0, str(source))
from account_pool import AccountPool


class Browser:
    def __init__(self, endpoint):
        self.endpoint = endpoint
        self.state = 'needs_login'
        self.saved = False
        self.value = None
        self.hold = False
    async def account(self):
        return self.value
    def status(self):
        return {'state': self.state, 'sessionSaved': self.saved, 'enabled': True}
    async def download(self, video, output):
        import asyncio
        while self.hold:
            await asyncio.sleep(.01)
        output.write_bytes(MP4 + self.endpoint.encode())


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='magpie-account-pool-test-')
        self.clients = {}
        def worker(directory, browser):
            client = FakeClient()
            class Jar:
                def set(self, *_args, **_kwargs):
                    pass
            client.cookies = Jar()
            self.clients[browser.endpoint] = client
            async def factory(account):
                return client
            return bridge_module.Bridge(directory, factory, browser)
        self.worker_factory = worker
        self.pool = AccountPool(self.temp.name, worker, Browser, maximum=3)
    def tearDown(self):
        self.pool.close()
        self.temp.cleanup()
    def login(self, identity):
        worker = self.pool.workers[identity]
        worker.browser.value = {'__Secure-1PSID': 'fake-session-' + identity, '__Secure-1PSIDTS': ''}
        worker.submit(worker.sync_browser()).result(5)
        self.assertEqual(worker.state, 'ready')
    def add(self):
        return self.pool.manage_accounts('add', {'name': '第二个账号'})['createdAccount']
    def finish(self, job):
        for _ in range(200):
            result = self.pool.get(job['id'])
            if result['status'] in ['completed', 'failed']:
                return result
            time.sleep(.01)
        self.fail('Job did not complete')

    def test_legacy_primary_keys_and_profile_survive_addition_without_exposing_session_values(self):
        key = self.pool.api_key
        self.login('primary')
        other = self.add()
        self.assertEqual(self.pool.api_key, key)
        self.assertEqual(self.pool.workers['primary'].root, pathlib.Path(self.temp.name))
        self.assertNotEqual(self.pool.workers['primary'].root, self.pool.workers[other].root)
        self.assertNotEqual(self.pool.workers['primary'].browser.endpoint, self.pool.workers[other].browser.endpoint)
        self.assertNotIn('fake-session-primary', json.dumps(self.pool.status()))
        self.assertEqual(self.pool.status()['readyAccounts'], 1)

    def test_priority_skips_unlogged_or_disabled_accounts_and_new_default_affects_only_new_jobs(self):
        other = self.add()
        self.login('primary')
        self.pool.manage_accounts('settings', {'defaultAccount': other})
        first = self.pool.create({'prompt': 'test'})
        self.assertEqual(first['account_id'], 'primary')
        self.finish(first)
        self.login(other)
        second = self.pool.create({'prompt': 'test'})
        self.assertEqual(second['account_id'], other)
        self.finish(second)
        self.pool.manage_accounts('update', {'id': other, 'enabled': False})
        self.assertEqual(self.pool.get(second['id'])['account_id'], other)
        self.assertTrue(self.pool.output_file(second['id']).read_bytes().endswith(self.pool.workers[other].browser.endpoint.encode()))
        self.assertEqual(self.pool.create({'prompt': 'test'})['account_id'], 'primary')

    def test_round_robin_persists_cursor_and_results_remain_on_original_account_after_restart(self):
        other = self.add()
        self.login('primary'); self.login(other)
        self.pool.manage_accounts('settings', {'strategy': 'round_robin'})
        first = self.pool.create({'prompt': 'test'}); self.finish(first)
        second = self.pool.create({'prompt': 'test'}); self.finish(second)
        self.assertEqual([first['account_id'], second['account_id']], ['primary', other])
        api_key = self.pool.api_key
        self.pool.close()
        self.pool = AccountPool(self.temp.name, self.worker_factory, Browser, maximum=3)
        self.login('primary'); self.login(other)
        self.assertEqual(self.pool.api_key, api_key)
        self.assertEqual(self.pool.get(second['id'])['account_id'], other)
        self.assertTrue(self.pool.output_file(second['id']).exists())
        third = self.pool.create({'prompt': 'test'})
        self.assertEqual(third['account_id'], 'primary')

    def test_switching_default_and_disabling_account_does_not_resubmit_pending_job(self):
        other = self.add()
        self.login('primary'); self.login(other)
        self.pool.workers['primary'].browser.hold = True
        job = self.pool.create({'prompt': 'test'})
        self.pool.manage_accounts('settings', {'defaultAccount': other})
        self.pool.manage_accounts('update', {'id': 'primary', 'enabled': False})
        for _ in range(10):
            self.assertEqual(self.pool.get(job['id'])['account_id'], 'primary')
        self.pool.workers['primary'].browser.hold = False
        self.assertEqual(self.finish(job)['status'], 'completed')
        self.assertEqual(sum(client.calls for client in self.clients.values()), 1)

    def test_name_id_limits_and_global_queue_are_enforced(self):
        with self.assertRaises(ValueError):
            self.pool.manage_accounts('update', {'id': '../secret', 'enabled': True})
        with self.assertRaises(ValueError):
            self.pool.manage_accounts('add', {'name': 'bad\nname'})
        self.add()
        self.pool.manage_accounts('add', {'name': '第三个账号'})
        with self.assertRaises(ValueError):
            self.pool.manage_accounts('add', {'name': '第四个账号'})
        self.login('primary')
        self.pool.workers['primary'].browser.hold = True
        for _ in range(3):
            self.pool.create({'prompt': 'test'})
        with self.assertRaises(ValueError):
            self.pool.create({'prompt': 'test'})

    def test_http_management_is_separate_and_downloads_use_original_account_directory(self):
        other = self.add()
        self.login(other)
        job = self.pool.create({'prompt': 'test'})
        self.finish(job)
        self.pool.manage_accounts('update', {'id': other, 'enabled': False})
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge_module.handler(self.pool))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def request(path, key):
            client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            client.request('GET', path, headers={'Authorization': 'Bearer ' + key})
            response = client.getresponse();result = response.status, response.read();client.close();return result
        try:
            self.assertEqual(request('/admin/accounts', self.pool.api_key)[0], 401)
            self.assertEqual(request('/admin/accounts', self.pool.admin_key)[0], 200)
            status, data = request('/v1/videos/' + job['id'] + '/content', self.pool.api_key)
            self.assertEqual(status, 200)
            self.assertTrue(data.endswith(self.pool.workers[other].browser.endpoint.encode()))
        finally:
            server.shutdown();server.server_close()


if __name__ == '__main__':
    unittest.main()
