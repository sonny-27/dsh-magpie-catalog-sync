import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createReferenceImages, createHostReferenceImages } from '../lib/reference-images.mjs';
import { GatewayTools } from '../lib/gateway-tools.mjs';
import { createRelay } from '../lib/relay.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOxsAAAAASUVORK5CYII=', 'base64');
const dataURL = 'data:image/png;base64,' + png.toString('base64');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-reference-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), attachmentRoot = path.join(root, 'attachments'), outside = path.join(root, 'outside');
  for (const dir of [workspace, attachmentRoot, outside]) await fs.mkdir(dir);
  const image = path.join(workspace, 'reference.png'); await fs.writeFile(image, png);
  const hash = createHash('sha256').update(png).digest('hex'), object = path.join(attachmentRoot, 'objects', hash.slice(0, 2), hash);
  await fs.mkdir(path.dirname(object), { recursive: true }); await fs.writeFile(object, png);
  const validated = [];
  const resolve = createReferenceImages({ getRoots: async () => [workspace, attachmentRoot], getWorkingDirectory: () => workspace, attachmentRoot,
    normalizeImage: async input => { validated.push(input); return { data: input.data }; } });
  return { root, workspace, attachmentRoot, outside, image, object, hash, resolve, validated };
}

test('workspace paths, file URLs and extensionless attachment objects are validated and uploaded as image data', async t => {
  const f = await fixture(t);
  const references = [f.image, 'reference.png', pathToFileURL(f.image).href, f.object, 'sha256:' + f.hash];
  assert.deepEqual(await f.resolve(references), references.map(() => dataURL));
  assert.equal(f.validated.length, references.length);
  assert.ok(f.validated.every(x => x.mediaType === 'image/png' && x.data.equals(png)));
  assert.deepEqual(await f.resolve(['https://example.com/image.png', dataURL]), ['https://example.com/image.png', dataURL]);
});

test('invalid, missing, out-of-scope, shared, non-image and oversized files fail before upload', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, 'secret.png'), png);
  await fs.writeFile(path.join(f.workspace, 'not-image.png'), 'private-text-not-an-image');
  const large = await fs.open(path.join(f.workspace, 'large.png'), 'w'); await large.truncate(10 * 1024 * 1024 + 1); await large.close();
  for (const ref of [path.join(f.outside, 'secret.png'), '../outside/secret.png', 'missing.png', 'not-image.png', 'large.png', f.workspace,
    '\\\\server\\share\\image.png', '//server/share/image.png', 'file://server/share/image.png', '\\\\?\\C:\\image.png', 'C:relative.png', 'reference.png:secret', 'ftp://example.com/image.png', 'data:text/plain;base64,c2VjcmV0']) {
    await assert.rejects(() => f.resolve([ref]), error => error.code === 'REFERENCE_IMAGE_ERROR');
  }
  await assert.rejects(() => f.resolve(Array(17).fill(dataURL)), /最多 16/);
  await assert.rejects(() => f.resolve('reference.png'), /数组/);
  assert.equal(f.validated.length, 0);
});

test('directory junctions cannot escape the registered workspace', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, 'secret.png'), png);
  await fs.symlink(f.outside, path.join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => f.resolve(['escape/secret.png']), /工作区以外/);
  assert.equal(f.validated.length, 0);
});

test('normalization is required and its returned image bytes are used', async t => {
  const f = await fixture(t);
  const options = { getRoots: async () => [f.workspace], getWorkingDirectory: () => f.workspace };
  await assert.rejects(() => createReferenceImages(options)([f.image]), /验证服务/);
  await assert.rejects(() => createReferenceImages({ ...options, normalizeImage: async () => { throw new Error('decoder details'); } })([f.image]), /验证失败/);
  const normalized = Buffer.concat([png, Buffer.from('normalized')]);
  assert.deepEqual(await createReferenceImages({ ...options, normalizeImage: async () => ({ data: normalized }) })([f.image]), ['data:image/png;base64,' + normalized.toString('base64')]);
});

test('host resolver discovers registered workspaces and reuses the native attachment validator', async t => {
  const f = await fixture(t), home = path.join(f.root, 'home');
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({ global: { workspaceIds: ['active'] }, tables: { workspaces: {
    active: { path: f.workspace }, inactive: { path: f.outside },
  } } }));
  const calls = [];
  const store = { saveImage: async input => { calls.push(input); return { attachmentId: 'test-id' }; }, readImage: async ref => { assert.equal(ref.attachmentId, 'test-id'); return { data: png }; } };
  const resolve = createHostReferenceImages({ home, getWorkingDirectory: () => home, getAttachmentStore: () => store });
  assert.deepEqual(await resolve([f.image]), [dataURL]);
  assert.equal(calls.length, 1);
  await assert.rejects(() => resolve([path.join(f.outside, 'secret.png')]), /已登记/);
  await fs.writeFile(path.join(home, 'private.png'), png);
  await assert.rejects(() => resolve([path.join(home, 'private.png')]), /已登记/);
});

test('edit_image requires a reference, converts once, preserves pending jobs and never falls back to text generation', async t => {
  const f = await fixture(t), sent = [];
  const config = { imageEnabled: true }, model = 'codex/gpt-image-2';
  const connection = { baseURL: 'https://gateway.example/v1', key: 'upstream-test-key', config };
  const bridge = new GatewayTools({ getConfig: () => config, resolveReferenceImages: f.resolve, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'pending' }], _meta: { 'usemagpie.ai/pending': { id: 'original-job' } } } });
  } });
  const relay = await createRelay({ getConnection: async () => connection, toolsBridge: bridge, getToolToken: async () => 'local-test-key', getImageModels: () => [model] });
  t.after(() => relay.close());
  const call = async (name, args) => {
    const r = await fetch(relay.baseURL.replace(/\/v1$/, '') + '/mcp/magpie/image', { method: 'POST', headers: { authorization: 'Bearer local-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(r.status, 200); return r.json();
  };
  assert.equal((await call('edit_image', { prompt: 'change blue to red' })).result.isError, true);
  assert.equal((await call('edit_image', { prompt: 'change blue to red', reference_images: ['missing.png'] })).result.isError, true);
  assert.equal((await call('generate_image', { prompt: 'change blue to red', reference_images: ['not-found.png'] })).result.isError, true);
  assert.equal(sent.length, 0);
  const result = await call('edit_image', { prompt: 'change blue to red', reference_images: [f.object] });
  assert.equal(result.result._meta['usemagpie.ai/pending'].id, 'original-job');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.name, 'generate_image');
  assert.deepEqual(sent[0].params.arguments, { prompt: 'change blue to red', reference_images: [dataURL], model });
  await call('generation_result', { id: 'original-job' });
  assert.equal(sent.at(-1).params.name, 'generation_result');
  assert.deepEqual(sent.at(-1).params.arguments, { id: 'original-job' });
});
