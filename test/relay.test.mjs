import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildCatalog } from '../lib/catalog.mjs';
import { createRelay } from '../lib/relay.mjs';

test('streams SSE, injects advertised speed, preserves effort, and blocks unauthenticated/admin requests', async t => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    seen.push({ path: req.url, body: JSON.parse(text), authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    setTimeout(() => res.end('data: {"type":"response.completed"}\n\n'), 20);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const catalog = buildCatalog({ data: [{ id: 'codex/test', reasoning_levels: ['low', 'high'], service_tiers: [{ id: 'priority', name: 'Fast' }] }] });
  const relay = await createRelay({ getKey: async () => 'test-only-key', getBaseURL: () => `http://127.0.0.1:${upstream.address().port}/v1`, getCatalog: () => catalog,
    getPreference: async session => session === 'bot-a' ? { tier: 'priority' } : undefined });
  t.after(() => relay.close());
  assert.equal((await fetch(relay.baseURL + '/models')).status, 401);
  assert.equal((await fetch(relay.baseURL + '/models', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  const headers = { authorization: 'Bearer test-only-key', 'content-type': 'application/json' };
  assert.equal((await fetch(relay.baseURL + '/magpie/trace', { method: 'POST', headers, body: '{}' })).status, 404);
  const response = await fetch(relay.baseURL + '/responses', { method: 'POST', headers: { ...headers, 'x-magpie-sync-session-id': 'bot-a' },
    body: JSON.stringify({ model: 'codex/test', input: 'hello', reasoning: { effort: 'low' }, stream: true }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /event-stream/);
  assert.match(await response.text(), /response.completed/);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].body.reasoning, { effort: 'low' });
  assert.equal(seen[0].body.service_tier, 'priority');
  assert.equal(seen[0].body.model, 'codex/test');
  assert.equal(seen[0].authorization, 'Bearer test-only-key');
});
