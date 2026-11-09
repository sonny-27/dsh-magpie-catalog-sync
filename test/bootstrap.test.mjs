import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MagpieSubscription } from '../lib/subscription.mjs';
import { subscriptionRoutes } from '../lib/settings-api.mjs';

const testKey = 'fixture-only-gateway-key';
async function fixture(t, config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-bootstrap-test-'));
  const keys = new Map(), requests = [];
  const sections = [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }, { ns: 'web', revision: 1, value: {} }];
  if (config) await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const options = { root,
    settings: { describe: () => structuredClone(sections), mutate: async (ns, ops) => {
      const section = sections.find(x => x.ns === ns);
      for (const op of ops) { let value = section.value; for (const key of op.path.slice(0, -1)) value = value[key] ??= {}; value[op.path.at(-1)] = op.value; }
      section.revision++;
    } },
    credentials: { resolve: async ref => keys.has(ref) ? { value: keys.get(ref) } : undefined, set: async (ref, value) => keys.set(ref, value) },
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      if (options.headers.authorization !== 'Bearer ' + testKey) return Response.json({ error: 'rejected' }, { status: 401 });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen/local', context_window: 262144, max_output_tokens: 65536 }] });
      if (url.endsWith('/mcp/magpie/image')) return Response.json({ result: { tools: [{ name: 'generate_image', inputSchema: { properties: { model: { enum: ['openai/gpt-image-2'] } } } }] } });
      if (url.endsWith('/mcp/magpie/web-search')) return Response.json({ result: { tools: [{ name: 'web_search' }, { name: 'web_fetch' }] } });
      return Response.json({ status: 'completed', output: [] });
    },
  };
  let controller = new MagpieSubscription(options);
  const call = async (endpoint, body) => {
    const route = subscriptionRoutes(controller).find(x => x.path.endsWith('-' + endpoint));
    const response = await route.fetch(new Request('http://localhost' + route.path, { method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }));
    return { status: response.status, value: await response.json() };
  };
  t.after(async () => {
    await controller.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('magpie-bootstrap-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, keys, requests, sections, call, get controller() { return controller; },
    restart: async () => { await controller.close(); controller = new MagpieSubscription(options); await controller.start(); } };
}

test('URL-only install can open GUI and save its first key without a relay or app restart', async t => {
  const f = await fixture(t, { upstream: 'https://gateway.example/v1' });
  await Promise.all([f.controller.start(), f.controller.start()]);
  assert.equal(f.controller.state.state, 'needs_configuration');
  assert.equal(f.controller.relay, undefined);
  assert.equal(f.requests.length, 0);
  let result = await f.call('settings');
  assert.equal(result.status, 200);
  assert.equal(result.value.keyConfigured, false);
  assert.deepEqual(result.value.status.configurationRequired, ['apiKey']);
  result = await f.call('bindings');
  assert.equal(result.status, 200);
  assert.equal(result.value.pendingConfiguration, true);
  assert.equal(result.value.capability, undefined);
  result = await f.call('save', { autoSyncEnabled: false, pollSeconds: 600 });
  assert.equal(result.status, 200);
  assert.equal(result.value.status.state, 'needs_configuration');
  result = await f.call('connect', { upstream: 'https://gateway.example/v1', apiKey: '' });
  assert.equal(result.status, 400);
  assert.match(result.value.error, /请填写.*Key/);
  assert.equal(f.requests.length, 0);
  result = await f.call('connect', { upstream: 'https://gateway.example/v1', apiKey: 'invalid-fixture-key' });
  assert.equal(result.status, 400);
  assert.match(result.value.error, /HTTP 401/);
  assert.equal(f.keys.size, 0);
  assert.equal(f.controller.relay, undefined);
  result = await f.call('connect', { upstream: 'https://gateway.example/v1', apiKey: testKey });
  assert.equal(result.status, 200);
  assert.equal(result.value.keyConfigured, true);
  assert.equal(result.value.status.state, 'paused');
  assert.equal(result.value.status.modelCount, 1);
  assert.equal(f.keys.get('MAGPIE_CATALOG_SYNC_KEY'), testKey);
  assert.equal(f.sections[0].value.providers['magpie-sync'].models[0].maxTokens, 65536);
  assert.equal((await fetch(f.controller.relay.baseURL + '/models')).status, 401);
  assert.equal((await fetch(f.controller.relay.baseURL + '/models', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fetch(f.controller.relay.baseURL + '/models', { headers: { authorization: 'Bearer ' + testKey } })).status, 200);
  assert.equal(JSON.stringify(result.value).includes(testKey), false);
  assert.equal(JSON.stringify(result.value).includes(f.controller.toolToken), false);
  assert.equal((await fs.readFile(path.join(f.root, 'config.json'), 'utf8')).includes(testKey), false);
  const count = f.requests.length;
  await f.restart();
  assert.equal(f.controller.state.state, 'paused');
  assert.equal(f.requests.length, count);
  assert.equal((await f.call('settings')).value.keyConfigured, true);
});

test('a completely fresh install exposes setup before start and creates one relay after saving connection', async t => {
  const f = await fixture(t);
  const result = await f.call('settings');
  assert.equal(result.status, 200);
  assert.equal(result.value.upstream, '');
  assert.deepEqual(result.value.status.configurationRequired, ['upstream', 'apiKey']);
  assert.equal(f.controller.relay, undefined);
  assert.equal(f.requests.length, 0);
  const connected = await f.call('connect', { upstream: 'https://gateway.example/v1', apiKey: testKey });
  assert.equal(connected.status, 200);
  assert.equal(connected.value.status.state, 'ready');
  assert.ok(f.controller.timer && !f.controller.timer._destroyed);
  const relay = f.controller.relay;
  await f.controller.start();
  assert.equal(f.controller.relay, relay);
  assert.equal((await f.call('connect', { upstream: 'https://gateway.example/v1', apiKey: '' })).status, 200);
  assert.equal(f.controller.relay, relay);
});

test('losing a saved key leaves setup accessible and does not reactivate cached image tools', async t => {
  const f = await fixture(t, { upstream: 'https://gateway.example/v1' });
  await f.controller.start();
  assert.equal((await f.call('connect', { apiKey: testKey })).status, 200);
  const count = f.requests.length;
  f.keys.clear();
  await f.restart();
  assert.equal(f.controller.state.state, 'needs_configuration');
  assert.equal(f.controller.relay, undefined);
  assert.equal(f.requests.length, count);
  assert.equal((await f.call('settings')).status, 200);
  assert.equal((await f.call('bindings')).value.pendingConfiguration, true);
  assert.equal((await f.call('sync', {})).value.status.state, 'needs_configuration');
  assert.equal((await f.call('search-policy')).status, 400);
  assert.equal(f.requests.length, count);
});

test('installer accepts a fresh profile without upstream or key file for GUI setup', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-installer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('magpie-installer-test-'));
    await fs.rm(home, { recursive: true, force: true });
  });
  const profile = path.join(home, 'profiles', 'test');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', private: true }));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/install-local.mjs', import.meta.url)), '--home', home, '--profile', 'test']);
  const root = path.join(home, 'dsh-magpie-catalog-sync', 'test');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).upstream, '');
  assert.equal(await fs.stat(path.join(root, 'bootstrap.key')).catch(error => error.code), 'ENOENT');
  const manifest = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-magpie-catalog-sync'));
});

test('installer copies video source without packaging private account data or Python caches', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-secret-installer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('magpie-secret-installer-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'), home = path.join(root, 'home'), profile = path.join(home, 'profiles', 'test');
  await fs.mkdir(source); await fs.mkdir(profile, { recursive: true });
  const original = fileURLToPath(new URL('..', import.meta.url));
  for (const item of ['package.json', 'index.mjs', 'client.js', 'client.mjs', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib']) await fs.cp(path.join(original, item), path.join(source, item), { recursive: true });
  await fs.mkdir(path.join(source, 'scripts'));
  await fs.copyFile(path.join(original, 'scripts/install-local.mjs'), path.join(source, 'scripts/install-local.mjs'));
  for (const item of ['server/gemini-video/data/account.json', 'server/gemini-video/data/api.key', 'server/gemini-video/browser-profile/chromium/Default/Cookies', 'server/gemini-video/__pycache__/bridge.pyc', 'server/gemini-video/bridge.py']) {
    const file = path.join(source, item); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, item.endsWith('bridge.py') ? '# fixture bridge source' : 'FAKE_PRIVATE_RUNTIME_SENTINEL');
  }
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', private: true }));
  const result = await promisify(execFile)(process.execPath, [path.join(source, 'scripts/install-local.mjs'), '--home', home, '--profile', 'test']);
  const installed = JSON.parse(result.stdout).packageDir;
  assert.equal(await fs.readFile(path.join(installed, 'server/gemini-video/bridge.py'), 'utf8'), '# fixture bridge source');
  assert.equal(await fs.stat(path.join(installed, 'server/gemini-video/data')).catch(error => error.code), 'ENOENT');
  assert.equal(await fs.stat(path.join(installed, 'server/gemini-video/browser-profile')).catch(error => error.code), 'ENOENT');
  assert.equal(await fs.stat(path.join(installed, 'server/gemini-video/__pycache__')).catch(error => error.code), 'ENOENT');
});
