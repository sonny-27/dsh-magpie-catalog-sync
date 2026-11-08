import { imageSelection, videoSelection, mapSearchContent } from './gateway-tools.mjs';
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(new Error('自检已取消')); }
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});
export class Diagnostics {
  constructor(controller, { fetchImpl = fetch, pollMs = 3000 } = {}) { Object.assign(this, { controller, fetchImpl, pollMs }); this.jobs = new Map(); }
  view() { return [...this.jobs.values()].map(({ report }) => structuredClone(report)); }
  start(kind) {
    if (!['search', 'image', 'image-generate', 'video'].includes(kind)) throw new Error('未知的自检类型');
    const previous = this.jobs.get(kind);
    if (previous?.report.state === 'running' || previous?.report.state === 'pending') return this.view();
    const abort = new AbortController();
    const report = { kind, state: 'running', startedAt: new Date().toISOString(), stages: [] };
    const job = { abort, report }; this.jobs.set(kind, job);
    job.task = this.run(job).catch(error => {
      report.state = 'failed'; report.error = job.clean?.(error.message) ?? '自检失败';
    }).finally(() => { report.finishedAt = new Date().toISOString(); });
    return this.view();
  }
  async run(job) {
    const c = this.controller, r = job.report;
    const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(300000)]);
    const connection = await c.getConnection();
    job.clean = value => {
      let text = String(value ?? '未知错误');
      for (const secret of [connection.key, c.toolToken]) if (secret) text = text.split(secret).join('[凭据]');
      return text.replace(/https?:\/\/\S+/g, '[地址]').replace(/data:image\/[^\s]+/g, '[图片数据]').slice(0, 300);
    };
    const stage = async (name, operation) => {
      const item = { name, state: 'running' }; r.stages.push(item);
      try { const detail = await operation(); item.state = 'passed'; if (detail) item.detail = job.clean(detail); return detail; }
      catch (error) { item.state = 'failed'; item.detail = job.clean(error.message); throw error; }
    };
    await stage('连接配置', async () => { if (!connection.baseURL || !connection.key) throw new Error('请先保存 API 地址和 Key'); return '已配置统一网关凭据'; });
    const image = r.kind !== 'search', video = r.kind === 'video';
    const rpc = (method, params) => c.gatewayTools.rpc(image ? 'image' : 'search', { jsonrpc: '2.0', id: 'self-test', method, params }, { connection, signal });
    let tools;
    await stage('上游鉴权与工具发现', async () => {
      tools = await rpc('tools/list', {});
      const required = image ? [video ? 'generate_video' : 'generate_image', 'generation_result'] : ['web_search', 'web_fetch'];
      if (!required.every(name => tools?.tools?.some(x => x.name === name))) throw new Error('上游缺少所需工具');
      return required.join('、');
    });
    if (!image) {
      await stage('实际搜索', async () => {
        if (!c.config.searchEnabled) throw new Error('搜索功能已关闭');
        const result = await rpc('tools/call', { name: 'web_search', arguments: { query: 'Example Domain site:example.com', count: 3 } });
        const text = (result?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
        if (result?.isError) throw new Error(text || '搜索执行失败');
        const count = mapSearchContent(result).sources.length;
        if (!count) throw new Error('搜索请求已完成，但没有返回可用搜索结果');
        return '已返回 ' + count + ' 条搜索结果';
      });
      r.state = 'passed'; return;
    }
    const selected = video ? videoSelection(c.config, c.toolCatalog?.videoModels ?? []) : imageSelection(c.config, c.toolCatalog?.imageModels ?? []);
    await stage(video ? '视频版本与授权' : '绘图版本', async () => {
      if (!(video ? c.config.videoEnabled : c.config.imageEnabled)) throw new Error(video ? '视频功能已关闭' : '绘图功能已关闭');
      if (!selected.defaultModel || !tools.tools.find(x => x.name === (video ? 'generate_video' : 'generate_image'))?.inputSchema?.properties?.model?.enum?.includes(selected.defaultModel)) throw new Error(video ? '尚无已授权的视频模型，请先授权网页账号并同步' : '当前默认绘图版本不可用，请先同步并重新选择');
      return selected.defaultModel;
    });
    await stage(video ? '本机视频代理' : '本机绘图代理', async () => {
      await c.ensureRelay();
      const response = await this.fetchImpl(c.relay.baseURL.replace(/\/v1$/, '') + '/mcp/magpie/image', {
        method: 'POST', signal, headers: { authorization: 'Bearer ' + c.toolToken, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'self-test-local', method: 'tools/list', params: {} }),
      });
      if (!response.ok) throw new Error('本机代理 HTTP ' + response.status);
      const body = await response.json();
      if (!body.result?.tools?.some(x => x.name === (video ? 'generate_video' : 'generate_image'))) throw new Error('本机代理未提供所需媒体工具');
      return '本机令牌、代理和工具列表正常';
    });
    if (r.kind === 'image' || video) { r.state = 'passed'; r.note = video ? '连接正常；尚未生成或下载真实视频。' : '连接正常；尚未执行真实出图。'; return; }
    await stage('真实出图', async () => {
      // One generation per job. Pending calls are polled, never submitted again.
      let result = await rpc('tools/call', { name: 'generate_image', arguments: { model: selected.defaultModel, prompt: 'A simple solid blue circle centered on a plain white background. No text.', n: 1, size: '1024x1024' } });
      for (;;) {
        if (result?.isError) throw new Error((result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n') || '生成失败');
        const images = (result?.content ?? []).filter(x => x.type === 'image').length;
        const files = result?._meta?.['usemagpie.ai/files']?.length ?? 0;
        if (images || files) return '已成功生成测试图片（' + Math.max(images, files) + ' 张）';
        const pending = result?._meta?.['usemagpie.ai/pending'];
        const id = typeof pending === 'string' ? pending : pending?.id;
        if (!id) throw new Error('上游未返回图片或可查询的生成任务');
        r.state = 'pending'; r.note = '图片仍在生成，正在查询原任务；不会重复提交。';
        await sleep(this.pollMs, signal);
        result = await rpc('tools/call', { name: 'generation_result', arguments: { id } });
      }
    });
    r.state = 'passed'; delete r.note;
  }
  close() { for (const job of this.jobs.values()) job.abort.abort(); }
}
