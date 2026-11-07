import fs from 'node:fs/promises';
import path from 'node:path';

const keyOf = (bot, model) => JSON.stringify([bot, model]);
const validId = x => typeof x === 'string' && x.length > 0 && x.length < 512 && !/[\r\n\0]/.test(x);

export class PreferenceStore {
  constructor(file, botStateFile) {
    this.file = file; this.botStateFile = botStateFile;
    this.data = { version: 1, choices: [] }; this.sessions = new Map(); this.botMtime = -1;
  }
  async load() {
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.data.version !== 1 || !Array.isArray(this.data.choices)) throw new Error('无效的速度设置文件');
    this.index();
  }
  index() {
    this.choices = new Map(this.data.choices.map(x => [keyOf(x.botId, x.model), x]));
    for (const choice of this.data.choices) for (const session of choice.sessionIds ?? []) this.sessions.set(session, choice.botId);
  }
  async set(input, catalog) {
    const run = async () => {
      const record = catalog.records.find(x => x.id === input.model);
      if (!record || !validId(input.botId)) throw Object.assign(new Error('无效的模型或 Bot'), { status: 400 });
      if (input.tier !== undefined && typeof input.tier !== 'string') throw Object.assign(new Error('无效的速度模式'), { status: 400 });
      if (input.sessionIds !== undefined && !Array.isArray(input.sessionIds)) throw Object.assign(new Error('无效的会话列表'), { status: 400 });
      if (input.tier && !record.serviceTiers.some(x => x.id === input.tier)) throw Object.assign(new Error('模型未提供此速度档位'), { status: 400 });
      if (input.defaultEffort && !record.reasoningEfforts.includes(input.defaultEffort)) throw Object.assign(new Error('模型未提供此默认思考档位'), { status: 400 });
      const previous = this.choices.get(keyOf(input.botId, input.model));
      const sessionIds = [...new Set([input.botId, ...(previous?.sessionIds ?? []), ...(input.sessionIds ?? [])])];
      if (sessionIds.length > 1000 || sessionIds.some(x => !validId(x))) throw Object.assign(new Error('无效的会话 ID'), { status: 400 });
      const next = { ...previous, botId: input.botId, model: input.model, tier: input.tier ?? previous?.tier ?? '', sessionIds,
        ...(input.defaultEffort === undefined ? {} : { defaultEffort: input.defaultEffort }), updatedAt: new Date().toISOString() };
      const data = { version: 1, choices: this.data.choices.filter(x => keyOf(x.botId, x.model) !== keyOf(input.botId, input.model)).concat(next) };
      if (data.choices.length > 10000) throw new Error('速度设置数量超过上限');
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(this.file + '.tmp', this.file);
      this.data = data; this.index(); return next;
    };
    this.pending = (this.pending ?? Promise.resolve()).catch(() => {}).then(run);
    return this.pending;
  }
  get(botId, model) { return this.choices.get(keyOf(botId, model)); }
  async refreshBindings(force = false) {
    if (!this.botStateFile) return undefined;
    let stat;
    try { stat = await fs.stat(this.botStateFile); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (!force && stat.mtimeMs === this.botMtime) return this.botState;
    const state = JSON.parse(await fs.readFile(this.botStateFile, 'utf8'));
    const snapshot = { bots: {} };
    for (const bot of Object.values(state.bots ?? {})) {
      snapshot.bots[bot.id] = { id: bot.id, model: bot.model, effort: bot.effort, segments: bot.segments?.map(x => ({ sessionId: x.sessionId })) };
      this.sessions.set(bot.id, bot.id);
      for (const part of bot.segments ?? []) if (validId(part.sessionId)) this.sessions.set(part.sessionId, bot.id);
    }
    for (const room of Object.values(state.rooms ?? {})) {
      for (const [botId, session] of Object.entries(room.sessions ?? {})) if (validId(session)) this.sessions.set(session, botId);
      for (const [botId, parts] of Object.entries(room.segments ?? {})) for (const part of Array.isArray(parts) ? parts : []) if (validId(part.sessionId)) this.sessions.set(part.sessionId, botId);
    }
    this.botMtime = stat.mtimeMs; this.botState = snapshot; return snapshot;
  }
  async forRequest(sessionId, model) {
    await this.refreshBindings();
    const botId = this.sessions.get(sessionId);
    return (botId && this.get(botId, model)) || this.get('__profile_default__', model);
  }
  view() { return this.data.choices.map(({ botId, model, tier, defaultEffort }) => ({ botId, model, tier, defaultEffort })); }
}
