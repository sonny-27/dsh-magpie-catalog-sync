import { parseLegacyModel } from './catalog.mjs';
export const DEFAULT_EFFORT = '__default__';

export function identifyBot(menuLabel, bots) {
  return (bots ?? []).find(bot => menuLabel === `${bot.name} 的模型` || menuLabel === `Model for ${bot.name}`);
}

export function describeSelection(bot, controls) {
  const ref = bot?.model ?? bot?.appliedModel;
  const prefix = controls?.providerId + '/';
  if (!ref?.startsWith(prefix)) return undefined;
  const id = ref.slice(prefix.length), mapping = new Map((controls.entries ?? []).map(x => [x.id, x]));
  const entry = parseLegacyModel(id, mapping);
  const model = controls.models?.find(x => x.id === entry?.canonical);
  if (!entry || !model) return undefined;
  const choice = controls.choices?.find(x => x.botId === bot.id && x.model === model.id)
    ?? controls.choices?.find(x => x.botId === '__profile_default__' && x.model === model.id);
  const asked = (bot.effort === 'off' ? 'none' : bot.effort) ?? choice?.defaultEffort ?? entry.defaultEffort;
  return { ref, id, entry, model, choice, legacy: entry.legacy,
    effort: model.reasoningEfforts.includes(asked) ? asked : DEFAULT_EFFORT,
    tier: choice?.tier ?? entry.serviceTier ?? '' };
}

export function selectionPayload(bot, controls, tier) {
  const selected = describeSelection(bot, controls);
  if (!selected) throw new Error('当前模型不属于此 Magpie 同步供应商');
  if (tier && !selected.model.serviceTiers.some(x => x.id === tier)) throw new Error('模型未提供此速度模式');
  return { botId: bot.id, model: selected.model.id, tier,
    sessionIds: [...new Set([bot.id, bot.sessionId, ...(bot.parts ?? [])].filter(Boolean))] };
}

export function legacyMigration(bot, controls) {
  const selected = describeSelection(bot, controls);
  if (!selected?.legacy) return undefined;
  const supported = selected.model.nativeEfforts ?? [];
  return {
    preference: { ...selectionPayload(bot, controls, selected.tier), defaultEffort: selected.choice?.defaultEffort ?? selected.entry.defaultEffort },
    botPatch: { id: bot.id, model: controls.providerId + '/' + selected.model.id, effort: supported.includes(bot.effort) ? bot.effort : null },
  };
}
