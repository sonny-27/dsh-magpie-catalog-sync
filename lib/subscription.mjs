import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { CatalogSync, readJSON, atomicJSON } from './controller.mjs';
import { normalizeBaseURL } from './catalog.mjs';
import { GatewayTools, imageSelection, imageFamily } from './gateway-tools.mjs';

export class MagpieSubscription extends CatalogSync {
  defaults = { autoSyncEnabled: true, searchEnabled: true, imageEnabled: true, defaultImageProvider: 'gpt', gptImageModel: '', geminiImageModel: '', imageScope: 'main' };
  async prepareServices() {
    const file = path.join(this.root, 'tool-token.txt');
    try { this.toolToken = (await fs.readFile(file, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.toolToken = randomBytes(32).toString('base64url'); await fs.writeFile(file, this.toolToken, { mode: 0o600 }); }
    const cache = await readJSON(path.join(this.root, 'tool-catalog.json'), {});
    this.toolCatalog = cache.upstream === this.config.upstream ? cache : { imageModels: [], searchTools: [] };
    this.gatewayTools = new GatewayTools({ getConnection: () => this.getConnection(), getConfig: () => this.config, fetchImpl: this.fetchImpl });
    this.connectionConfigured = true;
  }
  async getConnection() {
    if (this.changingConnection) await this.changingConnection;
    const config = this.config, value = await this.credentials.resolve(config.credentialRef);
    if (config !== this.config) return this.getConnection();
    return { baseURL: config.upstream, key: value?.value, config };
  }
  extraRelayOptions() {
    return { getConnection: () => this.getConnection(), toolsBridge: this.gatewayTools,
      getToolToken: async () => this.toolToken, getImageModels: () => this.toolCatalog.imageModels ?? [] };
  }
  async afterSync() {
    const discovered = await this.gatewayTools.discover(), previous = this.toolCatalog;
    this.toolCatalog = { ...discovered, upstream: this.config.upstream,
      imageModels: discovered.imageError ? previous.imageModels ?? [] : discovered.imageModels,
      imageAliases: discovered.imageError ? previous.imageAliases ?? [] : discovered.imageAliases ?? [],
      searchTools: discovered.searchError ? previous.searchTools ?? [] : discovered.searchTools };
    await atomicJSON(path.join(this.root, 'tool-catalog.json'), this.toolCatalog);
    this.state.tools = this.toolCatalog;
    const section = this.settings.describe({ redactSecrets: true }).find(x => x.ns === 'web');
    if (section && (section.value?.searchProvider !== 'magpie-gateway' || section.value?.fetchProvider !== 'magpie-gateway')) {
      this.saved.webPrevious ??= { searchProvider: section.value?.searchProvider, fetchProvider: section.value?.fetchProvider };
      await this.settings.mutate('web', [{ op: 'set', path: ['searchProvider'], value: 'magpie-gateway' }, { op: 'set', path: ['fetchProvider'], value: 'magpie-gateway' }], section.revision);
      await atomicJSON(path.join(this.root, 'state.json'), this.saved);
    }
  }
  async settingsView() {
    const selected = imageSelection(this.config, this.toolCatalog?.imageModels ?? []);
    return { version: '0.4.1', upstream: this.config?.upstream, keyConfigured: Boolean(await this.getKey()),
      autoSyncEnabled: this.config.autoSyncEnabled !== false, pollSeconds: this.config.pollSeconds,
      searchEnabled: this.config.searchEnabled, imageEnabled: this.config.imageEnabled, defaultImageProvider: this.config.defaultImageProvider,
      gptImageModel: selected.gpt ?? this.config.gptImageModel, geminiImageModel: selected.gemini ?? this.config.geminiImageModel,
      imageScope: this.config.imageScope, selectedImageModel: selected.defaultModel,
      imageAliases: this.toolCatalog?.imageAliases ?? [],
      imageModels: (this.toolCatalog?.imageModels ?? []).map(id => ({ id, family: imageFamily(id), name: (this.toolCatalog.imageAliases ?? []).some(x => x.resolved === id) ? 'GPT Image（Magpie 统一入口）' : id })),
      tools: this.toolCatalog, status: this.status() };
  }
  async searchPolicy(input) {
    const { baseURL, key } = await this.getConnection();
    const response = await this.fetchImpl(baseURL + '/magpie/subscription/search-policy', {
      method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: 'Bearer ' + key, ...(input ? { 'content-type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const result = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(result?.error ?? '搜索排序接口返回 HTTP ' + response.status + '，请确认此 Magpie 已部署搜索设置扩展');
    return result;
  }
  changeSettings(operation) {
    const task = (this.settingChanges ?? Promise.resolve()).catch(() => {}).then(operation);
    this.settingChanges = task; return task;
  }
  updateSettings(input) { return this.changeSettings(() => this.saveSettings(input)); }
  async saveSettings(input) {
    const next = { ...this.config };
    for (const name of ['autoSyncEnabled', 'searchEnabled', 'imageEnabled']) if (input[name] !== undefined) {
      if (typeof input[name] !== 'boolean') throw new Error('无效的开关设置'); next[name] = input[name];
    }
    if (input.pollSeconds !== undefined) {
      if (!Number.isInteger(input.pollSeconds) || input.pollSeconds < 60 || input.pollSeconds > 86400) throw new Error('刷新周期需为 60–86400 秒');
      next.pollSeconds = input.pollSeconds;
    }
    if (input.defaultImageProvider !== undefined) { if (!['gpt', 'gemini'].includes(input.defaultImageProvider)) throw new Error('请选择 GPT 或 Gemini'); next.defaultImageProvider = input.defaultImageProvider; }
    if (input.imageScope !== undefined) { if (!['main', 'all', 'manual'].includes(input.imageScope)) throw new Error('无效的绘图工具范围'); next.imageScope = input.imageScope; }
    for (const family of ['gpt', 'gemini']) {
      const field = family + 'ImageModel';
      if (input[field] !== undefined) {
        if (input[field] && (!(this.toolCatalog.imageModels ?? []).includes(input[field]) || imageFamily(input[field]) !== family)) throw new Error('请选择已发现的 ' + family + ' 绘图版本');
        next[field] = input[field];
      }
    }
    await atomicJSON(path.join(this.root, 'config.json'), next); this.config = next; this.armTimer();
    if (next.autoSyncEnabled === false) this.state.state = 'paused';
    else if (this.state.state === 'paused') this.state.state = this.catalog ? 'ready' : 'starting';
    return this.settingsView();
  }
  updateConnection(input) { return this.changeSettings(() => this.saveConnection(input)); }
  async saveConnection(input) {
    if (this.pending) await this.pending;
    const previous = this.config, base = normalizeBaseURL(String(input.upstream ?? previous.upstream));
    const provided = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (base !== previous.upstream && !provided) throw new Error('更换订阅地址时，请同时填写该网关的 Key');
    if (provided && (/\s/.test(provided) || provided.length < 8)) throw new Error('请填写有效的网关 Key');
    const task = (async () => {
      const key = provided || await this.getKey();
      const response = await this.fetchImpl(base + '/models', { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { authorization: 'Bearer ' + key } });
      if (!response.ok) throw new Error('连接验证失败，HTTP ' + response.status);
      const data = await response.json(); if (!Array.isArray(data.data) || !data.data.length) throw new Error('此地址没有返回模型列表');
      if (provided) await this.credentials.set(previous.credentialRef, provided);
      const next = { ...previous, upstream: base };
      if (base !== previous.upstream) { next.gptImageModel = ''; next.geminiImageModel = ''; }
      await atomicJSON(path.join(this.root, 'config.json'), next); this.config = next;
      const verified = await readJSON(path.join(this.root, 'verified-capabilities.json'), {});
      this.catalogOptions = { ...next, serviceTierOverrides: verified.upstream === base ? verified.models ?? {} : {} };
      if (base !== previous.upstream) this.toolCatalog = { imageModels: [], searchTools: [] };
    })();
    this.changingConnection = task;
    try { await task; } finally { this.changingConnection = undefined; }
    await this.sync(); return this.settingsView();
  }
  imageBinding() {
    const selected = imageSelection(this.config, this.toolCatalog?.imageModels ?? []);
    const revision = createHash('sha256').update(JSON.stringify([this.config.upstream, selected, this.config.defaultImageProvider, this.toolToken])).digest('hex').slice(0, 12);
    return { enabled: this.config.imageEnabled && selected.selectedModels.length > 0, scope: this.config.imageScope,
      capability: { name: 'magpie-sync-image', kind: 'mcp', transport: 'streamable-http',
        description: 'Magpie 订阅管理：GPT/Gemini 绘图，复用统一连接。',
        url: this.relay.baseURL.replace(/\/v1$/, '') + '/mcp/magpie/image?rev=' + revision,
        headers: { Authorization: 'Bearer ' + this.toolToken } } };
  }
}
