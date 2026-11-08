import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const scope = connection => connection.baseURL + '\0' + createHash('sha256').update(connection.key ?? '').digest('hex');
const validID = id => /^video_[A-Za-z0-9._~-]{1,1200}$/.test(id);

// File-scoped, expiring links let the local UI download video without exposing the gateway key.
export function videoFiles({ getBaseURL, now = () => Date.now() }) {
  const key = randomBytes(32);
  const sign = (id, expires, connection) => createHmac('sha256', key).update(JSON.stringify([id, expires, scope(connection)])).digest('hex');
  const prefix = '/mcp/magpie/video/files/';
  return {
    prefix,
    issue(id, connection) {
      if (!validID(id)) throw new Error('Invalid video ID');
      const expires = Math.floor(now() / 1000) + 3600;
      return getBaseURL() + prefix + encodeURIComponent(id) + '?expires=' + expires + '&signature=' + sign(id, expires, connection);
    },
    verify(url, connection) {
      let id;
      try { id = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { return undefined; }
      const expires = Number(url.searchParams.get('expires')), signature = url.searchParams.get('signature') ?? '';
      if (!url.pathname.startsWith(prefix) || !validID(id) || !Number.isInteger(expires) || expires < Math.floor(now() / 1000) || expires > Math.floor(now() / 1000) + 3600 || !/^[a-f0-9]{64}$/.test(signature)) return undefined;
      return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(id, expires, connection), 'hex')) ? id : undefined;
    },
  };
}

export function rewriteVideoFiles(data, connection, files) {
  if (!files || data.result?.isError) return data;
  const replacements = new Map();
  const root = new URL(connection.baseURL);
  for (const file of data.result?._meta?.['usemagpie.ai/files'] ?? []) {
    if (typeof file?.URL !== 'string' && typeof file?.url !== 'string') continue;
    const original = file.URL ?? file.url;
    let url;
    try { url = new URL(original, root); } catch { continue; }
    const match = /^\/v1\/videos\/(video_[A-Za-z0-9._~-]+)\/content$/.exec(url.pathname);
    if (url.origin !== root.origin || url.search || !match) continue;
    const local = files.issue(match[1], connection);
    replacements.set(original, local);
    if (file.URL) file.URL = local; else file.url = local;
  }
  for (const block of data.result?.content ?? []) if (block.type === 'text') {
    for (const [original, local] of replacements) block.text = block.text.split(original).join(local);
    if (replacements.size) {
      block.text = block.text.replace('(with the same Authorization header as this server, from another computer)', '(using the local file link below)');
      block.text += '\n本机 MP4 下载链接一小时内有效，无需附加网关 Key；需要长期保存时请及时下载。';
    }
  }
  return data;
}
