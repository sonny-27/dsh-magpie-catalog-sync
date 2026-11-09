"""Session management for this deployment's dedicated Gemini browser only.

CDP stays on an isolated Docker network. No desktop browser profiles are read.
Only Gemini's two session cookies are retained; account passwords aren't read.
"""
import asyncio
import base64
import contextlib
import json
import re
import socket
import time
import urllib.parse
import urllib.request

MAX_VIDEO = 256 * 1024 * 1024
COOKIE_NAMES = {'__Secure-1PSID', '__Secure-1PSIDTS'}


def gemini_page(url):
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and not parsed.username and not parsed.password and parsed.port in [None, 443] and bool(
        re.match(r'^/(?:u/0/)?app(?:/|$)', parsed.path))


def media_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ''
    return (parsed.scheme == 'https' and parsed.port in [None, 443] and not parsed.username and not parsed.password and not parsed.fragment
            and (host == 'usercontent.google.com' or host.endswith('.usercontent.google.com')
                 or host == 'googleusercontent.com' or host.endswith('.googleusercontent.com')))


class CDP:
    def __init__(self, websocket):
        self.websocket = websocket
        self.sequence = 0

    async def call(self, method, params=None, session=None, timeout=30):
        self.sequence += 1
        number = self.sequence
        body = {'id': number, 'method': method, 'params': params or {}}
        if session:
            body['sessionId'] = session
        await self.websocket.send(json.dumps(body))
        async with asyncio.timeout(timeout):
            while True:
                message = json.loads(await self.websocket.recv())
                if message.get('id') == number:
                    if 'error' in message:
                        raise RuntimeError('专用浏览器通信失败')
                    return message.get('result', {})


class BrowserSession:
    def __init__(self, endpoint):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ['', '/']:
            raise ValueError('CDP must use the configured internal browser endpoint')
        self.endpoint = endpoint.rstrip('/')
        self.hostname = parsed.hostname
        self.port = parsed.port or 80
        self.state = 'starting'
        self.saved = False
        self.last_check = None

    def _json(self, path):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(self.endpoint + path, headers={'Host': 'localhost'})
        with opener.open(request, timeout=5) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('Browser metadata is too large')
        return json.loads(data)

    def _websocket_url(self, value):
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme != 'ws' or not re.fullmatch(r'/devtools/(?:browser|page)/[A-Za-z0-9-]+', parsed.path):
            raise ValueError('Unexpected browser websocket')
        # Use an IP Host header accepted by Chromium; never follow a host returned in metadata.
        address = socket.gethostbyname(self.hostname)
        return f'ws://{address}:{self.port}' + parsed.path

    @contextlib.asynccontextmanager
    async def connection(self, websocket_url):
        from websockets.asyncio.client import connect
        async with connect(self._websocket_url(websocket_url), proxy=None, max_size=4 * 1024 * 1024,
                           open_timeout=10, close_timeout=3) as websocket:
            yield CDP(websocket)

    async def account(self):
        """Return only the two Gemini cookies, without logging or exposing their values."""
        self.last_check = int(time.time())
        try:
            tabs = await asyncio.to_thread(self._json, '/json/list')
            pages = [tab for tab in tabs if tab.get('type') == 'page' and gemini_page(tab.get('url', ''))]
            if not pages:
                self.state = 'needs_login'
                return None
            async with self.connection(pages[0]['webSocketDebuggerUrl']) as cdp:
                result = await cdp.call('Network.getCookies', {'urls': ['https://gemini.google.com/']})
            account = {}
            for cookie in result.get('cookies', []):
                if cookie.get('name') in COOKIE_NAMES and cookie.get('domain', '').lstrip('.') in ['google.com', 'gemini.google.com'] and cookie.get('path', '/') == '/':
                    account[cookie['name']] = cookie['value']
            if not account.get('__Secure-1PSID'):
                self.state = 'needs_login'
                return None
            account.setdefault('__Secure-1PSIDTS', '')
            self.state = 'session_detected'
            return account
        except asyncio.CancelledError:
            raise
        except Exception:
            self.state = 'browser_unavailable'
            return None

    def status(self):
        return {'enabled': True, 'state': self.state, 'sessionSaved': self.saved, 'lastCheck': self.last_check,
                'note': '请只在此专用浏览器登录要使用的 Gemini Pro 账号；密码和二次验证由你输入。'}

    async def download(self, video, destination, timeout=180):
        url = getattr(video, 'url', '')
        if not media_url(url):
            raise ValueError('视频下载地址不是受支持的 Google 媒体地址')
        cid = getattr(video, 'cid', '') or ''
        suffix = cid.removeprefix('c_') if re.fullmatch(r'c_[A-Za-z0-9_-]{1,160}', cid) else ''
        page = 'https://gemini.google.com/u/0/app/' + suffix
        version = await asyncio.to_thread(self._json, '/json/version')
        temporary = destination.with_suffix('.download')
        async with self.connection(version['webSocketDebuggerUrl']) as cdp:
            target = None
            try:
                async with asyncio.timeout(timeout):
                    result = await cdp.call('Target.createTarget', {'url': page, 'background': True})
                    target = result['targetId']
                    session = (await cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True}))['sessionId']
                    await cdp.call('Runtime.enable', session=session)
                    for _ in range(80):
                        location = await cdp.call('Runtime.evaluate', {'expression': '({url:location.href,ready:!!document.body})', 'returnByValue': True}, session=session)
                        current = location.get('result', {}).get('value', {})
                        if current.get('ready') and gemini_page(current.get('url', '')):
                            break
                        await asyncio.sleep(.5)
                    else:
                        raise RuntimeError('请重新登录专用 Gemini 浏览器')
                    # Browser-owned fetch uses the same authenticated origin as Gemini's video player.
                    # Return an opaque reader object; video bytes are streamed in bounded chunks below.
                    expression = '''(async()=>{
                      const target=TARGET, limit=LIMIT;
                      let response=await fetch(target,{credentials:'include',redirect:'error'});
                      if(response.status===403){
                        await new Promise(resolve=>{
                          const player=document.createElement('video');player.muted=true;player.crossOrigin='use-credentials';player.src=target;player.style.display='none';
                          const finish=()=>{player.remove();resolve()};player.addEventListener('loadeddata',finish,{once:true});player.addEventListener('error',finish,{once:true});document.body.appendChild(player);setTimeout(finish,8000);
                        });
                        response=await fetch(target,{credentials:'include',redirect:'error'});
                      }
                      // Gemini can return 206 while rendering. Poll this download,
                      // never the video-generation request, until the full file is ready.
                      for(let attempt=0;[202,206].includes(response.status)&&attempt<40;attempt++){
                        if(response.body)await response.body.cancel();
                        await new Promise(resolve=>setTimeout(resolve,3000));
                        response=await fetch(target,{credentials:'include',redirect:'error'});
                      }
                      if(response.status!==200||!(response.headers.get('content-type')||'').startsWith('video/'))throw Error('video download unavailable');
                      const length=Number(response.headers.get('content-length')||0);if(length>limit)throw Error('video too large');
                      const reader=response.body.getReader();let total=0,pending=null,offset=0;
                      return {read:async()=>{
                        if(!pending||offset>=pending.length){const item=await reader.read();if(item.done)return {done:true};pending=item.value;offset=0;total+=pending.length;if(total>limit){await reader.cancel();throw Error('video too large')}}
                        const chunk=pending.subarray(offset,offset+131072);offset+=chunk.length;
                        let text='';for(let i=0;i<chunk.length;i+=8192)text+=String.fromCharCode(...chunk.subarray(i,i+8192));
                        return {done:false,data:btoa(text)};
                      }};
                    })()'''.replace('LIMIT', str(MAX_VIDEO)).replace('TARGET', json.dumps(url), 1)
                    result = await cdp.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': False}, session=session, timeout=150)
                    reader = result.get('result', {}).get('objectId')
                    if result.get('exceptionDetails') or not reader:
                        raise RuntimeError('浏览器未取得视频下载授权')
                    size = 0
                    with temporary.open('wb') as output:
                        while True:
                            result = await cdp.call('Runtime.callFunctionOn', {'objectId': reader, 'functionDeclaration': 'async function(){return await this.read()}', 'awaitPromise': True, 'returnByValue': True}, session=session)
                            if result.get('exceptionDetails'):
                                raise RuntimeError('浏览器视频传输失败')
                            item = result.get('result', {}).get('value', {})
                            if item.get('done'):
                                break
                            data = base64.b64decode(item.get('data', ''), validate=True)
                            if not data:
                                raise ValueError('浏览器返回空视频数据')
                            size += len(data)
                            if size > MAX_VIDEO:
                                raise ValueError('视频超过缓存上限')
                            output.write(data)
                    if not size:
                        raise ValueError('下载内容为空')
                    with temporary.open('rb') as output:
                        if b'ftyp' not in output.read(32):
                            raise ValueError('下载内容不是 MP4')
                    temporary.chmod(0o600)
                    temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
                if target:
                    with contextlib.suppress(Exception):
                        await cdp.call('Target.closeTarget', {'targetId': target}, timeout=5)
