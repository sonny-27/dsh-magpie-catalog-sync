"""A narrow bridge to Magpie's native search settings; no general admin proxy."""
import hashlib
import hmac
import json
import os
import pathlib
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = '/v1/magpie/subscription/search-policy'
LOCK = threading.Lock()
KEY = pathlib.Path(os.environ.get('GATEWAY_KEY_FILE', '/secrets/gateway.key')).read_text().strip()
ADMIN_KEY = pathlib.Path(os.environ.get('ADMIN_KEY_FILE', '/secrets/admin.key')).read_text().strip()
ADMIN = os.environ.get('MAGPIE_ADMIN', 'http://magpie:3430')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def native(path='/api/settings', body=None):
    request = urllib.request.Request(ADMIN + path, data=None if body is None else json.dumps(body).encode(),
        headers={'Cookie': 'magpie_web_3430=' + ADMIN_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    with OPENER.open(request, timeout=15) as response:
        return json.load(response)

def view(data):
    choices = []
    for item in data.get('searchChoices', []):
        if item.get('search'):
            choices.append({'id': item['id'] + '/@search', 'name': item['name'] + ' · 原生搜索'})
        elif item.get('service'):
            choices.append({'id': item['id'], 'name': item['name']})
        for model in item.get('models', []):
            choices.append({'id': model['id'], 'name': item['name'] + ' / ' + model.get('name', model['id'])})
    order = [x for x in [data.get('searcher', ''), *(data.get('searcherThen') or [])] if x and x != 'off']
    # Preserve a selected-but-temporarily-unavailable source in the editable order.
    for item in order:
        if not any(x['id'] == item for x in choices):
            choices.append({'id': item, 'name': item + '（暂不可用）'})
    policy = {'first': data.get('searchFirst') or 'model', 'modelOrder': order,
        'apis': [{'id': x['vendor'], 'name': x['name'], 'enabled': not x.get('off', False), 'ready': x.get('ready', False)} for x in data.get('searchAPIs', [])],
        'modelChoices': choices, 'fallback': 'Magpie native', 'scope': 'server'}
    signature = {k: policy[k] for k in ['first', 'modelOrder', 'apis']}
    policy['revision'] = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()[:20]
    return policy

def validate(body, current):
    if not isinstance(body, dict):
        raise ValueError('请求必须是设置对象')
    if set(body) - {'revision', 'first', 'modelOrder', 'apis'}:
        raise ValueError('只接受搜索排序与开关设置')
    if body.get('revision') != current['revision']:
        raise ValueError('搜索设置已被其他客户端修改，请重新读取')
    if body.get('first') not in ['model', 'api']:
        raise ValueError('无效的搜索类别')
    order = body.get('modelOrder')
    allowed = {x['id'] for x in current['modelChoices']}
    if not isinstance(order, list) or len(order) > 64 or any(not isinstance(x, str) or x not in allowed for x in order) or len(set(order)) != len(order):
        raise ValueError('搜索模型顺序无效')
    apis = body.get('apis')
    expected = {x['id'] for x in current['apis']}
    if not isinstance(apis, list) or any(not isinstance(x, dict) or set(x) != {'id', 'enabled'} or not isinstance(x['enabled'], bool) for x in apis):
        raise ValueError('搜索 API 开关无效')
    if {x['id'] for x in apis} != expected or len(apis) != len(expected):
        raise ValueError('搜索 API 列表已变化，请重新读取')
    if not order and not any(x['enabled'] and next(y for y in current['apis'] if y['id'] == x['id'])['ready'] for x in apis):
        raise ValueError('至少保留一个可用搜索来源')

def apply(body):
    before = native()
    current = view(before)
    validate(body, current)
    previous_apis = {x['id']: x['enabled'] for x in current['apis']}
    try:
        # Full native settings snapshot preserves all unrelated preferences.
        settings = dict(before)
        settings.update(searchFirst=body['first'], searcher=body['modelOrder'][0] if body['modelOrder'] else 'off', searcherThen=body['modelOrder'][1:])
        native(body=settings)
        for item in body['apis']:
            if item['enabled'] != previous_apis[item['id']]:
                native('/api/settings/search-api', {'vendor': item['id'], 'on': item['enabled']})
        native('/api/settings/search-api', {'arrange': [x['id'] for x in body['apis']]})
        return view(native())
    except Exception:
        # Restore only through native APIs; never write providers.json ourselves.
        native(body=before)
        for item in current['apis']:
            native('/api/settings/search-api', {'vendor': item['id'], 'on': item['enabled']})
        native('/api/settings/search-api', {'arrange': [x['id'] for x in current['apis']]})
        raise

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def dispatch(self):
        if self.path != PATH:
            return self.reply(404, {'error': 'Not found'})
        if not hmac.compare_digest(hashlib.sha256(self.headers.get('Authorization', '').encode()).digest(), hashlib.sha256(('Bearer ' + KEY).encode()).digest()):
            return self.reply(401, {'error': '需要 Magpie 网关 Key'})
        if self.headers.get('Origin'):
            return self.reply(403, {'error': '只接受 API 客户端调用'})
        try:
            # A revoked gateway key must not retain access to settings.
            with OPENER.open(urllib.request.Request('http://magpie:3425/v1/models', headers={'Authorization': 'Bearer ' + KEY}), timeout=8) as response:
                response.read(1)
        except urllib.error.HTTPError as error:
            return self.reply(401 if error.code in (401, 403) else 502, {'error': '网关鉴权失败'})
        except Exception:
            return self.reply(502, {'error': 'Magpie 网关暂不可用'})
        try:
            with LOCK:
                if self.command == 'GET':
                    return self.reply(200, view(native()))
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    return self.reply(413, {'error': '请求大小无效'})
                body = json.loads(self.rfile.read(size))
                return self.reply(200, apply(body))
        except ValueError as error:
            self.reply(400, {'error': str(error)})
        except Exception as error:
            print('native search settings failure:', type(error).__name__, getattr(error, 'code', ''), flush=True)
            self.reply(502, {'error': 'Magpie 搜索设置服务暂不可用，请检查服务日志'})

    do_GET = dispatch
    do_POST = dispatch

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3431), Handler).serve_forever()
