import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { rewriteRequest, parseLegacyModel } from './catalog.mjs';
import { compactGemini4Tools } from './tool-compat.mjs';
import { videoFiles } from './video-files.mjs';

const hash = value => createHash('sha256').update(value).digest();
const allowed = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']);
const send = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: 'magpie_catalog_sync_error', message } }));
};

export async function createRelay({ getKey, getBaseURL, getConnection, getCatalog, getPreference = async () => undefined, fetchImpl = fetch, onRequest = () => {}, toolsBridge, getToolToken, getImageModels = () => [], getVideoModels = () => [] }) {
  const sockets = new Set(), controllers = new Set();
  let localBase;
  const files = videoFiles({ getBaseURL: () => localBase });
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    req.once('aborted', () => controller.abort());
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(res, 403, '仅接受本机模型客户端请求');
      const url = new URL(req.url, 'http://localhost');
      const connection = getConnection ? await getConnection() : { key: await getKey(), baseURL: getBaseURL() };
      if (url.pathname.startsWith(files.prefix) && req.method === 'GET') {
        const id = files.verify(url, connection);
        if (!id) return send(res, 403, '视频链接无效、已过期或连接已更换');
        const upstream = await fetchImpl(connection.baseURL + '/videos/' + encodeURIComponent(id) + '/content', {
          headers: { authorization: 'Bearer ' + connection.key }, signal: controller.signal, redirect: 'error',
        });
        if (!upstream.ok) return send(res, upstream.status, '视频尚未完成、已过期或无权下载');
        if (!(upstream.headers.get('content-type') ?? '').toLowerCase().startsWith('video/')) return send(res, 502, '上游没有返回有效视频');
        res.writeHead(200, { 'content-type': upstream.headers.get('content-type'), 'content-disposition': 'attachment; filename="gemini-video.mp4"', 'cache-control': 'private, no-store', 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer' });
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res); else res.end();
        return;
      }
      if (req.headers.origin) return send(res, 403, '仅接受本机模型客户端请求');
      const key = connection.key, isImageMcp = url.pathname === '/mcp/magpie/image';
      const incomingKey = isImageMcp ? await getToolToken?.() : key;
      if (!incomingKey || !timingSafeEqual(hash(req.headers.authorization ?? ''), hash('Bearer ' + incomingKey))) return send(res, 401, '需要配置的调用凭据');
      if (isImageMcp && toolsBridge && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        let body;
        if (req.method === 'POST') {
          let size = 0; const chunks = [];
          for await (const part of req) { size += part.length; if (size > 32 * 1024 * 1024) return send(res, 413, '图像请求超过 32 MiB'); chunks.push(part); }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, '无效的 MCP 请求'); }
        }
        await toolsBridge.proxyImage(req, res, { connection, signal: controller.signal, body, imageModels: getImageModels(), videoModels: getVideoModels(), files }); return;
      }
      const catalog = getCatalog();
      if (!catalog) return send(res, 503, '首次模型同步尚未完成');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ object: 'list', data: catalog.models.map(m => ({ object: 'model', ...m })) }));
      }
      if (req.method !== 'POST' || !allowed.has(url.pathname) || url.search) return send(res, 404, '未开放此接口');
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return send(res, 413, '模型请求超过 32 MiB');
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(res, 400, '请求体必须是 JSON'); }
      const canonical = typeof input.model === 'string' && parseLegacyModel(input.model, catalog.mapping)?.canonical;
      const sessionId = typeof req.headers['x-magpie-sync-session-id'] === 'string' ? req.headers['x-magpie-sync-session-id'] : undefined;
      const preference = canonical ? await getPreference(sessionId, canonical) : undefined;
      const rewritten = rewriteRequest(input, url.pathname, catalog.mapping, preference);
      const target = rewritten.target;
      const { body, relocatedParameterDescriptions } = compactGemini4Tools(rewritten.body, connection.config?.gemini4CompactTools !== false);
      const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: req.headers.accept ?? 'application/json' };
      for (const name of ['user-agent', 'anthropic-version', 'anthropic-beta']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      const upstream = await fetchImpl(connection.baseURL + url.pathname.slice(3), {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      onRequest({ model: target.canonical, serviceTier: target.serviceTier, defaultEffort: target.defaultEffort,
        ...(relocatedParameterDescriptions ? { relocatedParameterDescriptions } : {}),
        sessionId,
        reasoningEffort: body.reasoning?.effort ?? body.reasoning_effort ?? body.output_config?.effort,
        status: upstream.status, at: new Date().toISOString() });
      const responseHeaders = { 'cache-control': 'no-store', 'content-type': upstream.headers.get('content-type') ?? 'application/json' };
      for (const name of ['x-request-id', 'x-magpie-model', 'retry-after']) if (upstream.headers.has(name)) responseHeaders[name] = upstream.headers.get(name);
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 502, error.status ? error.message : '连接 Magpie 失败，请检查地址、密钥和网络');
      else res.destroy();
    } finally { controllers.delete(controller); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  localBase = `http://127.0.0.1:${port}`;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    async close() { for (const controller of controllers) controller.abort(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
