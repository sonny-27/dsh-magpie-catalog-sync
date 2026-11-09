import React from 'react';
import { bindingChanges } from './image-binding.mjs';
const h = React.createElement;
const style = {
  card: { border: '1px solid #8884', borderRadius: 12, padding: 18, marginBottom: 16 },
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' },
  input: { border: '1px solid #8886', borderRadius: 7, padding: '8px 10px', background: 'transparent', color: 'inherit', minWidth: 180, maxWidth: '100%' },
  button: { border: '1px solid #8885', borderRadius: 7, padding: '7px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer' },
};
export async function subscriptionAPI(route, body) {
  const response = await fetch('api/magpie-subscription-' + route, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '订阅设置请求失败'); return value;
}
async function botCall(endpoint, payload) {
  const response = await fetch('api/bot', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload: payload ?? null }) });
  if (response.status === 404) throw Object.assign(new Error('当前客户端没有 DSBot 工具库接口'), { status: 404 });
  const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'DSBot 工具配置失败'); return result.value;
}
let bindingTask;
export function ensureImageBinding() {
  if (bindingTask) return bindingTask;
  bindingTask = (async () => {
    let state;
    try { state = await botCall('state'); } catch (error) { if (error.status === 404) return { skipped: true }; throw error; }
    const binding = await subscriptionAPI('bindings');
    if (binding.pendingConfiguration) return { skipped: true, pendingConfiguration: true };
    const name = binding.capability.name;
    const existing = (state.capabilities ?? []).find(x => x.name === name);
    if (existing && !existing.description?.startsWith('Magpie 订阅管理：')) throw new Error('已有同名绘图工具，请先在工具库中重命名：' + name);
    if (binding.enabled && (!existing || existing.url !== binding.capability.url || JSON.stringify(existing.headers) !== JSON.stringify(binding.capability.headers))) await botCall('capability-save', binding.capability);
    for (const change of bindingChanges(binding, state)) await botCall('bot-capability', change);
    return { enabled: binding.enabled, scope: binding.scope };
  })().finally(() => { bindingTask = undefined; });
  return bindingTask;
}
function SubscriptionSettings() {
  const [diagnostics, D] = React.useState([]);
  React.useEffect(() => {
    let stopped = false;
    const poll = () => subscriptionAPI('diagnostics').then(value => { if (!stopped) D(value); }).catch(() => {});
    poll(); const timer = setInterval(poll, 2000); return () => { stopped = true; clearInterval(timer); };
  }, []);
  const [view, V] = React.useState(), [form, F] = React.useState({}), [key, K] = React.useState(''), [policy, P] = React.useState(), [message, M] = React.useState(''), [busy, B] = React.useState(false);
  const set = (name, value) => F(x => ({ ...x, [name]: value }));
  const refresh = async () => { const value = await subscriptionAPI('settings'); V(value); F(value); try { P(await subscriptionAPI('search-policy')); } catch (error) { P({ error: error.message }); } };
  React.useEffect(() => { refresh().catch(e => M(e.message)); }, []);
  async function action(fn) { B(true); M(''); try { const message = await fn(); M(typeof message === 'string' ? message : '操作完成。'); } catch (error) { M(error.message); } finally { B(false); } }
  const button = (label, fn, disabled = false) => h('button', { type: 'button', style: style.button, disabled: busy || disabled, onClick: () => action(fn) }, label);
  const checkbox = (field, label) => h('label', { style: style.row }, h('input', { type: 'checkbox', checked: Boolean(form[field]), onChange: e => set(field, e.target.checked) }), label);
  const select = (field, label, options) => h('label', { style: style.row }, label, h('select', { 'aria-label': label, style: style.input, value: form[field] ?? '', onChange: e => set(field, e.target.value) }, options.map(([value, text]) => h('option', { key: value, value }, text))));
  const move = (field, index, delta) => { P(p => { const list = [...p[field]]; [list[index], list[index + delta]] = [list[index + delta], list[index]]; return { ...p, [field]: list }; }); return '顺序已调整，点击“保存搜索优先级”生效。'; };
  if (!view) return h('div', { style: { padding: 24 } }, h('h2', null, 'Magpie 订阅'), h('p', { role: 'status' }, message || '正在读取订阅设置…'), button('重新加载', refresh));
  return h('div', { style: { maxWidth: 920, padding: 24 } },
    h('h2', null, 'Magpie 订阅'), h('p', null, '模型、绘图、视频与搜索共用下面的 API 地址和 Key。'),
    h('section', { style: style.card }, h('h3', null, '搜索与绘图自检'),
      h('p', null, '连接自检不生成图片；真实出图自检会消耗上游绘图额度。结果只显示状态，不展示密钥或图片下载链接。'),
      h('div', { style: style.row }, ...[['search', '搜索自检'], ['image', '绘图连接自检'], ['image-generate', '真实出图自检（消耗额度）'], ['video', '视频连接自检']].map(([kind, label]) => button(label, async () => { D(await subscriptionAPI('diagnostics', { kind })); return '自检已启动，结果会自动刷新。'; }, diagnostics.some(x => x.kind === kind && ['running', 'pending'].includes(x.state))))),
      ...diagnostics.map(result => h('div', { key: result.kind, role: 'status', style: { marginTop: 12 } },
        h('strong', null, ({ search: '搜索', image: '绘图连接', 'image-generate': '真实出图', video: '视频连接' })[result.kind] + '：' + ({ running: '检查中', pending: '生成中', passed: '通过', failed: '失败' })[result.state]),
        ...result.stages.map((item, i) => h('p', { key: i }, item.name + '：' + ({ running: '检查中', passed: '通过', failed: '失败' })[item.state] + (item.detail ? ' · ' + item.detail : ''))),
        result.note && h('p', null, result.note), result.error && h('p', null, result.error)))),
    h('section', { style: style.card }, h('h3', null, '统一连接'),
      view.status?.state === 'needs_configuration' && h('p', { role: 'status' }, '订阅尚未配置完成。请填写 API 地址和 Key，然后点击“验证并保存连接”。'),
      h('label', { style: style.row }, 'API 地址', h('input', { 'aria-label': 'Magpie API 地址', style: { ...style.input, flex: 1 }, value: form.upstream ?? '', onChange: e => set('upstream', e.target.value) })),
      h('label', { style: style.row }, 'API Key', h('input', { 'aria-label': 'Magpie API Key', style: { ...style.input, flex: 1 }, type: 'password', autoComplete: 'off', value: key, placeholder: view.keyConfigured ? '已保存 · 留空保留现有 Key' : '填写 Magpie 网关 Key', onChange: e => K(e.target.value) })),
      button('验证并保存连接', async () => { await subscriptionAPI('connect', { upstream: form.upstream, apiKey: key }); K(''); await refresh(); await ensureImageBinding(); })),
    h('section', { style: style.card }, h('h3', null, '模型兼容'), checkbox('gemini4CompactTools', 'Gemini 4 完整参数说明兼容'),
      h('small', null, '仅影响 Antigravity 的 Gemini 4。将完整参数说明按路径附到工具总说明中，保留全部文字、工具和参数校验，不再删除说明。关闭后将说明留在原来的 Schema 位置。说明位置变化仍可能影响模型理解。')),
    h('section', { style: style.card }, h('h3', null, '自动订阅'), checkbox('autoSyncEnabled', '自动同步新模型、能力与图片/视频版本'),
      h('label', { style: style.row }, '刷新间隔（秒）', h('input', { 'aria-label': '刷新间隔（秒）', style: style.input, type: 'number', min: 60, max: 86400, value: form.pollSeconds, onChange: e => set('pollSeconds', Number(e.target.value)) })),
      h('p', null, `已订阅 ${view.status?.modelCount ?? 0} 个模型 · ${view.imageModels?.length ?? 0} 个绘图版本`),
      h('p', { style: { fontSize: 12, opacity: .7 } }, '最近同步：' + (view.status?.lastSyncedAt ? new Date(view.status.lastSyncedAt).toLocaleString() : '尚未完成') + (view.status?.lastError ? ' · ' + view.status.lastError : '')),
      button('立即同步', async () => { await subscriptionAPI('sync', {}); await refresh(); await ensureImageBinding(); })),
    h('section', { style: style.card }, h('h3', null, '绘图模型'), checkbox('imageEnabled', '启用 GPT / Gemini 绘图工具'),
      ...['gpt', 'gemini'].map(family => select(family + 'ImageModel', family === 'gpt' ? 'GPT 绘图版本' : 'Gemini 绘图版本', [['', '自动使用首个可用版本'], ...(view.imageModels ?? []).filter(x => x.family === family).map(x => [x.id, x.name ?? x.id])])),
      select('defaultImageProvider', '默认绘图来源', [['gpt', 'GPT'], ['gemini', 'Gemini']]),
      select('imageScope', '自动添加绘图工具', [['main', '主 Bot'], ['all', '所有 Bot'], ['manual', '仅加入工具库，由我分配']]),
      h('small', null, '所选的两个版本会提供给原生 MCP 绘图工具；未指定版本时使用默认来源。'),
      view.imageAliases?.length > 0 && h('p', { style: { fontSize: 12, opacity: .75, overflowWrap: 'anywhere' } }, '已核对当前 Magpie MCP：' + view.imageAliases.map(x => x.requested.replace('codex/', '')).join('、') + ' 均映射到 ' + view.imageAliases[0].resolved + '。此通道未独立透传这些型号；上游实际版本未报告。独立提供的新版本会自动列入选择。'),
      view.tools?.imageError && h('p', { role: 'status' }, view.tools.imageError)),
    h('section', { style: style.card }, h('h3', null, '视频生成'), checkbox('videoEnabled', '启用视频生成工具，复用统一 API 和 Key'),
      h('label', { style: style.row }, '网页登录入口', h('input', { type: 'url', 'aria-label': '网页登录入口', style: { ...style.input, flex: 1 }, value: form.videoLoginURL ?? '', placeholder: '部署者提供的网页登录管理地址', onChange: e => set('videoLoginURL', e.target.value) })),
      view.videoLoginURL && h('p', null, h('a', { href: view.videoLoginURL, target: '_blank', rel: 'noopener noreferrer', style: style.button }, '浏览器登录 Gemini（自动保存会话）')),
      select('videoModel', '视频版本', [['', '自动使用首个可用版本'], ...(view.videoModels ?? []).map(x => [x.id, x.name])]),
      h('p', { role: 'status' }, view.videoModels?.length ? `已发现 ${view.videoModels.length} 个视频版本。生成中会查询原任务，不能重复提交。` : '尚未发现可用视频模型。Gemini 网页通道需要在服务器单独授权网页账号，现有 Antigravity 登录不能代替。'),
      h('small', null, '专用服务器浏览器可在登录后自动保存网页会话，无需手动复制 Cookie；Google 密码和二次验证由你输入。支持文字生成视频和参考图输入，使用账号当前视频模型；时长和比例是提示请求。视频下载链接不含网关 Key。')),
    h('section', { style: style.card }, h('h3', null, '搜索与优先级'), checkbox('searchEnabled', '启用原生 web_search / web_fetch，经 Magpie 转发'),
      policy?.error ? h('p', { role: 'status' }, policy.error) : policy && h(React.Fragment, null,
        h('label', { style: style.row }, '优先搜索类别', h('select', { 'aria-label': '优先搜索类别', style: style.input, value: policy.first, onChange: e => P(p => ({ ...p, first: e.target.value })) }, h('option', { value: 'model' }, '模型搜索 → 搜索 API'), h('option', { value: 'api' }, '搜索 API → 模型搜索'))),
        h('p', { style: { fontSize: 12, opacity: .7 } }, '此处修改服务器全局搜索顺序，使用该 Magpie 的客户端都会生效。类别内按顺序尝试，失败、限流或无结果时自动回退。'),
        h('h4', null, '模型搜索顺序'),
        ...(policy.modelOrder ?? []).map((id, i, list) => h('div', { key: id, style: style.row }, h('span', { style: { flex: 1 } }, `${i + 1}. ${policy.modelChoices.find(x => x.id === id)?.name ?? id}`), button('上移', () => move('modelOrder', i, -1), i === 0), button('下移', () => move('modelOrder', i, 1), i === list.length - 1), button('移出顺序', () => P(p => ({ ...p, modelOrder: p.modelOrder.filter(x => x !== id) }))))),
        h('label', { style: style.row }, '添加搜索模型', h('select', { 'aria-label': '添加搜索模型', style: style.input, value: '', onChange: e => { const id = e.target.value; if (id) P(p => ({ ...p, modelOrder: [...p.modelOrder, id] })); } }, h('option', { value: '' }, '选择来源…'), ...(policy.modelChoices ?? []).filter(x => !policy.modelOrder.includes(x.id)).map(x => h('option', { key: x.id, value: x.id }, x.name)))),
        h('h4', null, '搜索 API 顺序'),
        ...(policy.apis ?? []).map((item, i, list) => h('div', { key: item.id, style: style.row }, h('label', { style: { flex: 1 } }, h('input', { type: 'checkbox', checked: item.enabled, onChange: e => P(p => ({ ...p, apis: p.apis.map(x => x.id === item.id ? { ...x, enabled: e.target.checked } : x) })) }), ` ${i + 1}. ${item.name}${item.ready ? '' : '（尚未就绪）'}`), button('上移', () => move('apis', i, -1), i === 0), button('下移', () => move('apis', i, 1), i === list.length - 1))),
        button('保存搜索优先级', async () => { P(await subscriptionAPI('search-policy', { revision: policy.revision, first: policy.first, modelOrder: policy.modelOrder, apis: policy.apis.map(({ id, enabled }) => ({ id, enabled })) })); return '搜索优先级已保存到 Magpie。'; }))),
    h('div', { style: style.row }, button('保存并应用订阅设置', async () => { await subscriptionAPI('save', form); await ensureImageBinding(); await refresh(); return '订阅设置已保存并应用。'; }), button('重新读取设置', refresh)),
    message && h('p', { role: 'status', style: { padding: 12, borderRadius: 8, background: '#8882' } }, message));
}
export function registerSubscriptionUI(ctx) {
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'magpie-subscription', order: 86, label: () => 'Magpie 订阅' }, SubscriptionSettings)), 'magpie-subscription:settings');
  ctx.effect(() => { let stopped = false;
    const refresh = () => { if (!stopped) void ensureImageBinding().catch(() => {}); };
    refresh(); const timer = setInterval(refresh, 30000); return () => { stopped = true; clearInterval(timer); };
  }, 'magpie-subscription:image-binding');
}
