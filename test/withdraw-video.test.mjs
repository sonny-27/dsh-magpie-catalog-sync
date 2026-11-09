import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MagpieSubscription } from '../lib/subscription.mjs';

test('upgrade removes retired video settings and discovery cache while preserving model, image and search settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-withdraw-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('magpie-withdraw-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = { upstream: 'https://gateway.example/v1', pollSeconds: 600, imageEnabled: true, searchEnabled: true,
    gemini4CompactTools: true, geminiImageModel: 'gemini/image', videoEnabled: true, videoModel: 'old/video', videoLoginURL: 'http://127.0.0.1:5800/setup' };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(root, 'tool-catalog.json'), JSON.stringify({ upstream: config.upstream, imageModels: ['gemini/image'], searchTools: ['web_search', 'web_fetch'], videoModels: ['old/video'], videoAvailable: true, videoError: 'old' }));
  const controller = new MagpieSubscription({ root, settings: { describe: () => [] }, credentials: { resolve: async () => undefined }, fetchImpl: async () => { throw Error('migration must stay offline'); } });
  t.after(() => controller.close());
  await controller.initialize();
  const view = await controller.settingsView();
  const saved = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  const tools = JSON.parse(await fs.readFile(path.join(root, 'tool-catalog.json'), 'utf8'));
  for (const value of [saved, view, tools]) assert.equal(Object.keys(value).some(key => key.startsWith('video')), false);
  for (const key of ['upstream', 'pollSeconds', 'imageEnabled', 'searchEnabled', 'gemini4CompactTools', 'geminiImageModel']) assert.equal(saved[key], config[key]);
  assert.deepEqual(tools.imageModels, ['gemini/image']);
  assert.deepEqual(tools.searchTools, ['web_search', 'web_fetch']);
  assert.equal(controller.state.state, 'needs_configuration');
});
