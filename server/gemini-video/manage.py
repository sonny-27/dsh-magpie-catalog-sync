"""Run with docker exec; session values never go in argv or output."""
import json
import pathlib
import sys
import urllib.request

root = pathlib.Path('/data')
command = sys.argv[1] if len(sys.argv) > 1 else 'browser-status'
file = None
if command in ['browser-start', 'browser-status']:
    path = '/admin/browser/start' if command == 'browser-start' else '/admin/browser/status'
    body = b'{}' if command == 'browser-start' else None
elif command == 'accounts-list':
    path, body = '/admin/accounts', None
elif command in ['accounts-add', 'accounts-update', 'accounts-settings']:
    path = '/admin/accounts/' + command.removeprefix('accounts-')
    body = sys.stdin.buffer.read(32769)
    if len(body) > 32768:
        raise ValueError('Account request too large')
else:
    file = pathlib.Path(command)
    path = '/admin/session'
    body = file.read_bytes()
try:
    key = (root / 'admin.key').read_text().strip()
    request = urllib.request.Request('http://127.0.0.1:8010' + path, data=body,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
        print(json.dumps(result if command in ['browser-start', 'browser-status'] or command.startswith('accounts-') else {'state': result['state'], 'configured': result['configured']}))
    except Exception:
        print(json.dumps({'state': 'needs_login', 'error': '尚未完成网页会话授权，请在专用浏览器中登录'}))
        sys.exit(1)
finally:
    if file:
        file.unlink(missing_ok=True)
