import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogSync } from '../lib/controller.mjs';

test('imports credentials once, syncs through settings, avoids no-op writes, preserves cache on outage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-sync-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ upstream: 'https://magpie.example.com' }));
  await fs.writeFile(path.join(root, 'bootstrap.key'), 'private-test-only-key');
  const keys = new Map(); let writes = 0, offline = false;
  const section = { ns: 'llm-pi-ai', revision: 1, value: { providers: { unrelated: { models: ['untouched'] } } } };
  const settings = { describe: () => [structuredClone(section)], mutate: async (_ns, ops, revision) => {
    assert.equal(revision, section.revision);
    for (const op of ops) section.value.providers[op.path[1]] = structuredClone(op.value);
    writes++; section.revision++;
  } };
  const credentials = { resolve: async ref => keys.has(ref) ? { value: keys.get(ref) } : undefined, set: async (ref, value) => keys.set(ref, value) };
  const controller = new CatalogSync({ root, settings, credentials, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer private-test-only-key');
    if (offline) throw new Error('network failed');
    return Response.json({ data: [{ id: 'qwen/local', reasoning_levels: ['none', 'low', 'medium', 'xhigh'], context_window: 262144 }] });
  } });
  t.after(() => controller.close());
  await controller.start();
  assert.equal(controller.status().state, 'ready');
  assert.equal(writes, 1);
  assert.deepEqual(section.value.providers['magpie-sync'].models[0].reasoningEfforts, { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' });
  assert.deepEqual(section.value.providers.unrelated, { models: ['untouched'] });
  assert.equal(await fs.stat(path.join(root, 'bootstrap.key')).catch(e => e.code), 'ENOENT');
  await controller.sync(); assert.equal(writes, 1);
  offline = true; await controller.sync();
  assert.equal(controller.status().state, 'stale'); assert.equal(writes, 1);
  assert.equal(JSON.stringify(controller.status()).includes('private-test-only-key'), false);
  assert.equal((await fs.readFile(path.join(root, 'catalog.json'), 'utf8')).includes('private-test-only-key'), false);
});

test('referenced legacy IDs migrate without losing speed/defaults, then disappear from the SDK directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-migration-test-'));
  const stateFile = path.join(root, 'bot-state.json');
  const legacy = 'codex/test~magpie-sync~effort=ultra&tier=priority';
  await fs.writeFile(stateFile, JSON.stringify({ bots: { a: { id: 'a', model: 'magpie-sync/' + legacy, effort: 'low' } } }));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ upstream: 'https://magpie.example.com', botStatePath: stateFile }));
  const section = { ns: 'llm-pi-ai', revision: 1, value: { providers: {} } };
  const settings = { describe: () => [structuredClone(section)], mutate: async (_ns, ops) => {
    section.value.providers[ops[0].path[1]] = structuredClone(ops[0].value); section.revision++;
  } };
  const controller = new CatalogSync({ root, settings, credentials: { resolve: async () => ({ value: 'test-key' }) },
    fetchImpl: async () => Response.json({ data: [{ id: 'codex/test', reasoning_levels: ['low', 'high', 'ultra'], service_tiers: ['priority'] }] }) });
  t.after(async () => { await controller.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  await controller.start();
  assert.equal(controller.catalog.models.length, 1);
  assert.equal(section.value.providers['magpie-sync'].models.length, 2);
  assert.equal((await controller.preferences.forRequest('a', 'codex/test')).tier, 'priority');
  assert.equal((await controller.preferences.forRequest('a', 'codex/test')).defaultEffort, 'ultra');
  await fs.writeFile(stateFile, JSON.stringify({ bots: { a: { id: 'a', model: 'magpie-sync/codex/test', effort: 'low' } } }));
  await controller.reconcile();
  assert.equal(section.value.providers['magpie-sync'].models.length, 1);
  assert.equal(controller.controls().compatibilityEntries, 0);
  assert.equal((await controller.preferences.forRequest('a', 'codex/test')).defaultEffort, 'ultra');
});
