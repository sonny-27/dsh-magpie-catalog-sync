import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PreferenceStore } from '../lib/preferences.mjs';
import { buildCatalog } from '../lib/catalog.mjs';

test('per-Bot speed settings survive restart and follow chat parts without crossing Bots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-pref-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'selections.json'), stateFile = path.join(root, 'state.json');
  const c = buildCatalog({ data: [{ id: 'codex/test', reasoning_levels: ['low', 'ultra'], service_tiers: ['priority', 'ultrafast'] }] });
  const p = new PreferenceStore(file, stateFile); await p.load();
  await Promise.all([p.set({ botId: 'a', model: 'codex/test', tier: 'ultrafast', defaultEffort: 'ultra', sessionIds: ['part-a'] }, c),
    p.set({ botId: 'b', model: 'codex/test', tier: '', sessionIds: ['part-b'] }, c)]);
  assert.equal((await p.forRequest('part-a', 'codex/test')).tier, 'ultrafast');
  assert.equal((await p.forRequest('part-b', 'codex/test')).tier, '');
  await fs.writeFile(stateFile, JSON.stringify({ bots: { a: { id: 'a', model: 'magpie-sync/codex/test', segments: [{ sessionId: 'new-part-a' }] } } }));
  const restored = new PreferenceStore(file, stateFile); await restored.load();
  assert.equal((await restored.forRequest('new-part-a', 'codex/test')).tier, 'ultrafast');
  assert.equal((await restored.forRequest('new-part-a', 'codex/test')).defaultEffort, 'ultra');
  await restored.set({ botId: 'a', model: 'codex/test', tier: 'priority' }, c);
  assert.equal((await restored.forRequest('new-part-a', 'codex/test')).defaultEffort, 'ultra');
  assert.equal((await restored.forRequest('part-b', 'codex/test')).tier, '');
});
