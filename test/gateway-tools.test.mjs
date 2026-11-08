import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayTools, mapSearchContent } from '../lib/gateway-tools.mjs';
import { createRelay } from '../lib/relay.mjs';

test('native numbered and structured search results become web sources', () => {
  assert.deepEqual(mapSearchContent({ content: [{ type: 'text', text: '1. Example — https://example.com/\nExample snippet\n-------------------\n2. Other — https://example.org/\nOther snippet' }] }).sources.map(x => [x.title, x.url]), [['Example', 'https://example.com/'], ['Other', 'https://example.org/']]);
  assert.equal(mapSearchContent({ structuredContent: { results: [{ url: 'https://example.com', content: 'Snippet' }] } }).sources[0].snippet, 'Snippet');
});

test('image relay authenticates local tools separately, forwards one upstream key and enforces model versions', async t => {
  const config = { imageEnabled: true, defaultImageProvider: 'gemini' };
  const models = ['codex/gpt-image-2', 'antigravity/gemini-3.1-flash-image'];
  const connection = { baseURL: 'https://gateway.example/v1', key: 'private-upstream-test-key', config };
  const sent = [];
  const bridge = new GatewayTools({ getConnection: async () => connection, getConfig: () => config, fetchImpl: async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer private-upstream-test-key'); assert.equal(url, 'https://gateway.example/mcp/magpie/image');
    const body = JSON.parse(options.body); sent.push(body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [{ name: 'generate_image', description: 'Draw', inputSchema: { properties: { model: { enum: [...models, 'other/unsupported'] } } } }, { name: 'generate_video' }, { name: 'generation_result' }] } : { content: [{ type: 'text', text: 'ok' }] } });
  } });
  const relay = await createRelay({ getConnection: async () => connection, getCatalog: () => undefined, toolsBridge: bridge, getToolToken: async () => 'local-tool-test-token', getImageModels: () => models });
  t.after(() => relay.close());
  const url = relay.baseURL.replace(/\/v1$/, '') + '/mcp/magpie/image?rev=test';
  const call = (key, method, params) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }) });
  assert.equal((await call(connection.key, 'tools/list', {})).status, 401);
  const list = await (await call('local-tool-test-token', 'tools/list', {})).json();
  assert.deepEqual(list.result.tools.map(x => x.name), ['generate_image', 'edit_image', 'generation_result']);
  assert.ok(list.result.tools[0].description.startsWith('Draw'));
  assert.ok(list.result.tools[1].inputSchema.required.includes('reference_images'));
  assert.equal(list.result.tools[1].inputSchema.properties.reference_images.minItems, 1);
  assert.equal(list.result.tools[0].inputSchema.properties.reference_images.minItems, undefined);
  assert.deepEqual(list.result.tools[0].inputSchema.properties.model.enum, models);
  assert.equal(list.result.tools[0].inputSchema.properties.model.default, models[1]);
  assert.equal((await call('local-tool-test-token', 'tools/call', { name: 'generate_image', arguments: { prompt: 'test' } })).status, 200);
  assert.equal(sent.at(-1).params.arguments.model, models[1]);
  assert.equal((await call('local-tool-test-token', 'tools/call', { name: 'generate_image', arguments: { prompt: 'test', model: 'other/unsupported' } })).status, 502);
  config.imageEnabled = false;
  assert.equal((await call('local-tool-test-token', 'tools/list', {})).status, 403);
});

test('web search and fetch use the same connection and honor the search switch', async () => {
  const config = { searchEnabled: true };
  const bridge = new GatewayTools({ getConnection: async () => ({ baseURL: 'https://gateway.example/v1', key: 'one-test-key' }), getConfig: () => config,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://gateway.example/mcp/magpie/web-search'); assert.equal(options.headers.authorization, 'Bearer one-test-key');
      const req = JSON.parse(options.body);
      return Response.json({ result: { content: [{ type: 'text', text: req.params.name === 'web_search' ? '1. Example — https://example.com\nExample source' : 'Example page' }] } });
    } });
  assert.equal((await bridge.search({ query: 'test' })).sources.length, 1);
  assert.equal((await bridge.fetch({ url: 'https://example.com' })).body.content, 'Example page');
  config.searchEnabled = false; await assert.rejects(() => bridge.search({ query: 'test' }), /关闭/);
});
