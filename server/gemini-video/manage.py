"""Run with docker exec; session values come from a protected file, not argv."""
import json
import pathlib
import sys
import urllib.request

root = pathlib.Path('/data')
file = pathlib.Path(sys.argv[1])
try:
    body = file.read_bytes()
    key = (root / 'admin.key').read_text().strip()
    request = urllib.request.Request('http://127.0.0.1:8010/admin/session', data=body,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
        print(json.dumps({'state': result['state'], 'configured': result['configured']}))
    except Exception:
        print(json.dumps({'state': 'needs_login', 'error': '网页会话验证失败，请重新获取独立会话的 Cookie'}))
        sys.exit(1)
finally:
    file.unlink(missing_ok=True)
