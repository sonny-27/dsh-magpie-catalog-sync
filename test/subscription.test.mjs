import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MagpieSubscription } from '../lib/subscription.mjs';

test('GUI settings persist across restart, paused subscriptions stay offline, and saved secrets never enter the GUI view', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-subscription-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('magpie-subscription-test-')); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ upstream: 'https://gateway.example/v1' }));
  const sections = [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }, { ns: 'web', revision: 1, value: { searchProvider: 'previous', fetchProvider: 'local', otherSetting: true } }];
  const settings = { describe: () => structuredClone(sections), mutate: async (ns, ops) => { const section = sections.find(x => x.ns === ns); for (const op of ops) { let obj = section.value; for (const key of op.path.slice(0, -1)) obj = obj[key] ??= {}; obj[op.path.at(-1)] = op.value; } section.revision++; } };
  let requests = 0;
  const credentials = { resolve: async () => ({ value: 'private-gateway-test-secret' }) };
  const fetchImpl = async (url, options) => {
    requests++; assert.equal(options.headers.authorization, 'Bearer private-gateway-test-secret');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'codex/test', context_window: 10000 }] });
    if (url.endsWith('/mcp/magpie/image')) return Response.json({ result: { tools: [{ name: 'generate_image', inputSchema: { properties: { model: { enum: ['codex/gpt-image-2', 'antigravity/gemini-image'] } } } }] } });
    return Response.json({ result: { tools: [{ name: 'web_search' }, { name: 'web_fetch' }] } });
  };
  let sync = new MagpieSubscription({ root, settings, credentials, fetchImpl });
  t.after(() => sync.close());
  await sync.start();
  assert.equal(sections[1].value.searchProvider, 'magpie-gateway'); assert.equal(sections[1].value.otherSetting, true);
  await sync.updateSettings({ autoSyncEnabled: false, defaultImageProvider: 'gemini', pollSeconds: 600, geminiImageModel: 'antigravity/gemini-image', imageScope: 'all' });
  const view = await sync.settingsView();
  assert.equal(view.selectedImageModel, 'antigravity/gemini-image'); assert.equal(sync.timer?._destroyed, true);
  assert.equal(JSON.stringify(view).includes('private-gateway-test-secret'), false); assert.equal(JSON.stringify(view).includes(sync.toolToken), false);
  await assert.rejects(() => sync.updateConnection({ upstream: 'https://different.example/v1' }), /同时填写/);
  assert.equal(sync.config.upstream, 'https://gateway.example/v1');
  const count = requests, token = sync.toolToken;
  await sync.close();
  sync = new MagpieSubscription({ root, settings, credentials, fetchImpl }); await sync.start();
  assert.equal(requests, count); assert.equal(sync.state.state, 'paused'); assert.equal(sync.toolToken, token);
  assert.equal((await sync.settingsView()).selectedImageModel, 'antigravity/gemini-image');
  await sync.sync(); assert.ok(requests > count); assert.equal(sync.state.state, 'paused');
});
