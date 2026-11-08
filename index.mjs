import path from 'node:path';
import fs from 'node:fs';
import { PLUGIN } from './lib/controller.mjs';
import { MagpieSubscription } from './lib/subscription.mjs';
import { parseLegacyModel } from './lib/catalog.mjs';
import { subscriptionRoutes } from './lib/settings-api.mjs';

export const name = PLUGIN;
export const inject = ['settings', 'credentials', 'webServer'];

export function apply(ctx) {
  const profile = ctx.get('profileContext');
  let instance;
  try { instance = JSON.parse(fs.readFileSync(new URL('./instance.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const home = profile?.home ?? (profile?.dir ? path.dirname(path.dirname(profile.dir)) : instance?.home ?? process.env.DSH_HOME);
  const flag = process.argv.indexOf('--profile');
  const profileName = profile?.dir ? path.basename(profile.dir) : instance?.profile ?? (flag >= 0 ? process.argv[flag + 1] : process.env.DSH_PROFILE);
  if (!home || !/^[a-zA-Z0-9_-]+$/.test(profileName ?? '')) throw new Error('旧版 DSH 请使用本地安装器指定 --home 和 --profile');
  const controller = new MagpieSubscription({ root: path.join(home, PLUGIN, profileName), settings: ctx.get('settings'), credentials: ctx.get('credentials'),
    migrateDefaults: async sync => {
      const service = ctx.get('agentDefaultModel'), selected = service?.currentSelection?.();
      if (selected?.provider !== sync.config.providerId) return;
      const legacy = parseLegacyModel(selected.model, sync.catalog.mapping);
      if (!legacy?.legacy) return;
      await sync.setPreference({ botId: '__profile_default__', model: legacy.canonical, tier: legacy.serviceTier ?? '', defaultEffort: legacy.defaultEffort });
      await service.saveSelection({ ...selected, model: legacy.canonical });
    },
    onStatus: status => { if (status.lastError) ctx.logger.warn(`${PLUGIN}: ${status.lastError}`); } });
  ctx.provide('magpieCatalogSync', { sync: () => controller.sync(), status: () => controller.status(), controls: () => controller.controls(), setPreference: input => controller.setPreference(input) });
  ctx.inject(['connection'], scope => {
    if (!scope.connection.fetch?.register) { ctx.logger.warn('订阅 GUI 需要支持 connection.fetch 的 DSH 版本；模型同步仍可使用'); return; }
    for (const route of subscriptionRoutes(controller)) scope.effect(() => scope.connection.fetch.register(route), PLUGIN + ':' + route.path);
  });
  ctx.inject(['web'], scope => {
    const common = { id: 'magpie-gateway', available: () => Boolean(controller.connectionConfigured && controller.gatewayTools && controller.config?.searchEnabled), ready: async () => Boolean(controller.config?.searchEnabled && await controller.getKey()) };
    scope.effect(() => scope.web.registerSearchProvider({ ...common, search: (request, signal) => controller.gatewayTools.search(request, signal) }), PLUGIN + ':web-search');
    scope.effect(() => scope.web.registerFetchProvider({ ...common, fetch: (request, signal) => controller.gatewayTools.fetch(request, signal) }), PLUGIN + ':web-fetch');
  });
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (request.provider === controller.config?.providerId && request.sessionId) headers.set('x-magpie-sync-session-id', String(request.sessionId));
    return typeof next === 'function' ? next() : headers;
  });
  ctx.effect(() => {
    void controller.start().catch(error => ctx.logger.error(`${PLUGIN}: ${String(error.message).replace(/https?:\/\/\S+/g, '[address]')}`));
    return () => controller.close();
  }, PLUGIN + ':sync');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/' + PLUGIN, handler: async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(403, { error: '仅接受本机请求' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: '跨站请求已拒绝' }); }
      catch { return json(403, { error: '无效的 Origin' }); }
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/' + PLUGIN + '/status') return json(200, controller.status());
    if (req.method === 'GET' && url.pathname === '/api/' + PLUGIN + '/controls') return json(200, controller.controls());
    if (req.method === 'POST' && req.headers['x-magpie-catalog-sync'] === '1' && ['/api/' + PLUGIN + '/selection', '/api/' + PLUGIN + '/reconcile'].includes(url.pathname)) {
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 65536) return json(413, { error: 'Request too large' }); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (url.pathname.endsWith('/selection')) return json(200, await controller.setPreference(input));
        await controller.reconcile(); return json(200, controller.controls());
      } catch (error) { return json(error.status ?? 400, { error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/' + PLUGIN + '/sync' && req.headers['x-magpie-catalog-sync'] === '1') {
      return json(200, await controller.sync());
    }
    return json(404, { error: 'Unknown endpoint' });
  } }), PLUGIN + ':http');
}
