"""Multiple isolated Gemini sessions behind one stable video API/model.

Selection happens once, before submitting a new job. Polling and downloads
always resolve the original owner; failures never resubmit on another account.
"""
import os
import pathlib
import re
import secrets
import threading

from bridge import Bridge, atomic, validate
from browser_session import BrowserSession

ACCOUNT_ID = re.compile(r'(?:primary|a[0-9a-f]{8})')


def account_name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 64 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('账号名称需为 1–64 个字符')
    return value.strip()


class AccountPool:
    def __init__(self, root, worker_factory=Bridge, browser_factory=BrowserSession, maximum=None):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.maximum = max(1, min(20, int(maximum or os.environ.get('GEMINI_MAX_ACCOUNTS', '5'))))
        self.lock = threading.RLock()
        self.worker_factory = worker_factory
        self.browser_factory = browser_factory
        self.file = self.root / 'accounts.json'
        if self.file.exists():
            import json
            self.config = json.loads(self.file.read_text())
        else:
            self.config = {'version': 1, 'strategy': 'priority', 'defaultAccount': 'primary',
                           'accounts': [{'id': 'primary', 'name': '账号1', 'enabled': True}]}
        self._validate_config()
        self.workers = {}
        try:
            for row in self.config['accounts']:
                self.workers[row['id']] = self._worker(row['id'])
        except Exception:
            for worker in self.workers.values():
                worker.close()
            raise
        primary = self.workers['primary']
        self.api_key, self.admin_key = primary.api_key, primary.admin_key
        atomic(self.file, self.config)

    def _validate_config(self):
        rows = self.config.get('accounts')
        if set(self.config) - {'version', 'strategy', 'defaultAccount', 'accounts', 'lastAssignedAccount'} or self.config.get('version') != 1 or self.config.get('strategy') not in ['priority', 'round_robin'] or not isinstance(rows, list) or not rows or len(rows) > 20:
            raise ValueError('多账号配置无效')
        ids = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) - {'id', 'name', 'enabled'} or not ACCOUNT_ID.fullmatch(row.get('id', '')) or row['id'] in ids or type(row.get('enabled')) is not bool:
                raise ValueError('账号配置无效')
            account_name(row.get('name'))
            ids.add(row['id'])
        if 'primary' not in ids or self.config.get('defaultAccount') not in ids:
            raise ValueError('默认账号无效')

    def _worker(self, identity):
        directory = self.root if identity == 'primary' else self.root / 'accounts' / identity
        endpoint = os.environ.get('GEMINI_BROWSER_CDP', 'http://gemini-browser:9222') if identity == 'primary' else f'http://gemini-browser-{identity}:9222'
        return self.worker_factory(directory, browser=self.browser_factory(endpoint))

    @property
    def state(self):
        states = [self.workers[row['id']].state for row in self.config['accounts'] if row['enabled']]
        if not states:
            return 'paused'
        return 'ready' if 'ready' in states else 'authorizing' if 'authorizing' in states else 'needs_login'

    def _rows(self):
        rows = list(self.config['accounts'])
        rows.sort(key=lambda row: row['id'] != self.config['defaultAccount'])
        return rows

    def status(self):
        with self.lock:
            rows = []
            for row in self.config['accounts']:
                worker = self.workers[row['id']]
                with worker.lock:
                    pending = sum(job['status'] in ['queued', 'in_progress'] for job in worker.jobs.values())
                value = worker.status()
                rows.append({**row, 'state': value['state'], 'configured': value['configured'], 'browser': value.get('browser', {}),
                             'pendingJobs': pending, 'isDefault': row['id'] == self.config['defaultAccount']})
            primary = self.workers[self.config['defaultAccount']].status()
            return {'state': self.state, 'configured': any(row['configured'] for row in rows),
                    'model': 'gemini-web-video', 'modelVersion': 'account-default', 'browser': primary.get('browser', {}),
                    'accounts': rows, 'strategy': self.config['strategy'], 'defaultAccount': self.config['defaultAccount'],
                    'maxAccounts': self.maximum, 'readyAccounts': sum(row['enabled'] and row['state'] == 'ready' for row in rows),
                    'note': '多个独立网页账号共用同一模型；仅新任务选择账号，已提交任务固定原账号。'}

    def manage_accounts(self, action, body):
        if not isinstance(body, dict):
            raise ValueError('请求必须是账号设置对象')
        with self.lock:
            if action == 'add':
                if set(body) - {'name'} or len(self.config['accounts']) >= self.maximum:
                    raise ValueError('已达到账号数量上限或参数无效')
                name = account_name(body.get('name') or '账号' + str(len(self.config['accounts']) + 1))
                if any(row['name'] == name for row in self.config['accounts']):
                    raise ValueError('请使用不同的账号名称')
                identity = 'a' + secrets.token_hex(4)
                while identity in self.workers:
                    identity = 'a' + secrets.token_hex(4)
                worker = self._worker(identity)
                self.workers[identity] = worker
                self.config['accounts'].append({'id': identity, 'name': name, 'enabled': True})
                atomic(self.file, self.config)
                return {'createdAccount': identity, **self.status()}
            if action == 'settings':
                if set(body) - {'strategy', 'defaultAccount'}:
                    raise ValueError('未知账号策略设置')
                strategy = body.get('strategy', self.config['strategy'])
                default = body.get('defaultAccount', self.config['defaultAccount'])
                if strategy not in ['priority', 'round_robin'] or not isinstance(default, str) or default not in self.workers:
                    raise ValueError('无效的账号策略或默认账号')
                self.config.update(strategy=strategy, defaultAccount=default)
            elif action == 'update':
                if set(body) - {'id', 'name', 'enabled'} or not isinstance(body.get('id'), str) or body['id'] not in self.workers:
                    raise ValueError('无效的账号设置')
                row = next(row for row in self.config['accounts'] if row['id'] == body['id'])
                name = account_name(body.get('name', row['name']))
                if any(other['id'] != row['id'] and other['name'] == name for other in self.config['accounts']):
                    raise ValueError('请使用不同的账号名称')
                enabled = body.get('enabled', row['enabled'])
                if type(enabled) is not bool:
                    raise ValueError('启用状态无效')
                row.update(name=name, enabled=enabled)
            else:
                raise ValueError('未知账号操作')
            atomic(self.file, self.config)
            return self.status()

    def kick_browser_checks(self):
        with self.lock:
            workers = list(self.workers.values())
        for worker in workers:
            if worker.browser:
                worker.submit(worker.sync_browser())

    def create(self, body):
        validate(body)
        with self.lock:
            pending = 0
            size = 0
            for worker in self.workers.values():
                worker.cleanup()
                with worker.lock:
                    pending += sum(job['status'] in ['queued', 'in_progress'] for job in worker.jobs.values())
                    size += sum(file.stat().st_size for file in worker.root.glob('video_*/output.mp4'))
            if pending >= 3:
                raise ValueError('视频任务队列已满，请查询原任务后再试')
            if size >= 2 * 1024**3:
                raise ValueError('所有账号的视频缓存合计已达 2 GiB')
            rows = [row for row in self._rows() if row['enabled'] and self.workers[row['id']].state == 'ready']
            if not rows:
                raise ValueError('没有已登录且启用的视频账号')
            if self.config['strategy'] == 'round_robin':
                last = self.config.get('lastAssignedAccount')
                ids = [row['id'] for row in rows]
                chosen = rows[(ids.index(last) + 1) % len(rows)] if last in ids else rows[0]
            else:
                chosen = rows[0]
            worker = self.workers[chosen['id']]
            with worker.lock:
                result = worker.create(body)
                job = worker.jobs[result['id']]
                job.update(account_id=chosen['id'], account_name=chosen['name'])
                # The original job ID was persisted before submission. A failure
                # updating optional labels/cursor must not turn an accepted job
                # into an ambiguous API error that could cause duplicate work.
                try:
                    worker.save_job(job)
                except OSError:
                    pass
                result = dict(job)
            self.config['lastAssignedAccount'] = chosen['id']
            try:
                atomic(self.file, self.config)
            except OSError:
                pass
            return result

    def owner(self, job_id):
        for worker in self.workers.values():
            if worker.get(job_id):
                return worker
        return None

    def get(self, job_id):
        with self.lock:
            worker = self.owner(job_id)
            return worker.get(job_id) if worker else None

    def output_file(self, job_id):
        with self.lock:
            worker = self.owner(job_id)
            return worker.output_file(job_id) if worker else self.root / 'missing-output.mp4'

    def close(self):
        for worker in self.workers.values():
            worker.close()
