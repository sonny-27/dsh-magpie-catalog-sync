export function normalizeLoginURL(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error('网页登录入口无效');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写有效的网页登录入口'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('网页登录入口不能携带凭据、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('网页登录入口需要 HTTPS，或仅供本机访问的 HTTP 地址');
  return url.href;
}
