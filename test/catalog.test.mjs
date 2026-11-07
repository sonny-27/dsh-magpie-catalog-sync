import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, normalizeBaseURL, rewriteRequest, parseLegacyModel } from '../lib/catalog.mjs';
const listing = { data: [{ id: 'codex/test', name: 'GPT Test', reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  service_tiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultra Fast' }] },
{ id: 'qwen/local', context_window: 262144, modalities: { input: ['text', 'image'] }, reasoning_levels: ['none', 'low', 'medium', 'xhigh'] }] };

test('one model remains one entry, regardless of speeds or unsupported reasoning levels', () => {
  const c = buildCatalog(listing);
  assert.equal(c.models.length, 2); assert.equal(c.mapping.size, 2);
  assert.deepEqual(c.models.map(x => x.id), ['codex/test', 'qwen/local']);
  assert.deepEqual(c.models[1].reasoningEfforts, { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' });
  assert.deepEqual(c.models[1].input, ['text', 'image']);
  assert.equal(c.models[1].contextWindow, 262144);
});

test('speed preferences change service_tier while keeping model and reasoning unchanged', () => {
  const c = buildCatalog(listing);
  for (const tier of ['priority', 'ultrafast']) {
    const r = rewriteRequest({ model: 'codex/test', reasoning: { effort: 'medium' } }, '/v1/responses', c.mapping, { tier });
    assert.equal(r.body.model, 'codex/test'); assert.equal(r.body.service_tier, tier);
    assert.equal(r.body.reasoning.effort, 'medium');
  }
  const normal = rewriteRequest({ model: 'codex/test', service_tier: 'priority' }, '/v1/responses', c.mapping, { tier: '' });
  assert.equal(normal.body.service_tier, undefined);
  assert.throws(() => rewriteRequest({ model: 'qwen/local' }, '/v1/responses', c.mapping, { tier: 'ultrafast' }), /不可用/);
});

test('a shared total context limit never becomes a completion reserve with zero message budget', () => {
  const catalog = buildCatalog({ data: [
    { id: 'qwen/shared', context_window: 262144, max_output_tokens: 262144 },
    { id: 'other/excessive', context_window: 65536, max_output_tokens: 131072 },
    { id: 'other/valid', context_window: 262144, max_output_tokens: 65536 },
  ] });
  assert.equal(catalog.models[0].contextWindow, 262144);
  assert.equal(catalog.models[0].maxTokens, 32768);
  assert.equal(catalog.models[0].contextWindow - catalog.models[0].maxTokens, 229376);
  assert.equal(catalog.records[0].advertisedMaxTokens, 262144);
  assert.equal(catalog.records[0].completionBudgetAdjusted, true);
  assert.equal(catalog.models[1].maxTokens, 8192);
  assert.equal(catalog.models[2].maxTokens, 65536);
});

test('legacy IDs are accepted privately for migration and never published as extra models', () => {
  const c = buildCatalog(listing), id = 'codex/test~magpie-sync~effort=ultra&tier=priority';
  const legacy = parseLegacyModel(id, c.mapping);
  assert.equal(legacy.canonical, 'codex/test'); assert.equal(legacy.legacy, true);
  assert.equal(c.models.some(x => x.id === id), false);
  const d = rewriteRequest({ model: id, reasoning: { summary: 'auto' } }, '/v1/responses', c.mapping);
  assert.equal(d.body.reasoning.effort, 'ultra');
  const explicit = rewriteRequest({ model: id, reasoning: { effort: 'low' } }, '/v1/responses', c.mapping);
  assert.equal(explicit.body.reasoning.effort, 'low');
  assert.equal(parseLegacyModel('qwen/local~magpie-sync~tier=priority', c.mapping), undefined);
});

test('verified tier metadata only augments named models', () => {
  const c = buildCatalog({ data: [{ id: 'codex/a', service_tiers: ['priority'] }, { id: 'codex/b', service_tiers: ['priority'] }] },
    { serviceTierOverrides: { 'codex/a': [{ id: 'ultrafast', name: 'Ultra Fast' }] } });
  assert.deepEqual(c.records[0].serviceTiers.map(x => x.id), ['priority', 'ultrafast']);
  assert.deepEqual(c.records[1].serviceTiers.map(x => x.id), ['priority']);
  assert.equal(c.models.length, 2);
});

test('refuses empty/malformed discovery and credential-bearing URLs', () => {
  assert.throws(() => buildCatalog({ data: [] }), /空/);
  assert.throws(() => buildCatalog({ models: [] }), /data/);
  assert.equal(normalizeBaseURL('https://api.example.com:18443/'), 'https://api.example.com:18443/v1');
  assert.throws(() => normalizeBaseURL('https://key@example.com/v1'));
});
