/* Home weather station: discovery, live readings, 24-hour history chart.

   The station serves this app from the same origin, so by default the API is just
   /api/* with no configuration. A different host can be set manually, but only
   when this page is itself on http — an https page may not read an http endpoint. */
(function () {
  'use strict';
  const { fmt: f } = window.WX;
  const NS = 'http://www.w3.org/2000/svg';

  const state = {
    base: null,        // resolved API base ('' = same origin)
    online: false,
    current: null,
    history: null,
    hours: 24,
    blocked: false,    // https page + http station
    timer: null,
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(`skycast:${k}`); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(`skycast:${k}`, JSON.stringify(v)); } catch (_) {} },
  };

  const trim = (u) => String(u || '').replace(/\/+$/, '');

  async function getJSON(url, timeoutMs = 4000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (!type.includes('json')) throw new Error('not a station endpoint');
      return res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /** Find a station: a saved custom URL first, otherwise this page's own origin. */
  async function detect() {
    const custom = trim(store.get('stationUrl', ''));
    const candidates = custom ? [custom] : [''];
    for (const base of candidates) {
      if (location.protocol === 'https:' && /^http:/i.test(base)) {
        state.blocked = true;
        continue;
      }
      try {
        const health = await getJSON(`${base}/api/health`, 3000);
        if (health && health.service === 'skycast-station') {
          state.base = base;
          state.online = true;
          return true;
        }
      } catch (_) { /* nothing listening here — that's the normal case */ }
    }
    state.online = false;
    return false;
  }

  async function refresh() {
    if (!state.online) return;
    try {
      const [current, history] = await Promise.all([
        getJSON(`${state.base}/api/current`),
        getJSON(`${state.base}/api/history?hours=${state.hours}&points=240`),
      ]);
      state.current = current;
      state.history = history;
      render();
    } catch (err) {
      state.online = false;
      render();
    }
  }

  /* ---------- pressure trend, the classic short-range signal ---------- */
  function trendInfo(pa) {
    if (pa == null) return null;
    const hpa = pa / 100;
    const mag = Math.abs(hpa);
    const dir = hpa > 0 ? 'rising' : 'falling';
    let word;
    if (mag < 0.5) return { text: 'Steady', hint: 'Settled conditions holding.', arrow: '→', hpa };
    if (mag < 1.5) word = `Slowly ${dir}`;
    else if (mag < 3.5) word = dir.charAt(0).toUpperCase() + dir.slice(1);
    else word = `Rapidly ${dir}`;
    const hint = hpa > 0
      ? 'Rising pressure usually means clearing or settled weather.'
      : 'Falling pressure often runs ahead of clouds, wind or rain.';
    return { text: word, hint, arrow: hpa > 0 ? '↑' : '↓', hpa };
  }

  /* ---------- 24-hour station chart (single series: no legend needed) ---------- */
  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function niceStep(span) {
    return [1, 2, 5, 10, 20, 25, 50].find((s) => s >= span / 4) || 50;
  }

  function renderChart(container, points, tz) {
    container.replaceChildren();
    if (!points || points.length < 2) {
      const p = document.createElement('p');
      p.className = 'station-empty';
      p.textContent = 'Collecting readings… the chart appears once the station has a few minutes of history.';
      container.appendChild(p);
      return;
    }

    const W = Math.max(280, container.clientWidth);
    const narrow = W < 560;
    const H = narrow ? 140 : 168;
    const M = { left: 38, right: 10, top: 20, bottom: 22 };

    const temps = points.map((p) => f.tempValue(f.cToF(p.temp_c)));
    const tMin = Math.min(...temps), tMax = Math.max(...temps);
    const step = niceStep(Math.max(4, tMax - tMin));
    const lo = Math.floor(tMin / step) * step;
    const hi = Math.max(lo + step, Math.ceil(tMax / step) * step);

    const t0 = points[0].ts, t1 = points[points.length - 1].ts;
    const span = Math.max(1, t1 - t0);
    const x = (ts) => M.left + ((ts - t0) / span) * (W - M.left - M.right);
    const y = (v) => M.top + (1 - (v - lo) / (hi - lo)) * (H - M.top - M.bottom);

    const svg = el('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `Station temperature over the last ${state.hours} hours, ranging from ${f.temp(f.cToF(Math.min(...points.map((p) => p.temp_c))))} to ${f.temp(f.cToF(Math.max(...points.map((p) => p.temp_c))))}`,
    });
    container.appendChild(svg);

    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      el('line', { class: 'grid-line', x1: M.left, x2: W - M.right, y1: yy, y2: yy }, svg);
      const t = el('text', { class: 'ax-text', x: M.left - 6, y: yy + 4, 'text-anchor': 'end' }, svg);
      t.textContent = `${Math.round(v)}°`;
    }

    // midnight dividers + time ticks
    let lastDay = null;
    points.forEach((p) => {
      const d = new Date(p.ts * 1000);
      const key = f.dayKey(d, tz);
      if (lastDay && key !== lastDay) {
        const xx = Math.round(x(p.ts)) + 0.5;
        el('line', { class: 'day-line', x1: xx, x2: xx, y1: M.top - 4, y2: H - M.bottom }, svg);
      }
      lastDay = key;
    });
    const ticks = narrow ? 3 : 5;
    for (let i = 0; i <= ticks; i++) {
      const ts = t0 + (span * i) / ticks;
      const t = el('text', {
        class: 'ax-text', x: x(ts), y: H - 6,
        'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle',
      }, svg);
      t.textContent = f.hourLabel(new Date(ts * 1000), tz);
    }

    const pts = points.map((p, i) => [x(p.ts), y(temps[i])]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    el('path', { class: 'temp-area', d: `${d}L${pts[pts.length - 1][0].toFixed(1)},${H - M.bottom}L${pts[0][0].toFixed(1)},${H - M.bottom}Z` }, svg);
    el('path', { class: 'temp-line', d }, svg);

    // direct labels on the extremes only
    const iMax = temps.indexOf(tMax), iMin = temps.indexOf(tMin);
    const clampX = (v) => Math.max(M.left + 14, Math.min(W - M.right - 14, v));
    [[iMax, -9], [iMin, 17]].forEach(([i, dy], k) => {
      if (k === 1 && iMin === iMax) return;
      el('circle', { cx: pts[i][0], cy: pts[i][1], r: 4, fill: 'var(--series-temp)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
      const t = el('text', { class: 'val-label', x: clampX(pts[i][0]), y: pts[i][1] + dy, 'text-anchor': 'middle' }, svg);
      t.textContent = f.temp(f.cToF(points[i].temp_c));
    });

    // current reading marker at the right edge
    const last = pts[pts.length - 1];
    el('circle', { cx: last[0], cy: last[1], r: 4.5, fill: 'var(--series-temp)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);

    // crosshair tooltip
    const cross = el('line', { class: 'crosshair', y1: M.top - 4, y2: H - M.bottom, visibility: 'hidden' }, svg);
    const dot = el('circle', { class: 'cross-dot', r: 5, visibility: 'hidden' }, svg);
    const tip = document.getElementById('tooltip');

    function at(ev) {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      let best = 0, bestD = Infinity;
      pts.forEach((p, i) => { const dd = Math.abs(p[0] - px); if (dd < bestD) { bestD = dd; best = i; } });
      const p = points[best];
      cross.setAttribute('x1', pts[best][0]); cross.setAttribute('x2', pts[best][0]);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', pts[best][0]); dot.setAttribute('cy', pts[best][1]);
      dot.setAttribute('visibility', 'visible');

      tip.replaceChildren();
      const time = document.createElement('div');
      time.className = 'tt-time';
      const when = new Date(p.ts * 1000);
      time.textContent = `${f.weekday(when, tz)} ${f.timeLabel(when, tz)}`;
      tip.appendChild(time);
      const row = (color, value, name) => {
        const r = document.createElement('div'); r.className = 'tt-row';
        const k = document.createElement('span'); k.className = 'tt-key'; k.style.background = color;
        const v = document.createElement('span'); v.className = 'tt-val'; v.textContent = value;
        const n = document.createElement('span'); n.className = 'tt-name'; n.textContent = name;
        r.append(k, v, n); return r;
      };
      tip.appendChild(row('var(--series-temp)', f.temp(f.cToF(p.temp_c)), 'Temperature'));
      if (p.humidity != null) tip.appendChild(row('var(--series-precip)', f.percent(p.humidity), 'Humidity'));
      if (p.samples > 1) {
        const extra = document.createElement('div');
        extra.className = 'tt-cond';
        extra.textContent = `${f.temp(f.cToF(p.temp_min))} – ${f.temp(f.cToF(p.temp_max))} across ${p.samples} readings`;
        tip.appendChild(extra);
      }
      tip.hidden = false;
      const box = tip.getBoundingClientRect();
      let left = ev.clientX + 16;
      if (left + box.width > window.innerWidth - 8) left = ev.clientX - box.width - 16;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, Math.min(ev.clientY - box.height / 2, window.innerHeight - box.height - 8))}px`;
    }
    svg.addEventListener('pointermove', at);
    svg.addEventListener('pointerdown', at);
    svg.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  }

  /* ---------- the card ---------- */
  function statTile(label, value, sub) {
    const d = document.createElement('div');
    d.className = 'st-tile';
    const l = document.createElement('div'); l.className = 'st-label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'st-value'; v.textContent = value;
    d.append(l, v);
    if (sub) { const s = document.createElement('div'); s.className = 'st-sub'; s.textContent = sub; d.append(s); }
    return d;
  }

  /** How the backyard compares with the official NWS station the app is showing. */
  function comparison(stationF, data) {
    if (!data || !data.obs || !f.isNum(data.obs.tempF)) return null;
    const diff = stationF - data.obs.tempF;
    const mag = Math.abs(f.tempDelta(diff));
    const dist = f.state.units === 'metric'
      ? `${Math.round(data.obs.distanceKm)} km`
      : `${Math.round(data.obs.distanceKm / 1.609344)} mi`;
    if (mag < 0.5) {
      return `Matching ${data.obs.stationName}, the NWS station ${dist} away.`;
    }
    return `${mag.toFixed(1)}° ${diff > 0 ? 'warmer' : 'cooler'} than ${data.obs.stationName}, the NWS station ${dist} away.`;
  }

  function render() {
    const card = document.getElementById('station');
    const body = document.getElementById('station-body');
    if (!card || !body) return;

    if (!state.online) {
      card.hidden = !state.blocked;
      if (state.blocked) {
        body.replaceChildren();
        const p = document.createElement('p');
        p.className = 'station-empty';
        p.textContent = 'Your station serves plain HTTP, and this page is on HTTPS, so the browser blocks the connection. Open Skycast from the station itself to see live readings.';
        body.appendChild(p);
      }
      return;
    }

    card.hidden = false;
    const c = state.current;
    body.replaceChildren();

    if (!c || !c.available) {
      const p = document.createElement('p');
      p.className = 'station-empty';
      p.textContent = 'Station is online but has no readings yet.';
      body.appendChild(p);
      return;
    }

    document.getElementById('station-title').textContent = (c.station && c.station.name) || 'My station';

    const tempF = f.cToF(c.temperature_c);
    const tz = (window.WX.app && window.WX.app.timeZone()) || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // headline reading
    const head = document.createElement('div');
    head.className = 'st-head';
    const big = document.createElement('div');
    big.className = 'st-temp';
    big.textContent = Math.round(f.tempValue(tempF));
    const sup = document.createElement('sup');
    sup.textContent = `°${f.state.units === 'metric' ? 'C' : 'F'}`;
    big.appendChild(sup);
    const meta = document.createElement('div');
    meta.className = 'st-meta';
    const cmp = comparison(tempF, window.WX.app && window.WX.app.data());
    if (cmp) { const d = document.createElement('div'); d.className = 'st-compare'; d.textContent = cmp; meta.appendChild(d); }
    const age = document.createElement('div');
    age.className = 'st-age';
    const secs = Math.round(c.age_seconds);
    age.textContent = `Updated ${secs < 90 ? `${secs}s ago` : f.ago(new Date(c.observed_at * 1000))}`;
    meta.appendChild(age);
    head.append(big, meta);
    body.appendChild(head);

    // tiles
    const tiles = document.createElement('div');
    tiles.className = 'st-tiles';
    const e = c.last_24h || {};
    tiles.appendChild(statTile('Humidity', f.percent(c.humidity)));
    tiles.appendChild(statTile('Dew point', f.temp(f.cToF(c.dewpoint_c))));
    const tr = trendInfo(c.pressure_trend_3h_pa);
    tiles.appendChild(statTile(
      'Pressure',
      f.pressure(c.sea_level_pressure_pa),
      tr ? `${tr.arrow} ${tr.text}` : 'Trend after 3 h',
    ));
    if (f.isNum(e.temp_max_c) && f.isNum(e.temp_min_c)) {
      tiles.appendChild(statTile('24-hour range', `${f.temp(f.cToF(e.temp_min_c))} – ${f.temp(f.cToF(e.temp_max_c))}`));
    }
    body.appendChild(tiles);

    if (tr && tr.hint) {
      const hint = document.createElement('p');
      hint.className = 'st-hint';
      hint.textContent = `${tr.text} ${tr.hpa > 0 ? '+' : ''}${tr.hpa.toFixed(1)} hPa over 3 hours. ${tr.hint}`;
      body.appendChild(hint);
    }

    const chartWrap = document.createElement('div');
    chartWrap.className = 'st-chart';
    body.appendChild(chartWrap);
    renderChart(chartWrap, state.history && state.history.points, tz);

    const foot = document.createElement('div');
    foot.className = 'st-foot';
    const since = c.since ? new Date(c.since * 1000) : null;
    foot.textContent = `${c.samples.toLocaleString()} readings${since ? ` since ${f.monthDay(since, tz)}` : ''}`
      + ` · ${c.station.sensor}${c.station.sensor === 'mock' ? ' (simulated data)' : ''}`;
    body.appendChild(foot);
  }

  async function start() {
    const found = await detect();
    render();
    if (!found) return;
    await refresh();

    // A station configured with --lat/--lon can tell the app where home is, so a
    // wall display opens on the right forecast with nothing stored in the browser.
    const cfg = state.current && state.current.station;
    const app = window.WX.app;
    if (cfg && f.isNum(cfg.lat) && f.isNum(cfg.lon) && app && !app.hasPlace()) {
      app.loadPlace({ lat: cfg.lat, lon: cfg.lon, name: null, sub: null });
    }
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 30000);
  }

  window.WX = window.WX || {};
  window.WX.station = { start, refresh, render, state, detect };
})();
