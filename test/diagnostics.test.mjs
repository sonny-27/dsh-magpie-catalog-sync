import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics } from '../lib/diagnostics.mjs';
import { bindingChanges } from '../lib/image-binding.mjs';

test('automatic main-Bot binding preserves manually attached image tools on other Bots', () => {
  const capability = { name: 'magpie-sync-image' };
  const state = { mainBotIds: ['chief'], bots: [{ id: 'chief', capabilities: [] }, { id: 'manual', capabilities: [capability.name] }] };
  assert.deepEqual(bindingChanges({ enabled: true, scope: 'main', capability }, state), [{ botId: 'chief', name: capability.name, attached: true }]);
  assert.deepEqual(bindingChanges({ enabled: true, scope: 'manual', capability }, state), []);
  assert.deepEqual(bindingChanges({ enabled: false, capability }, state), [{ botId: 'manual', name: capability.name, attached: false }]);
});

function fixture() {
  const counts = { generations: 0, polls: 0 };
  const c = { config: { imageEnabled: true, searchEnabled: true, defaultImageProvider: 'gpt' }, toolToken: 'fixture-local-token',
    toolCatalog: { imageModels: ['test/gpt-image-2'] }, relay: { baseURL: 'http://127.0.0.1:12345/v1' },
    ensureRelay: async () => {}, getConnection: async () => ({ baseURL: 'https://gateway.example/v1', key: 'fixture-upstream-key' }),
    gatewayTools: { rpc: async (_kind, message) => {
      if (message.method === 'tools/list') return { tools: [
        { name: 'generate_image', inputSchema: { properties: { model: { enum: ['test/gpt-image-2'] } } } }, { name: 'generation_result' }, { name: 'web_search' }, { name: 'web_fetch' },
      ] };
      if (message.params.name === 'generate_image') { counts.generations++; return { _meta: { 'usemagpie.ai/pending': 'fixture-job' } }; }
      if (message.params.name === 'generation_result') { counts.polls++; return { content: [{ type: 'image', data: 'fixture-image-data' }] }; }
      return { content: [{ type: 'text', text: '1. Example — https://example.com\nExample' }] };
    } },
  };
  const d = new Diagnostics(c, { pollMs: 1, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-local-token');
    return Response.json({ result: { tools: [{ name: 'generate_image' }] } });
  } });
  return { c, d, counts };
}

test('connection and search checks report real stages without claiming an image was generated', async () => {
  const { d, counts } = fixture();
  for (const kind of ['image', 'search']) { d.start(kind); await d.jobs.get(kind).task; assert.equal(d.view().find(x => x.kind === kind).state, 'passed'); }
  assert.equal(counts.generations, 0);
  assert.match(d.view()[0].note, /尚未执行真实出图/);
});

test('generation self-test coalesces repeated clicks and polls the original pending job', async () => {
  const { d, counts } = fixture();
  d.start('image-generate'); const task = d.jobs.get('image-generate').task;
  d.start('image-generate'); assert.equal(d.jobs.get('image-generate').task, task);
  await task;
  assert.equal(counts.generations, 1); assert.equal(counts.polls, 1);
  assert.equal(d.view()[0].state, 'passed');
  assert.equal(JSON.stringify(d.view()).includes('fixture-image-data'), false);
});

test('diagnostic errors redact credentials and URLs and identify the failed stage', async () => {
  const { c, d } = fixture();
  c.gatewayTools.rpc = async () => { throw new Error('refused fixture-upstream-key https://gateway.example/?key=private'); };
  d.start('search'); await d.jobs.get('search').task;
  const report = d.view()[0]; assert.equal(report.state, 'failed');
  assert.equal(report.stages.at(-1).name, '上游鉴权与工具发现');
  assert.equal(report.stages.at(-1).state, 'failed');
  assert.equal(JSON.stringify(report).includes('fixture-upstream-key'), false);
  assert.equal(JSON.stringify(report).includes('https://'), false);
});
