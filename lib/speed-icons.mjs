const BOLT = 'M13 2 4 14h7l-1 8 10-12h-7l1-8Z';

export function speedIconSpec(mode) {
  return { viewBox: '0 0 24 24', mode,
    paths: mode === 'ultrafast'
      ? [{ d: BOLT, transform: 'translate(5 -1) scale(.78)' }, { d: BOLT, transform: 'translate(-1 2) scale(.78)' }]
      : [{ d: BOLT }] };
}

export function createSpeedIcon(mode, doc = document) {
  const spec = speedIconSpec(mode), ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', spec.viewBox); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('data-speed-mode', mode);
  for (const item of spec.paths) {
    const path = doc.createElementNS(ns, 'path'); path.setAttribute('d', item.d);
    if (item.transform) path.setAttribute('transform', item.transform);
    for (const [name, value] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' })) path.setAttribute(name, value);
    svg.append(path);
  }
  return svg;
}
