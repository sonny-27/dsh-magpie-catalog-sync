"""Host-side provisioning of isolated browser slots. Never mount Docker into the API."""
import copy
import json
import os
import pathlib
import re
import subprocess
import sys


def provision(root, identity):
    root = pathlib.Path(root).resolve()
    if not re.fullmatch(r'(?:primary|a[0-9a-f]{8})', identity):
        raise ValueError('Invalid account ID')
    data = json.loads((root / 'data/accounts.json').read_text())
    rows = data.get('accounts', [])
    if identity not in [row.get('id') for row in rows]:
        raise ValueError('Unknown account')
    base = root / 'compose.yaml'
    config = json.loads(subprocess.check_output(['docker', 'compose', '-f', str(base), 'config', '--format', 'json']))
    template = config['services']['gemini-browser']
    services = {}
    profiles = root / 'browser-profiles'
    profiles.mkdir(exist_ok=True, mode=0o700)
    for row in rows:
        key = row.get('id', '')
        if key == 'primary':
            continue
        if not re.fullmatch(r'a[0-9a-f]{8}', key):
            raise ValueError('Invalid stored account ID')
        directory = profiles / key
        if directory.is_symlink() or directory.resolve().parent != profiles.resolve():
            raise ValueError('Invalid browser profile directory')
        if not directory.exists():
            directory.mkdir(mode=0o700)
            os.chown(directory, 10001, 10001)
        item = copy.deepcopy(template)
        item['container_name'] = 'magpie-gemini-browser-' + key
        item['volumes'] = [{'type': 'bind', 'source': str(directory), 'target': '/config', 'bind': {'create_host_path': False}}]
        item.pop('ports', None)
        item.setdefault('environment', {})['CHROMIUM_CUSTOM_ARGS'] = template['environment']['CHROMIUM_CUSTOM_ARGS'] + ' --no-first-run --no-default-browser-check'
        services['gemini-browser-' + key] = item
    override = root / 'accounts.compose.json'
    temporary = override.with_suffix('.tmp')
    temporary.write_text(json.dumps({'services': services}, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(override)
    service = 'gemini-browser' if identity == 'primary' else 'gemini-browser-' + identity
    command = ['docker', 'compose', '-f', str(base), '-f', str(override), 'up', '-d', '--no-deps', service]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Browser slot could not start')
    return {'provisioned': True, 'account': identity, 'service': service}


if __name__ == '__main__':
    try:
        import fcntl
        lock = pathlib.Path(sys.argv[1]).resolve() / 'accounts-provision.lock'
        with lock.open('a') as handle:
            lock.chmod(0o600)
            fcntl.flock(handle, fcntl.LOCK_EX)
            print(json.dumps(provision(sys.argv[1], sys.argv[2])))
    except Exception:
        print(json.dumps({'provisioned': False, 'error': '浏览器账号窗口尚未启动，请检查部署配置后重试'}))
        sys.exit(1)
