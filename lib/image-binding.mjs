// Scope controls automatic additions; it must not revoke manually attached tools.
export function bindingChanges(binding, state) {
  const name = binding.capability?.name;
  if (!name || binding.pendingConfiguration) return [];
  const mains = new Set(state.mainBotIds ?? []);
  return (state.bots ?? []).flatMap(bot => {
    const attached = Boolean(bot.capabilities?.includes(name));
    if (!binding.enabled) return attached ? [{ botId: bot.id, name, attached: false }] : [];
    const add = binding.scope === 'all' || binding.scope === 'main' && mains.has(bot.id);
    return add && !attached ? [{ botId: bot.id, name, attached: true }] : [];
  });
}
