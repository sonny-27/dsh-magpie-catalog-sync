import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const TOOL_PATHS = { image: '/mcp/magpie/image', search: '/mcp/magpie/web-search' };
const fail = (message, code = 'WEB_PROVIDER_ERROR') => Object.assign(new Error(message), { code });
export const imageFamily = id => /gemini|imagen|nano-banana/i.test(id) ? 'gemini' : /gpt-image|dall-e|chatgpt-image/i.test(id) ? 'gpt' : 'other';
export function imageSelection(config, models) {
  const select = family => {
    const saved = config[family + 'ImageModel'];
    return saved ? (models.includes(saved) ? saved : undefined) : models.find(x => imageFamily(x) === family);
  };
  const gpt = select('gpt'), gemini = select('gemini');
  return { gpt, gemini, defaultModel: config.defaultImageProvider === 'gemini' ? gemini : gpt ?? gemini,
    selectedModels: [gpt, gemini].filter(Boolean) };
}
export function mapSearchContent(result) {
  const text = (result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  let structured = result.structuredContent;
  if (!structured) { try { structured = JSON.parse(text); } catch { /* Magpie's numbered source format below. */ } }
  if (Array.isArray(structured?.sources ?? structured?.results)) {
    return { sources: (structured.sources ?? structured.results).filter(x => /^https?:\/\//.test(x.url ?? '')).map(x => ({ url: x.url, title: x.title, snippet: x.snippet ?? x.content })), truncated: false };
  }
  const markers = [...text.matchAll(/^\d+\.\s+(.+?)\s+[—–]\s+(https?:\/\/\S+)\s*$/gm)];
  return { sources: markers.map((m, i) => ({ title: m[1], url: m[2],
    snippet: text.slice(m.index + m[0].length, markers[i + 1]?.index ?? text.length).replace(/-{8,}/g, '').trim().slice(0, 4000) })), truncated: false };
}

export class GatewayTools {
  constructor({ getConnection, getConfig, fetchImpl = fetch }) { Object.assign(this, { getConnection, getConfig, fetchImpl }); }
  async rpc(kind, message, { signal, connection } = {}) {
    const conn = connection ?? await this.getConnection();
    if (!conn.key) throw fail('Magpie 网关密钥未配置');
    const response = await this.fetchImpl(conn.baseURL.replace(/\/v1$/, '') + TOOL_PATHS[kind], {
      method: 'POST', redirect: 'error', signal: signal ?? AbortSignal.timeout(kind === 'search' ? 330000 : 30000),
      headers: { authorization: 'Bearer ' + conn.key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw fail(`Magpie ${kind === 'image' ? '绘图' : '搜索'}接口返回 HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw fail(String(data.error.message ?? 'Magpie 工具请求失败').slice(0, 300));
    return data.result;
  }
  async discover() {
    const entries = await Promise.allSettled(['image', 'search'].map(kind => this.rpc(kind, { jsonrpc: '2.0', id: 'catalog-' + kind, method: 'tools/list', params: {} })));
    const [image, search] = entries;
    const result = { checkedAt: new Date().toISOString(), imageModels: [], searchTools: [] };
    if (image.status === 'fulfilled') {
      const tool = image.value?.tools?.find(x => x.name === 'generate_image');
      result.imageModels = tool?.inputSchema?.properties?.model?.enum?.filter(x => typeof x === 'string') ?? [];
      result.imageAvailable = Boolean(tool);
      if (result.imageModels.includes('codex/gpt-image-2')) {
        const aliases = await Promise.allSettled(['codex/gpt-image-2.5', 'codex/gpt-image-2.5-flare', 'codex/gpt-image-2.5-sunburst', 'codex/gpt-image-2.6'].map(async requested => {
          const resolved = await this.rpc('image', { jsonrpc: '2.0', id: 'image-version', method: 'magpie/media_model', params: { tool: 'generate_image', model: requested } });
          return typeof resolved?.model === 'string' && resolved.model !== requested ? { requested, resolved: resolved.model } : undefined;
        }));
        result.imageAliases = aliases.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value);
      }
    } else result.imageError = image.reason.message;
    if (search.status === 'fulfilled') { result.searchTools = search.value?.tools?.map(x => x.name) ?? []; result.searchAvailable = result.searchTools.includes('web_search'); }
    else result.searchError = search.reason.message;
    return result;
  }
  async search(request, signal) {
    if (!this.getConfig()?.searchEnabled) throw fail('Magpie 搜索已在订阅设置中关闭', 'WEB_PROVIDER_UNAVAILABLE');
    const result = await this.rpc('search', { jsonrpc: '2.0', id: 'search', method: 'tools/call', params: { name: 'web_search', arguments: { query: request.query, count: Math.min(10, request.maxResults ?? 5) } } }, { signal });
    if (result?.isError) throw fail('Magpie 搜索失败，请检查订阅页中的搜索状态');
    return mapSearchContent(result);
  }
  async fetch(request, signal) {
    if (!this.getConfig()?.searchEnabled) throw fail('Magpie 网页读取已关闭', 'WEB_PROVIDER_UNAVAILABLE');
    const max = Math.min(50000, request.maxChars ?? 20000);
    const result = await this.rpc('search', { jsonrpc: '2.0', id: 'fetch', method: 'tools/call', params: { name: 'web_fetch', arguments: { url: request.url, max_chars: max, offset: 0 } } }, { signal });
    if (result?.isError) throw fail('Magpie 无法读取此网页');
    const text = (result?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    return { url: request.url, statusCode: 200, body: { kind: 'text', content: text }, truncated: text.length >= max };
  }
  async proxyImage(req, res, { connection, signal, body, imageModels }) {
    const config = connection.config ?? this.getConfig();
    if (!config.imageEnabled) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '绘图功能已关闭' })); return; }
    const selected = imageSelection(config, imageModels);
    if (body?.method === 'tools/call' && body.params?.name === 'generate_image') {
      const args = body.params.arguments ??= {};
      args.model ??= selected.defaultModel;
      if (!args.model || !selected.selectedModels.includes(args.model)) throw fail('请在 Magpie 订阅设置中选择当前绘图版本');
    }
    if (body?.method === 'tools/call' && body.params?.name === 'generate_video') throw fail('此订阅只启用了绘图功能');
    const headers = { authorization: 'Bearer ' + connection.key, accept: req.headers.accept ?? 'application/json, text/event-stream' };
    for (const name of ['mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (req.headers[name]) headers[name] = req.headers[name];
    if (body) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(connection.baseURL.replace(/\/v1$/, '') + TOOL_PATHS.image, {
      method: req.method, redirect: 'error', headers, signal, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const out = { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' };
    for (const name of ['mcp-session-id', 'mcp-protocol-version']) if (response.headers.has(name)) out[name] = response.headers.get(name);
    if (response.ok && body?.method === 'tools/list' && (out['content-type'].includes('json'))) {
      const data = await response.json();
      if (data.result?.tools) {
        data.result.tools = data.result.tools.filter(x => x.name !== 'generate_video');
        const tool = data.result.tools.find(x => x.name === 'generate_image');
        if (tool?.inputSchema?.properties?.model) Object.assign(tool.inputSchema.properties.model, { enum: selected.selectedModels, default: selected.defaultModel });
        if (tool) tool.description += ` 当前订阅默认绘图版本：${selected.defaultModel ?? '未配置'}。未指定版本时请省略 model 参数。`;
      }
      res.writeHead(response.status, out); res.end(JSON.stringify(data)); return;
    }
    res.writeHead(response.status, out);
    if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
  }
}
