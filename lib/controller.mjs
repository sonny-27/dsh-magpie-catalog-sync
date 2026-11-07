import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCatalog, normalizeBaseURL, THINKING_LEVELS, parseLegacyModel } from './catalog.mjs';
import { createRelay } from './relay.mjs';
import { PreferenceStore } from './preferences.mjs';

export const PLUGIN = 'dsh-magpie-catalog-sync';
const NS = 'llm-pi-ai';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
async function readBoundedJSON(response) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Magpie 模型列表超过 8 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class CatalogSync {
  constructor({ root, settings, credentials, fetchImpl = fetch, onStatus = () => {}, migrateDefaults = async () => {} }) {
    Object.assign(this, { root, settings, credentials, fetchImpl, onStatus, migrateDefaults });
    this.state = { plugin: PLUGIN, state: 'starting', records: [] };
    this.closed = false;
  }
  async getKey() {
    const result = await this.credentials.resolve(this.config.credentialRef);
    return result?.value;
  }
  async start() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const raw = await readJSON(path.join(this.root, 'config.json'), {});
    this.config = {
      providerId: 'magpie-sync', displayName: 'Magpie · 自动同步', credentialRef: 'MAGPIE_CATALOG_SYNC_KEY',
      pollSeconds: 300, api: 'openai-responses', supportedEfforts: THINKING_LEVELS, ...(this.defaults ?? {}), ...raw,
    };
    if (!this.config.upstream) throw new Error('请先在插件 config.json 中填写 upstream 和网关密钥引用');
    this.config.upstream = normalizeBaseURL(this.config.upstream);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(this.config.providerId)) throw new Error('无效的 providerId');
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(this.config.credentialRef)) throw new Error('无效的网关密钥引用');
    if (!['openai-responses', 'openai-completions'].includes(this.config.api)) throw new Error('仅支持 OpenAI Responses 或 Chat Completions');
    this.config.pollSeconds = Math.max(60, Math.min(86400, Number(this.config.pollSeconds) || 300));
    const verified = await readJSON(path.join(this.root, 'verified-capabilities.json'), {});
    this.catalogOptions = { ...this.config, serviceTierOverrides: verified.upstream === this.config.upstream ? verified.models ?? {} : {} };
    const home = path.dirname(path.dirname(this.root));
    this.preferences = new PreferenceStore(path.join(this.root, 'selections.json'), this.config.botStatePath ?? path.join(home, 'bot', 'state.json'));
    await this.preferences.load();
    const bootstrap = path.join(this.root, 'bootstrap.key');
    try {
      const value = (await fs.readFile(bootstrap, 'utf8')).trim();
      if (!value || /\s/.test(value)) throw new Error('安装时提供的网关密钥格式不正确');
      const existing = await this.getKey();
      if (existing && existing !== value) throw new Error('凭据引用已有其他密钥，请改用单独的 credentialRef');
      if (!existing) await this.credentials.set(this.config.credentialRef, value);
      await fs.unlink(bootstrap);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!(await this.getKey())) throw new Error('未找到 Magpie 网关密钥，请通过凭据服务保存配置中的 credentialRef');
    await this.prepareServices?.();
    this.saved = await readJSON(path.join(this.root, 'state.json'), {});
    this.state.lastSyncedAt = (await readJSON(path.join(this.root, 'status.json'), {})).lastSyncedAt;
    const cached = await readJSON(path.join(this.root, 'catalog.json'), undefined);
    if (cached) this.catalog = buildCatalog(cached, this.catalogOptions);
    this.relay = await createRelay({ getKey: () => this.getKey(), getBaseURL: () => this.config.upstream,
      getCatalog: () => this.catalog, fetchImpl: this.fetchImpl,
      getPreference: (sessionId, model) => this.preferences.forRequest(sessionId, model),
      onRequest: value => { this.state.lastRequest = value; },
      ...(this.extraRelayOptions?.() ?? {}),
    });
    if (this.closed) return this.relay.close();
    if (this.config.autoSyncEnabled === false) {
      if (this.catalog) await this.reconcile();
      this.state = { ...this.state, state: 'paused', modelCount: this.catalog?.records.length ?? 0, entryCount: this.catalog?.models.length ?? 0, records: this.catalog?.records ?? [] };
    } else await this.sync();
    if (this.closed) return;
    this.armTimer();
  }
  armTimer() {
    clearInterval(this.timer);
    if (this.config.autoSyncEnabled === false || this.closed) return;
    this.timer = setInterval(() => { void this.sync(); }, this.config.pollSeconds * 1000); this.timer.unref?.();
  }
  sync() {
    if (this.closed) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    this.pending = this.performSync().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async performSync() {
    let fresh;
    try {
      const connection = this.getConnection ? await this.getConnection() : { key: await this.getKey(), baseURL: this.config.upstream };
      const key = connection.key;
      if (!key) throw new Error('Magpie 网关密钥尚未配置');
      const response = await this.fetchImpl(connection.baseURL + '/models', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Magpie 模型列表返回 HTTP ${response.status}`);
      fresh = await readBoundedJSON(response);
      const next = buildCatalog(fresh, this.catalogOptions);
      if (this.closed) return this.status();
      const previous = this.catalog;
      this.catalog = next;
      try { await this.reconcile(); }
      catch (error) { this.catalog = previous; throw error; }
      await atomicJSON(path.join(this.root, 'catalog.json'), fresh);
      await this.afterSync?.();
      this.state = { ...this.state, state: this.config.autoSyncEnabled === false ? 'paused' : 'ready', lastSyncedAt: new Date().toISOString(), lastError: undefined,
        modelCount: next.records.length, entryCount: next.models.length, records: next.records };
    } catch (error) {
      if (this.closed) return this.status();
      // A temporary outage keeps the last working list. First boot can also use its cache.
      if (this.catalog) {
        try { await this.reconcile(); } catch { /* Report the original failure below. */ }
      }
      const text = typeof error.message === 'string' && !/https?:\/\//.test(error.message)
        ? error.message.slice(0, 240) : '同步失败，请检查 Magpie 地址、密钥和网络';
      this.state = { ...this.state, state: this.catalog ? 'stale' : 'error', lastAttemptAt: new Date().toISOString(), lastError: text,
        modelCount: this.catalog?.records.length ?? 0, entryCount: this.catalog?.models.length ?? 0, records: this.catalog?.records ?? [] };
    }
    await atomicJSON(path.join(this.root, 'status.json'), this.status());
    this.onStatus(this.status());
    return this.status();
  }
  section() {
    return this.settings.describe({ redactSecrets: true }).find(x => x.ns === NS);
  }
  async setPreference(input) {
    if (!this.catalog) throw new Error('模型同步尚未完成');
    const result = await this.preferences.set(input, this.catalog);
    return result;
  }
  async reconcile() {
    if (!this.catalog) return;
    const snapshot = await this.preferences.refreshBindings(true);
    this.legacyModels = [];
    const found = new Set();
    for (const bot of Object.values(snapshot?.bots ?? {})) {
      const prefix = this.config.providerId + '/';
      if (!bot.model?.startsWith(prefix)) continue;
      const localId = bot.model.slice(prefix.length), legacy = parseLegacyModel(localId, this.catalog.mapping);
      if (!legacy?.legacy) continue;
      if (!this.preferences.get(bot.id, legacy.canonical)) {
        await this.setPreference({ botId: bot.id, model: legacy.canonical, tier: legacy.serviceTier ?? '',
          defaultEffort: legacy.defaultEffort, sessionIds: [bot.id, ...(bot.segments ?? []).map(x => x.sessionId).filter(Boolean)] });
      }
      if (!found.has(localId)) {
        const base = this.catalog.models.find(x => x.id === legacy.canonical);
        this.legacyModels.push({ ...base, id: localId }); found.add(localId);
      }
    }
    await this.migrateDefaults(this);
    await this.installProvider();
  }
  async installProvider() {
    const profile = {
      displayName: this.config.displayName, api: this.config.api, baseURL: this.relay.baseURL,
      apiKeyEnv: this.config.credentialRef,
      compat: this.config.api === 'openai-responses' ? { supportsDeveloperRole: false, supportsMaxOutputTokens: true }
        : { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens',
          requiresReasoningContentOnAssistantMessages: true, supportsReasoningEffort: true },
      models: [...this.catalog.models, ...(this.legacyModels ?? [])],
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const section = this.section();
      if (!section) throw new Error('llm-pi-ai 适配器尚未加载，等待下次自动同步');
      const existing = section.value?.providers?.[this.config.providerId];
      if (existing && !(existing.apiKeyEnv === this.config.credentialRef && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(existing.baseURL ?? ''))) {
        throw new Error('providerId 与现有供应商冲突，请在插件 config.json 中改名');
      }
      if (same(existing, profile)) return;
      try {
        await this.settings.mutate(NS, [{ op: 'set', path: ['providers', this.config.providerId], value: profile }], section.revision);
        this.saved = { ...this.saved, managed: true, providerId: this.config.providerId, credentialRef: this.config.credentialRef };
        await atomicJSON(path.join(this.root, 'state.json'), this.saved);
        return;
      } catch (error) { if (attempt || !/revision|conflict|stale/i.test(error.code + ' ' + error.message)) throw error; }
    }
  }
  status() {
    return { ...this.state, upstream: this.config?.upstream, providerId: this.config?.providerId,
      pollSeconds: this.config?.pollSeconds, relay: this.relay?.baseURL };
  }
  controls() {
    return { providerId: this.config?.providerId, updatedAt: this.state.lastSyncedAt, compatibilityEntries: this.legacyModels?.length ?? 0,
      models: this.catalog?.records ?? [],
      choices: this.preferences?.view() ?? [],
      entries: this.catalog ? [...this.catalog.mapping].map(([id, value]) => ({ id, ...value })) : [] };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.relay?.close();
  }
}
