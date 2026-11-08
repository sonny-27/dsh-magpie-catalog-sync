import test from 'node:test';
import assert from 'node:assert/strict';
import { videoFiles, rewriteVideoFiles } from '../lib/video-files.mjs';
import { GatewayTools } from '../lib/gateway-tools.mjs';
import { createRelay } from '../lib/relay.mjs';

test('video discovery trusts the advertised video enum instead of chat model names', async () => {
  const bridge = new GatewayTools({ getConnection: async () => ({ baseURL: 'https://gateway.example/v1', key: 'fixture-key' }), getConfig: () => ({}), fetchImpl: async url => Response.json({ result: { tools: url.endsWith('/image') ? [
    { name: 'generate_image', inputSchema: { properties: { model: { enum: ['test/gemini-image'] } } } },
    { name: 'generate_video', inputSchema: { properties: { model: { enum: ['gemini-web/gemini-web-video'] } } } },
  ] : [{ name: 'web_search' }] } }) });
  const result = await bridge.discover();
  assert.deepEqual(result.videoModels, ['gemini-web/gemini-web-video']);
  assert.deepEqual(result.imageModels, ['test/gemini-image']);
  assert.equal(result.videoAvailable, true);
});

test('video links are file-scoped, expire, and cannot survive a connection or key change', () => {
  let clock = 100000;
  const files = videoFiles({ getBaseURL: () => 'http://127.0.0.1:1234', now: () => clock });
  const connection = { baseURL: 'https://gateway.example/v1', key: 'fixture-upstream-key' };
  const link = new URL(files.issue('video_fixture.job.1.keymark', connection));
  assert.equal(files.verify(link, connection), 'video_fixture.job.1.keymark');
  assert.equal(files.verify(link, { ...connection, key: 'changed' }), undefined);
  assert.equal(files.verify(link, { ...connection, baseURL: 'https://another.example/v1' }), undefined);
  assert.ok(!link.href.includes(connection.key));
  const altered = new URL(link); altered.pathname = altered.pathname.replace('fixture', 'other');
  assert.equal(files.verify(altered, connection), undefined);
  clock += 3601000;
  assert.equal(files.verify(link, connection), undefined);
});

test('only same-gateway video download URLs are rewritten, leaving image and foreign files intact', () => {
  const connection = { baseURL: 'https://gateway.example/v1', key: 'fixture-upstream-key' };
  const files = videoFiles({ getBaseURL: () => 'http://127.0.0.1:1234' });
  const url = 'https://gateway.example/v1/videos/video_fixture/content';
  const data = { result: { content: [{ type: 'text', text: 'Download ' + url }], _meta: { 'usemagpie.ai/files': [{ url }, { url: 'https://other.example/v1/videos/video_other/content' }, { url: 'https://gateway.example/mcp/magpie/image/files/image.png?t=fixture' }] } } };
  rewriteVideoFiles(data, connection, files);
  assert.match(data.result._meta['usemagpie.ai/files'][0].url, /^http:\/\/127\.0\.0\.1:1234\/mcp\/magpie\/video\/files\//);
  assert.ok(data.result.content[0].text.includes(data.result._meta['usemagpie.ai/files'][0].url));
  assert.equal(data.result._meta['usemagpie.ai/files'][1].url, 'https://other.example/v1/videos/video_other/content');
});

test('video relay converts first frame and references together, polls once, and streams an authenticated MP4 with a scoped link', async t => {
  const config = { imageEnabled: false, videoEnabled: true }, model = 'gemini-web/gemini-web-video';
  const connection = { baseURL: 'https://gateway.example/v1', key: 'fixture-upstream-key', config };
  const sent = [], normalized = [];
  const upstream = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-upstream-key');
    if (url.endsWith('/content')) return new Response('fixture-video-bytes', { headers: { 'content-type': 'video/mp4' } });
    const body = JSON.parse(options.body); sent.push(body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [
      { name: 'generate_video', description: 'Upstream description.', inputSchema: { properties: { model: { enum: [model, 'other/video'] }, image: { type: 'string', description: 'First frame.' }, reference_images: { type: 'array', description: 'References.' } } } }, { name: 'generation_result' },
    ] } : body.params.name === 'generate_video' ? { _meta: { 'usemagpie.ai/pending': 'video_fixture' } } : {
      content: [{ type: 'text', text: 'https://gateway.example/v1/videos/video_fixture/content' }], _meta: { 'usemagpie.ai/files': [{ url: 'https://gateway.example/v1/videos/video_fixture/content' }] },
    } });
  };
  const bridge = new GatewayTools({ getConfig: () => config, fetchImpl: upstream,
    resolveReferenceImages: async references => { normalized.push(references); return references.map((_x, i) => 'data:image/png;base64,' + (i ? 'c2Vjb25k' : 'Zmlyc3Q=')); } });
  const relay = await createRelay({ getConnection: async () => connection, toolsBridge: bridge, getToolToken: async () => 'fixture-tool-token', getImageModels: () => [], getVideoModels: () => [model], fetchImpl: upstream });
  t.after(() => relay.close());
  const call = async (method, params) => (await fetch(relay.baseURL.replace(/\/v1$/, '') + '/mcp/magpie/image', { method: 'POST', headers: { authorization: 'Bearer fixture-tool-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture', method, params }) })).json();
  const list = await call('tools/list', {});
  assert.deepEqual(list.result.tools[0].inputSchema.properties.model.enum, [model]);
  assert.ok(list.result.tools[0].description.startsWith('Upstream description.'));
  const pending = await call('tools/call', { name: 'generate_video', arguments: { prompt: 'test', image: 'first.png', reference_images: ['second.png'] } });
  assert.equal(pending.result._meta['usemagpie.ai/pending'], 'video_fixture');
  assert.deepEqual(normalized, [['first.png', 'second.png']]);
  assert.equal(sent.at(-1).params.name, 'generate_video');
  assert.equal(sent.at(-1).params.arguments.model, model);
  assert.ok(sent.at(-1).params.arguments.image.startsWith('data:image/'));
  const result = await call('tools/call', { name: 'generation_result', arguments: { id: 'video_fixture' } });
  const link = result.result._meta['usemagpie.ai/files'][0].url;
  const download = await fetch(link);
  assert.equal(download.status, 200); assert.equal(await download.text(), 'fixture-video-bytes');
  const bad = new URL(link); bad.searchParams.set('signature', 'a'.repeat(64));
  assert.equal((await fetch(bad)).status, 403);
  assert.equal(sent.filter(x => x.params?.name === 'generate_video').length, 1);
  config.videoEnabled = false;
  config.imageEnabled = true;
  assert.equal((await call('tools/list', {})).result.tools.some(x => x.name === 'generate_video'), false);
});
