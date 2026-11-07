import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../lib/catalog.mjs';
import { identifyBot, describeSelection, selectionPayload, legacyMigration } from '../lib/ui-controls.mjs';
const c = buildCatalog({ data: [{ id: 'codex/test', reasoning_levels: ['low', 'medium', 'high', 'max', 'ultra'],
  service_tiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultra Fast' }] }] });
const controls = { providerId: 'magpie-sync', models: c.records, entries: [...c.mapping].map(([id, x]) => ({ id, ...x })), choices: [] };
const bot = { id: 'bot-a', name: 'Chief', model: 'magpie-sync/codex/test', effort: 'low', sessionId: 'part-a', parts: ['old-part'] };

test('speed payload writes a preference, not a Bot model/effort patch', () => {
  const before = structuredClone(bot), payload = selectionPayload(bot, controls, 'ultrafast');
  assert.equal(payload.botId, bot.id); assert.equal(payload.model, 'codex/test'); assert.equal(payload.tier, 'ultrafast');
  assert.deepEqual(payload.sessionIds, ['bot-a', 'part-a', 'old-part']);
  assert.equal(payload.effort, undefined); assert.equal(payload.id, undefined); assert.deepEqual(bot, before);
  const selected = describeSelection(bot, { ...controls, choices: [{ botId: bot.id, model: 'codex/test', tier: 'ultrafast' }] });
  assert.equal(selected.ref, bot.model); assert.equal(selected.effort, 'low'); assert.equal(selected.tier, 'ultrafast');
});

test('legacy migration preserves speed/default thinking and native manual effort', () => {
  const legacy = { ...bot, model: 'magpie-sync/codex/test~magpie-sync~effort=ultra&tier=priority' };
  const m = legacyMigration(legacy, controls);
  assert.equal(m.preference.tier, 'priority'); assert.equal(m.preference.defaultEffort, 'ultra');
  assert.deepEqual(m.botPatch, { id: bot.id, model: bot.model, effort: 'low' });
  assert.equal(legacyMigration(bot, controls), undefined);
  assert.equal(identifyBot('Chief 的模型', [bot]).id, bot.id);
});
