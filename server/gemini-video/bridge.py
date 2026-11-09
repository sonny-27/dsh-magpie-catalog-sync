"""Private Gemini Apps session -> OpenAI-shaped asynchronous video API.

The dedicated server browser can save its own Gemini session automatically.
No desktop browser profiles, API-key fallback or automatic resubmission.
"""
import asyncio
import base64
import contextlib
import hmac
import json
import os
import pathlib
import re
import secrets
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = 'gemini-web-video'
MAX_BODY = 32 * 1024 * 1024
MAX_IMAGE = 10 * 1024 * 1024
MAX_IMAGES = 20 * 1024 * 1024
MAX_VIDEO = 256 * 1024 * 1024
ID = re.compile(r'video_[a-f0-9]{32}')


def atomic(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(file)


def secret(file):
    if not file.exists():
        file.write_text(secrets.token_urlsafe(32), encoding='utf-8')
        file.chmod(0o600)
    return file.read_text().strip()


def image_bytes(value):
    if isinstance(value, dict):
        value = value.get('image_url')
    if not isinstance(value, str):
        raise ValueError('图片必须是 image data URL')
    match = re.fullmatch(r'data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)', value)
    if not match or len(match[2]) > MAX_IMAGE * 4 // 3 + 4:
        raise ValueError('仅接收 PNG/JPEG/WebP/GIF 图片数据，单张不超过 10 MiB；请先上传图片')
    try:
        data = base64.b64decode(match[2], validate=True)
    except ValueError:
        raise ValueError('图片 Base64 无效') from None
    if not data or len(data) > MAX_IMAGE:
        raise ValueError('参考图大小无效')
    return data, match[1]


def validate(body):
    if not isinstance(body, dict) or body.get('model', MODEL) != MODEL:
        raise ValueError('请选择 Gemini 网页视频模型')
    if set(body) - {'model', 'prompt', 'seconds', 'size', 'input_reference', 'reference_images'}:
        raise ValueError('请求包含不支持的视频参数')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise ValueError('请输入不超过 16000 字符的视频描述')
    seconds = body.get('seconds')
    if seconds is not None and (str(seconds) not in {str(i) for i in range(1, 16)}):
        raise ValueError('seconds 需为 1–15 的整数；网页是否接受该时长取决于账号当前模型')
    size = body.get('size', '')
    if size not in ['', '16:9', '9:16', '1:1']:
        raise ValueError('网页视频仅接受 16:9、9:16 或 1:1 的比例请求')
    references = body.get('reference_images', [])
    if not isinstance(references, list):
        raise ValueError('reference_images 需为数组')
    if body.get('input_reference'):
        references = [body['input_reference'], *references]
    if len(references) > 5:
        raise ValueError('网页视频最多接受 5 张输入图片')
    images = [image_bytes(value) for value in references]
    if sum(len(data) for data, _ in images) > MAX_IMAGES:
        raise ValueError('参考图合计不能超过 20 MiB')
    return prompt.strip(), images


async def new_client(account):
    from gemini_webapi import GeminiClient
    from loguru import logger
    logger.remove()
    client = GeminiClient(account['__Secure-1PSID'], account.get('__Secure-1PSIDTS', ''),
                          proxy=os.environ.get('GEMINI_PROXY') or None)
    try:
        await asyncio.wait_for(client.init(timeout=600, auto_close=False,
            auto_refresh=not bool(os.environ.get('GEMINI_BROWSER_CDP')), verbose=False), 45)
        return client
    except BaseException:
        with contextlib.suppress(Exception):
            await client.close()
        raise


class Bridge:
    def __init__(self, root, factory=new_client, browser=None):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.api_key = secret(self.root / 'api.key')
        self.admin_key = secret(self.root / 'admin.key')
        self.factory = factory
        self.lock = threading.RLock()
        self.jobs = {}
        self.client = None
        self.state = 'needs_login'
        self.browser = browser
        if self.browser is None and os.environ.get('GEMINI_BROWSER_CDP'):
            from browser_session import BrowserSession
            self.browser = BrowserSession(os.environ['GEMINI_BROWSER_CDP'])
        self.browser_lock = asyncio.Lock()
        self.browser_account = None
        self.browser_failed_account = None
        self.browser_retry_at = 0
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.serial = asyncio.Semaphore(1)
        for file in self.root.glob('video_*/job.json'):
            try:
                job = json.loads(file.read_text())
                if not ID.fullmatch(job['id']):
                    continue
                if job['status'] in ['queued', 'in_progress']:
                    job.update(status='failed', error={'code': 'interrupted', 'message': '服务重启中断了原任务；未自动重提'})
                    atomic(file, job)
                self.jobs[job['id']] = job
            except (ValueError, KeyError, OSError):
                continue
        self.submit(self.bootstrap())
        self.submit(self.cleaner())
        if self.browser:
            self.submit(self.watch_browser())

    def submit(self, operation):
        return asyncio.run_coroutine_threadsafe(operation, self.loop)

    async def bootstrap(self):
        if self.browser:
            await self.sync_browser()
            return
        file = self.root / 'account.json'
        if file.exists():
            try:
                await self.import_account(json.loads(file.read_text()))
            except Exception:
                self.state = 'needs_login'

    async def import_account(self, account):
        if not isinstance(account, dict) or set(account) - {'__Secure-1PSID', '__Secure-1PSIDTS'}:
            raise ValueError('只接受 Gemini 的两项指定会话 Cookie')
        for name in ['__Secure-1PSID', '__Secure-1PSIDTS']:
            value = account.get(name, '')
            if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\r\n\0;]', value):
                raise ValueError('会话 Cookie 格式无效')
        if not account.get('__Secure-1PSID'):
            raise ValueError('需要 __Secure-1PSID')
        with self.lock:
            if self.state == 'authorizing':
                raise ValueError('已有会话验证正在进行')
            if any(job['status'] in ['queued', 'in_progress'] for job in self.jobs.values()):
                raise ValueError('请等待当前视频任务结束后更换账号')
            previous_state = self.state
            self.state = 'authorizing'
        try:
            client = await self.factory(account)
        except BaseException:
            self.state = previous_state
            raise
        previous = self.client
        atomic(self.root / 'account.json', account)
        self.client = client
        self.state = 'ready'
        if previous:
            await previous.close()

    async def sync_browser(self):
        if not self.browser:
            return
        async with self.browser_lock:
            account = None
            try:
                account = await self.browser.account()
                if not account:
                    if self.state != 'authorizing':
                        self.state = 'needs_login'
                    return
                if account == self.browser_failed_account and time.monotonic() < self.browser_retry_at:
                    self.browser.state = 'session_invalid'
                    return
                if self.state == 'ready' and self.client and self.browser_account and self.browser_account.get('__Secure-1PSID') == account['__Secure-1PSID']:
                    if account != self.browser_account:
                        jar = self.client.cookies
                        for name, value in account.items():
                            jar.set(name, value, domain='.google.com', path='/')
                        atomic(self.root / 'account.json', account)
                        self.browser_account = dict(account)
                else:
                    with self.lock:
                        if any(job['status'] in ['queued', 'in_progress'] for job in self.jobs.values()):
                            self.state = 'needs_login'
                            self.browser.state = 'waiting_for_jobs'
                            return
                    await self.import_account(account)
                    self.browser_account = dict(account)
                self.browser.saved = True
                self.browser.state = 'authorized'
                self.browser_failed_account = None
            except asyncio.CancelledError:
                raise
            except Exception:
                self.state = 'needs_login'
                self.browser.state = 'session_invalid'
                self.browser_failed_account = dict(account) if account else None
                self.browser_retry_at = time.monotonic() + 60

    async def watch_browser(self):
        while True:
            await asyncio.sleep(5)
            await self.sync_browser()

    def status(self):
        value = {'state': self.state, 'configured': (self.root / 'account.json').exists(),
                'model': MODEL, 'modelVersion': 'account-default',
                'note': '使用网页账号当前视频模型；时长和比例为提示请求，不保证上游严格采用'}
        if self.browser:
            value['browser'] = self.browser.status()
        return value

    def save_job(self, job):
        atomic(self.root / job['id'] / 'job.json', job)

    def create(self, body):
        prompt, images = validate(body)
        with self.lock:
            if self.state != 'ready' or not self.client:
                raise ValueError('Gemini 网页账号尚未授权或登录已失效')
            if sum(j['status'] in ['queued', 'in_progress'] for j in self.jobs.values()) >= 3:
                raise ValueError('视频任务队列已满，请查询原任务后再试')
            self.cleanup()
            if sum(f.stat().st_size for f in self.root.glob('video_*/output.mp4')) >= 2 * 1024**3:
                raise ValueError('视频缓存已达 2 GiB，请等待自动清理')
            job_id = 'video_' + secrets.token_hex(16)
            directory = self.root / job_id
            directory.mkdir(mode=0o700)
            job = {'id': job_id, 'object': 'video', 'model': MODEL, 'status': 'queued',
                   'progress': 0, 'created_at': int(time.time()), 'requested_seconds': body.get('seconds'),
                   'requested_size': body.get('size'), 'expires_at': int(time.time()) + 86400}
            self.jobs[job_id] = job
            self.save_job(job)
            self.submit(self.generate(job, prompt, images))
            return dict(job)

    async def generate(self, job, prompt, images):
        directory = self.root / job['id']
        async with self.serial:
            paths = []
            try:
                with self.lock:
                    job.update(status='in_progress', progress=10)
                    self.save_job(job)
                for i, (data, extension) in enumerate(images):
                    file = directory / f'reference-{i}.{extension}'
                    file.write_bytes(data)
                    file.chmod(0o600)
                    paths.append(file)
                instruction = 'Generate an actual video using the video generation feature. Do not return a still image or merely describe a video.\n' + prompt
                if job.get('requested_seconds'):
                    instruction += '\nRequested duration: ' + str(job['requested_seconds']) + ' seconds, if supported.'
                if job.get('requested_size'):
                    instruction += '\nRequested aspect ratio: ' + job['requested_size'] + ', if supported.'
                async with asyncio.timeout(900):
                    response = await self.client.generate_content(instruction, files=[str(x) for x in paths] or None)
                    videos = list(getattr(response, 'videos', []) or [])
                    videos += [m for m in (getattr(response, 'media', []) or []) if getattr(m, 'url', '')]
                    if not videos:
                        raise ValueError('no_video')
                    # One requested video, one download; never submit generation again when pending.
                    if self.browser:
                        await self.browser.download(videos[0], directory / 'output.mp4')
                        result = {'video': str(directory / 'output.mp4')}
                    else:
                        result = await videos[0].save(path=str(directory), filename='output.mp4', verbose=False)
                file = pathlib.Path(result['video']) if isinstance(result, dict) and result.get('video') else directory / 'output.mp4'
                if file.resolve() != (directory / 'output.mp4').resolve():
                    raise ValueError('unexpected_file')
                if not file.is_file() or file.stat().st_size > MAX_VIDEO:
                    raise ValueError('invalid_video')
                with file.open('rb') as handle:
                    if b'ftyp' not in handle.read(32):
                        raise ValueError('invalid_mp4')
                file.chmod(0o600)
                with self.lock:
                    job.update(status='completed', progress=100, bytes=file.stat().st_size)
                    self.save_job(job)
            except Exception as error:
                message = '网页视频生成或下载失败。请检查账号的视频入口、剩余额度和登录状态；未自动重提。'
                if isinstance(error, ValueError) and str(error) == 'no_video':
                    message = '网页没有返回视频，可能是视频能力未开放、额度不足或接口已变化；没有降级成图片。'
                if '403' in str(error):
                    message = 'Google 拒绝视频下载（403）；网页登录态或下载授权不完整，不能将此任务视为成功。'
                with self.lock:
                    job.update(status='failed', error={'code': 'gemini_web_video_error', 'message': message})
                    self.save_job(job)
                with contextlib.suppress(OSError):
                    (directory / 'output.mp4').unlink(missing_ok=True)
            finally:
                for file in paths:
                    file.unlink(missing_ok=True)

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def output_file(self, job_id):
        if not ID.fullmatch(job_id):
            raise ValueError('Invalid video ID')
        return self.root / job_id / 'output.mp4'

    def cleanup(self):
        with self.lock:
            for job_id, job in list(self.jobs.items()):
                if job['expires_at'] < time.time() and job['status'] not in ['queued', 'in_progress']:
                    directory = self.root / job_id
                    if ID.fullmatch(job_id) and directory.parent == self.root:
                        shutil.rmtree(directory)
                        del self.jobs[job_id]

    async def cleaner(self):
        while True:
            self.cleanup()
            await asyncio.sleep(60)

    async def shutdown(self):
        tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.client:
            await self.client.close()

    def close(self):
        self.submit(self.shutdown()).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)
        if not self.thread.is_alive():
            self.loop.close()


def handler(bridge):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Never log request bodies, credentials, prompts or Google download URLs.

        def json(self, code, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self, admin=False):
            if self.headers.get('Origin'):
                return False
            if admin and self.client_address[0] not in ['127.0.0.1', '::1']:
                return False
            key = bridge.admin_key if admin else bridge.api_key
            return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + key)

        def do_GET(self):
            if self.path == '/healthz':
                return self.json(200, bridge.status())
            admin = self.path in ['/admin/browser/status', '/admin/accounts']
            if not self.authorized(admin):
                return self.json(401, {'error': {'message': '需要视频桥接凭据'}})
            if admin:
                return self.json(200, bridge.status())
            if self.path == '/v1/models':
                models = [{'id': MODEL, 'object': 'model', 'kind': 'video', 'name': 'Gemini 网页视频（账号当前模型）'}] if bridge.state == 'ready' else []
                return self.json(200, {'object': 'list', 'data': models})
            match = re.fullmatch(r'/v1/videos/(video_[a-f0-9]{32})(/content)?', self.path)
            job = bridge.get(match[1]) if match else None
            if not job:
                return self.json(404, {'error': {'message': '未找到视频任务'}})
            if not match[2]:
                return self.json(200, job)
            file = bridge.output_file(job['id'])
            if job['status'] != 'completed' or not file.is_file():
                return self.json(409, {'error': {'message': '视频尚未完成或已过期'}})
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Cache-Control', 'private, no-store')
            self.send_header('Content-Length', str(file.stat().st_size))
            self.send_header('Content-Disposition', 'attachment; filename="gemini-video.mp4"')
            self.end_headers()
            with file.open('rb') as stream:
                shutil.copyfileobj(stream, self.wfile, 65536)

        def do_POST(self):
            account_action = re.fullmatch(r'/admin/accounts/(add|update|settings)', self.path)
            admin = self.path in ['/admin/session', '/admin/browser/start'] or bool(account_action)
            if not self.authorized(admin):
                return self.json(401, {'error': {'message': '需要调用凭据'}})
            if self.path not in ['/v1/videos', '/admin/session', '/admin/browser/start'] and not account_action:
                return self.json(404, {'error': {'message': '未知接口'}})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= (32768 if admin else MAX_BODY) or self.headers.get('Transfer-Encoding'):
                    return self.json(413, {'error': {'message': '请求大小无效'}})
                body = json.loads(self.rfile.read(length))
                if account_action:
                    if not hasattr(bridge, 'manage_accounts'):
                        return self.json(400, {'error': {'message': '此部署未启用多账号'}})
                    return self.json(200, bridge.manage_accounts(account_action[1], body))
                if self.path == '/admin/browser/start':
                    if hasattr(bridge, 'kick_browser_checks'):
                        bridge.kick_browser_checks()
                        return self.json(200, bridge.status())
                    if not bridge.browser:
                        return self.json(400, {'error': {'message': '此部署尚未启用专用登录浏览器'}})
                    bridge.submit(bridge.sync_browser())
                    return self.json(200, bridge.status())
                if admin:
                    if hasattr(bridge, 'manage_accounts'):
                        return self.json(400, {'error': {'message': '请在对应账号的专用浏览器中登录'}})
                    if bridge.browser:
                        return self.json(400, {'error': {'message': '此部署请在专用浏览器中登录，会话会自动保存'}})
                    try:
                        bridge.submit(bridge.import_account(body)).result(55)
                    except ValueError:
                        raise
                    except Exception:
                        return self.json(400, {'error': {'message': 'Gemini 会话验证失败，请重新获取独立会话的登录 Cookie'}})
                    return self.json(200, bridge.status())
                return self.json(200, bridge.create(body))
            except (ValueError, KeyError):
                return self.json(400, {'error': {'message': '视频请求或会话信息无效，请检查参数和登录状态'}})
    return Handler


if __name__ == '__main__':
    if os.environ.get('GEMINI_MULTI_ACCOUNT') == '1':
        from account_pool import AccountPool
        bridge = AccountPool(os.environ.get('GEMINI_VIDEO_DATA', '/data'))
    else:
        bridge = Bridge(os.environ.get('GEMINI_VIDEO_DATA', '/data'))
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8010'))), handler(bridge))
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        bridge.close()
