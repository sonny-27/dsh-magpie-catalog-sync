import { identifyBot, describeSelection, selectionPayload, legacyMigration } from './lib/ui-controls.mjs';
import { createSpeedIcon } from './lib/speed-icons.mjs';
import { registerSubscriptionUI } from './lib/settings-ui.mjs';

export const inject = ['slots'];
const ROOT = 'api/dsh-magpie-catalog-sync';
const CSS = `
.bt-effort-label:has(>.mpcs-speed-bolt){display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.mpcs-speed-bolt{display:inline-flex;align-items:center;justify-content:center;flex:0 0 20px;width:20px;height:20px;border:0;padding:3px;margin:0;border-radius:5px;background:transparent;color:inherit;opacity:.55;vertical-align:middle;cursor:pointer}
.mpcs-speed-bolt:hover{background:color-mix(in srgb,currentColor 7%,transparent);opacity:1}
.mpcs-speed-bolt[aria-pressed="true"]{color:#627cff;opacity:1}
.mpcs-speed-bolt:disabled{opacity:.25;cursor:default}.mpcs-speed-bolt svg{width:16px;height:16px;pointer-events:none}
.mpcs-speed-only{display:flex;align-items:center;padding:0 10px 7px}.mpcs-speed-note{font-size:11px;opacity:.6}
.mpcs-speed-menu{position:fixed;z-index:2147483000;min-width:148px;padding:5px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:9px;box-shadow:0 7px 24px #0002;font:inherit}
.mpcs-speed-option{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:5px;padding:7px 9px;background:transparent;color:inherit;text-align:left;font:inherit;font-size:12px;cursor:pointer}
.mpcs-speed-option:hover,.mpcs-speed-option:focus{outline:none;background:color-mix(in srgb,currentColor 7%,transparent)}
.mpcs-speed-check{width:14px;color:#627cff}
.mpcs-speed-option svg{width:15px;height:15px;flex:0 0 15px}
.bt-model-scroll button[title*="~magpie-sync~"],.bt-model-chip[title*="~magpie-sync~"]{display:none!important}
`;

export function apply(ctx) {
  registerSubscriptionUI(ctx);
  ctx.effect(() => {
    let stopped = false, scheduled, running = false, controls, controlsAt = 0, roster, rosterAt = 0;
    const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
    const roots = new Map(), refreshed = new Set();
    const speedName = tier => tier?.id === 'ultrafast' ? 'Ultra Fast' : tier?.name ?? '默认';
    async function call(endpoint, payload) {
      const response = await fetch('api/bot', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload: payload ?? null }) });
      if (!response.ok) throw new Error(`DSBot HTTP ${response.status}`);
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message ?? 'DSBot 请求失败');
      return result.value;
    }
    async function readControls() {
      if (!controls || Date.now() - controlsAt > 10000) {
        const response = await fetch(ROOT + '/controls', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Magpie 信息尚未加载');
        controls = await response.json(); controlsAt = Date.now();
      }
      return controls;
    }
    async function readRoster(force = false) {
      if (force || !roster || Date.now() - rosterAt > 1000) {
        const value = await call('state');
        roster = { bots: (value.bots ?? []).map(({ id, name, model, appliedModel, effort, sessionId, parts }) => ({ id, name, model, appliedModel, effort, sessionId, parts })) };
        rosterAt = Date.now();
      }
      return roster;
    }
    async function configure(endpoint, body = {}) {
      const response = await fetch(ROOT + '/' + endpoint, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-magpie-catalog-sync': '1' }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? '保存速度失败');
      controlsAt = 0; return value;
    }
    let migrating = false, migrationFinished = false;
    async function migrateLegacy() {
      if (stopped || migrating || migrationFinished || (!window.dshBot && !document.querySelector('.bt-model-menu'))) return;
      migrating = true;
      try {
        const [data, current] = await Promise.all([readControls(), readRoster(true)]);
        let changed = false;
        for (const bot of current.bots) {
          const migration = legacyMigration(bot, data);
          if (!migration) continue;
          await configure('selection', migration.preference);
          await call('update-bot', migration.botPatch); changed = true;
        }
        if (changed) { const result = await configure('reconcile'); await call('models'); rosterAt = 0; migrationFinished = result.compatibilityEntries === 0; }
        else migrationFinished = data.compatibilityEntries === 0;
      } catch { /* Wait for the owner connection and initial catalog. */ }
      finally { migrating = false; }
    }
    function cleanup(menu) {
      const current = roots.get(menu);
      current?.closeMenu?.();
      current?.button.remove(); current?.fallback?.remove(); roots.delete(menu);
    }
    function makeButton(menu) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'mpcs-speed-bolt';
      button.append(createSpeedIcon('default'));
      const state = { button, pending: false };
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      state.closeMenu = () => { state.popup?.remove(); state.popup = undefined; button.setAttribute('aria-expanded', 'false'); };
      button.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.stopPropagation(); });
      async function save(next) {
        state.closeMenu();
        if (state.pending) return;
        state.pending = true; button.disabled = true;
        try {
          const latest = await readRoster(true), bot = latest.bots.find(x => x.id === state.bot.id);
          const current = describeSelection(bot, state.data);
          if (!current || current.model.id !== state.selection.model.id) throw new Error('模型刚刚改变，请重新打开菜单');
          await configure('selection', selectionPayload(bot, state.data, next));
        } catch (error) { button.title = error.message; }
        finally { state.pending = false; void render(); }
      }
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (state.pending) return;
        if (state.popup) { state.closeMenu(); return; }
        const popup = document.createElement('div'); popup.className = 'bt-menu mpcs-speed-menu'; popup.setAttribute('role', 'menu'); popup.setAttribute('aria-label', '速度模式');
        const rect = button.getBoundingClientRect();
        popup.style.left = Math.max(8, Math.min(innerWidth - 164, rect.left)) + 'px';
        popup.style.bottom = Math.max(8, innerHeight - rect.top + 5) + 'px';
        popup.style.background = getComputedStyle(menu).backgroundColor;
        popup.style.color = getComputedStyle(menu).color;
        popup.style.backdropFilter = getComputedStyle(menu).backdropFilter;
        const tiers = [{ id: '', name: '默认' }, ...state.selection.model.serviceTiers];
        for (const tier of tiers) {
          const option = document.createElement('button'); option.type = 'button'; option.className = 'mpcs-speed-option'; option.setAttribute('role', 'menuitemradio');
          const active = tier.id === state.selection.tier; option.setAttribute('aria-checked', String(active)); option.title = tier.description ?? '';
          const check = document.createElement('span'); check.className = 'mpcs-speed-check'; check.textContent = active ? '✓' : ''; check.setAttribute('aria-hidden', 'true');
          const text = document.createElement('span'); text.textContent = speedName(tier); option.append(check, createSpeedIcon(tier.id || 'default'), text);
          option.addEventListener('click', () => void save(tier.id)); popup.append(option);
        }
        popup.addEventListener('mousedown', event => event.stopPropagation());
        popup.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.stopPropagation(); state.closeMenu(); button.focus({ preventScroll: true }); return; }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const options = [...popup.querySelectorAll('button')], index = options.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[next].focus({ preventScroll: true });
        });
        state.popup = popup; button.setAttribute('aria-expanded', 'true'); document.body.append(popup);
        popup.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
      });
      return state;
    }
    async function render() {
      if (stopped || running) return;
      const menus = [...document.querySelectorAll('.bt-model-menu[role="menu"]')];
      for (const [menu] of roots) if (!menu.isConnected) cleanup(menu);
      if (!menus.length) return;
      running = true;
      try {
        const [data, currentRoster] = await Promise.all([readControls(), readRoster()]);
        if (stopped) return;
        for (const menu of menus) {
          const bot = identifyBot(menu.getAttribute('aria-label'), currentRoster.bots);
          const selection = describeSelection(bot, data);
          if (!selection) { cleanup(menu); continue; }
          if (selection.legacy) { migrationFinished = false; void migrateLegacy(); }
          let state = roots.get(menu);
          if (!state) { state = makeButton(menu); roots.set(menu, state); }
          Object.assign(state, { bot, selection, data });
          const nativeLabel = menu.querySelector('.bt-effort-head .bt-effort-label');
          if (nativeLabel) {
            state.fallback?.remove(); state.fallback = undefined;
            if (state.button.parentElement !== nativeLabel) nativeLabel.prepend(state.button);
          } else {
            const foot = menu.querySelector('.bt-model-foot');
            if (!foot) continue;
            if (!state.fallback?.isConnected) {
              const fallback = document.createElement('div'); fallback.className = 'mpcs-speed-only';
              const note = document.createElement('span'); note.className = 'mpcs-speed-note'; note.textContent = '速度';
              fallback.append(state.button, note); foot.prepend(fallback); state.fallback = fallback;
            }
            // Refresh the native catalog; its existing component renders reasoning.
            const refreshKey = selection.ref + ':' + data.updatedAt;
            if (selection.model.reasoningEfforts.length && !refreshed.has(refreshKey)) {
              refreshed.add(refreshKey); void call('models').catch(() => {});
            }
          }
          const tier = selection.model.serviceTiers.find(x => x.id === selection.tier);
          const supported = selection.model.serviceTiers.length > 0;
          state.button.disabled = state.pending || !supported;
          state.button.setAttribute('aria-pressed', String(Boolean(tier)));
          state.button.setAttribute('aria-label', '速度：' + speedName(tier));
          const iconMode = tier?.id ?? 'default';
          if (state.button.dataset.speedMode !== iconMode) { state.button.dataset.speedMode = iconMode; state.button.replaceChildren(createSpeedIcon(iconMode)); }
          state.button.title = supported ? `速度：${speedName(tier)}；点击选择速度，按上游规则消耗额度` : '此模型没有上游声明的加速档位';
        }
      } catch { /* A non-DSBot shell keeps using its own picker unchanged. */ }
      finally { running = false; }
    }
    const schedule = () => { clearTimeout(scheduled); scheduled = setTimeout(() => void render(), 70); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
    const outside = event => { for (const state of roots.values()) if (state.popup && !state.popup.contains(event.target) && !state.button.contains(event.target)) state.closeMenu(); };
    document.addEventListener('pointerdown', outside, true);
    const migrationTimer = setInterval(() => void migrateLegacy(), 5000); void migrateLegacy();
    const timer = setInterval(() => void render(), 1200); void render();
    return () => { stopped = true; clearTimeout(scheduled); clearInterval(timer); clearInterval(migrationTimer); observer.disconnect(); document.removeEventListener('pointerdown', outside, true); for (const [menu] of roots) cleanup(menu); style.remove(); };
  }, 'magpie-catalog-sync:dsbot-speed-button');
}
