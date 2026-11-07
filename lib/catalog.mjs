export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ALIAS = '~magpie-sync~';
const positive = n => Number.isSafeInteger(n) && n > 0 ? n : undefined;
const label = (...values) => values.find(x => typeof x === 'string' && x.trim())?.trim();

export function normalizeBaseURL(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Magpie 地址必须是没有账号、查询参数或片段的 HTTP(S) Base URL');
  }
  if (url.protocol === 'http:') {
    const host = url.hostname;
    if (!/^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/.test(host)) {
      throw new Error('公网 Magpie 地址必须使用 HTTPS');
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
  return url.toString().replace(/\/$/, '');
}

export function buildCatalog(reply, { supportedEfforts = THINKING_LEVELS, maxModels = 500, serviceTierOverrides = {} } = {}) {
  if (!Array.isArray(reply?.data)) throw new Error('Magpie 模型列表缺少 data 数组');
  const models = [], mapping = new Map(), records = [], ids = new Set();
  for (const raw of reply.data) {
    const id = label(raw?.id);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    if (raw.type && !['model', 'chat'].includes(raw.type)) continue;
    const name = label(raw.display_name, raw.name, id);
    const contextWindow = positive(raw.context_window ?? raw.context_length ?? raw.max_input_tokens);
    const advertisedMaxTokens = positive(raw.max_output_tokens ?? raw.maxOutputTokens);
    // DSH reserves this entire value for completion before it prices messages.
    // A shared context ceiling cannot also be the default completion reserve.
    const maxTokens = contextWindow > 1 && advertisedMaxTokens >= contextWindow
      ? Math.max(1, Math.min(32768, Math.floor(contextWindow / 8))) : advertisedMaxTokens;
    const input = [...new Set((raw.modalities?.input ?? raw.input ?? ['text']).filter(x => ['text', 'image'].includes(x)))];
    const efforts = [...new Set((raw.reasoning_levels ?? raw.supported_reasoning_levels?.map(x => typeof x === 'string' ? x : x.effort) ?? []).filter(x => typeof x === 'string'))];
    const reasoningEfforts = {};
    for (const effort of efforts) {
      const key = effort === 'none' ? 'off' : effort;
      if (supportedEfforts.includes(key)) reasoningEfforts[key] = effort;
    }
    const hasThinking = Object.keys(reasoningEfforts).some(x => x !== 'off');
    const unsupported = efforts.filter(x => !supportedEfforts.includes(x === 'none' ? 'off' : x));
    const tiers = [...new Map([...(raw.service_tiers ?? []), ...(serviceTierOverrides[id] ?? [])].map(x => typeof x === 'string' ? { id: x, name: x } : x)
      .filter(x => /^[a-z][a-z0-9_-]{0,40}$/.test(x?.id ?? '') && !['default', 'auto'].includes(x.id))
      .map(x => [x.id, { id: x.id, name: label(x.name, x.id), description: label(x.description) }])).values()];
    const common = { ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), input: input.length ? input : ['text'] };
    models.push({ id, name, ...common, reasoningEfforts: hasThinking ? { ...reasoningEfforts } : false });
    mapping.set(id, { canonical: id, advertisedTiers: tiers.map(x => x.id), advertisedEfforts: efforts });
    records.push({ id, name, contextWindow, maxTokens, ...(maxTokens !== advertisedMaxTokens ? { advertisedMaxTokens, completionBudgetAdjusted: true } : {}), input, reasoningEfforts: efforts, nativeEfforts: Object.keys(reasoningEfforts), serviceTiers: tiers, unsupportedEfforts: unsupported });
  }
  if (!models.length) throw new Error('Magpie 返回了空的可对话模型列表，保留上次同步结果');
  if (models.length > maxModels) throw new Error(`同步后的模型入口超过 ${maxModels} 个，未修改当前模型列表`);
  return { models, mapping, records };
}

export function parseLegacyModel(id, mapping) {
  if (mapping.has(id)) return { ...mapping.get(id), legacy: false };
  const at = id.indexOf(ALIAS);
  if (at < 0) return undefined;
  const base = mapping.get(id.slice(0, at));
  if (!base) return undefined;
  const params = new URLSearchParams(id.slice(at + ALIAS.length));
  if ([...params.keys()].some(x => !['tier', 'effort'].includes(x))) return undefined;
  const tier = params.get('tier') || undefined, effort = params.get('effort') || undefined;
  if (tier && !base.advertisedTiers.includes(tier)) return undefined;
  if (effort && !base.advertisedEfforts.includes(effort)) return undefined;
  return { ...base, legacy: true, serviceTier: tier, defaultEffort: effort };
}

export function rewriteRequest(body, path, mapping, preference) {
  if (typeof body?.model !== 'string') throw Object.assign(new Error('请求缺少 model'), { status: 400 });
  let target = parseLegacyModel(body.model, mapping);
  if (!target) throw Object.assign(new Error('此模型不在已同步的 Magpie 列表中'), { status: 404 });
  const next = { ...body, model: target.canonical };
  if (preference) {
    if (preference.tier && !target.advertisedTiers.includes(preference.tier)) throw Object.assign(new Error('所选速度当前不可用，请重新选择'), { status: 400 });
    target = { ...target, serviceTier: preference.tier || undefined, defaultEffort: preference.defaultEffort };
    if (!preference.tier) delete next.service_tier;
  }
  if (target.serviceTier) next.service_tier = target.serviceTier;
  const explicit = path.endsWith('/responses') ? next.reasoning?.effort : path.endsWith('/messages') ? next.output_config?.effort : next.reasoning_effort;
  if (target.defaultEffort && explicit == null) {
    if (path.endsWith('/responses')) next.reasoning = { ...next.reasoning, effort: target.defaultEffort };
    else if (path.endsWith('/messages')) next.output_config = { ...next.output_config, effort: target.defaultEffort };
    else next.reasoning_effort = target.defaultEffort;
  }
  return { body: next, target };
}
