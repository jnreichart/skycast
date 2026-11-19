/* Forecast accuracy: how NOAA's prediction for your grid compared with what your
   own sensor actually measured. Data comes from the station's /api/accuracy. */
(function () {
  'use strict';
  const { fmt: f } = window.WX;
  const NS = 'http://www.w3.org/2000/svg';

  const state = { data: null, lead: 24, loading: false };

  /** A temperature *difference* in °C, shown in the user's units. */
  const deltaDisplay = (c) => (c == null ? null : (f.state.units === 'metric' ? c : c * 9 / 5));
  const deltaText = (c, digits = 1) => {
    const v = deltaDisplay(c);
    return v == null ? '–' : `${v.toFixed(digits)}°`;
  };

  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const niceStep = (span) => [1, 2, 5, 10, 20, 25, 50].find((s) => s >= span / 4) || 50;

  async function load(base) {
    if (state.loading) return;
    state.loading = true;
    try {
      const res = await fetch(`${base}/api/accuracy?days=30&lead=${state.lead}&series_days=3`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
    } catch (_) {
      state.data = null;
    } finally {
      state.loading = false;
    }
    render();
  }

  /* ---------- forecast vs measured chart (2 series, so a legend is required) ---------- */
  function renderChart(container, points, tz) {
    container.replaceChildren();
    if (!points || points.length < 3) return;

    const W = Math.max(280, container.clientWidth);
    const narrow = W < 560;
    const H = narrow ? 150 : 178;
    const M = { left: 38, right: 10, top: 14, bottom: 22 };

    const toDisp = (c) => f.tempValue(f.cToF(c));
    const all = points.flatMap((p) => [toDisp(p.actual_c), toDisp(p.forecast_c)]);
    const lo0 = Math.min(...all), hi0 = Math.max(...all);
    const step = niceStep(Math.max(4, hi0 - lo0));
    const lo = Math.floor(lo0 / step) * step;
    const hi = Math.max(lo + step, Math.ceil(hi0 / step) * step);

    const t0 = points[0].ts, t1 = points[points.length - 1].ts;
    const span = Math.max(1, t1 - t0);
    const x = (ts) => M.left + ((ts - t0) / span) * (W - M.left - M.right);
    const y = (v) => M.top + (1 - (v - lo) / (hi - lo)) * (H - M.top - M.bottom);

    const svg = el('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `NOAA's ${state.lead}-hour forecast compared with what the station measured, over the last ${points.length} hours`,
    });
    container.appendChild(svg);

    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      el('line', { class: 'grid-line', x1: M.left, x2: W - M.right, y1: yy, y2: yy }, svg);
      const t = el('text', { class: 'ax-text', x: M.left - 6, y: yy + 4, 'text-anchor': 'end' }, svg);
      t.textContent = `${Math.round(v)}°`;
    }

    const ticks = narrow ? 3 : 5;
    for (let i = 0; i <= ticks; i++) {
      const ts = t0 + (span * i) / ticks;
      const d = new Date(ts * 1000);
      const t = el('text', {
        class: 'ax-text', x: x(ts), y: H - 6,
        'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle',
      }, svg);
      t.textContent = narrow ? f.hourLabel(d, tz) : `${f.weekday(d, tz)} ${f.hourLabel(d, tz)}`;
    }

    const line = (key, color, cls) => {
      const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(toDisp(p[key])).toFixed(1)}`).join('');
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: cls }, svg);
    };
    line('forecast_c', 'var(--series-precip)');
    line('actual_c', 'var(--series-temp)');

    const cross = el('line', { class: 'crosshair', y1: M.top - 4, y2: H - M.bottom, visibility: 'hidden' }, svg);
    const dotA = el('circle', { r: 4.5, fill: 'var(--series-temp)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg);
    const dotF = el('circle', { r: 4.5, fill: 'var(--series-precip)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg);
    const tip = document.getElementById('tooltip');

    function at(ev) {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      let best = 0, bestD = Infinity;
      points.forEach((p, i) => { const d = Math.abs(x(p.ts) - px); if (d < bestD) { bestD = d; best = i; } });
      const p = points[best];
      const px2 = x(p.ts);
      cross.setAttribute('x1', px2); cross.setAttribute('x2', px2); cross.setAttribute('visibility', 'visible');
      dotA.setAttribute('cx', px2); dotA.setAttribute('cy', y(toDisp(p.actual_c))); dotA.setAttribute('visibility', 'visible');
      dotF.setAttribute('cx', px2); dotF.setAttribute('cy', y(toDisp(p.forecast_c))); dotF.setAttribute('visibility', 'visible');

      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tt-time';
      const when = new Date(p.ts * 1000);
      head.textContent = `${f.weekday(when, tz)} ${f.hourLabel(when, tz)}`;
      tip.appendChild(head);
      const row = (color, value, name) => {
        const r = document.createElement('div'); r.className = 'tt-row';
        const k = document.createElement('span'); k.className = 'tt-key'; k.style.background = color;
        const v = document.createElement('span'); v.className = 'tt-val'; v.textContent = value;
        const n = document.createElement('span'); n.className = 'tt-name'; n.textContent = name;
        r.append(k, v, n); return r;
      };
      tip.appendChild(row('var(--series-temp)', f.temp(f.cToF(p.actual_c)), 'Measured'));
      tip.appendChild(row('var(--series-precip)', f.temp(f.cToF(p.forecast_c)), 'Forecast'));
      const miss = document.createElement('div');
      miss.className = 'tt-cond';
      const d = p.forecast_c - p.actual_c;
      miss.textContent = Math.abs(deltaDisplay(d)) < 0.05
        ? 'Exactly right'
        : `Forecast was ${deltaText(Math.abs(d))} too ${d > 0 ? 'warm' : 'cold'}`;
      tip.appendChild(miss);
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
      [cross, dotA, dotF].forEach((n) => n.setAttribute('visibility', 'hidden'));
      tip.hidden = true;
    });
  }

  function legend() {
    const wrap = document.createElement('div');
    wrap.className = 'acc-legend';
    [['var(--series-temp)', 'Measured here'], ['var(--series-precip)', `NOAA, ${state.lead} h ahead`]].forEach(([color, label]) => {
      const item = document.createElement('span');
      item.className = 'acc-legend-item';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = color;
      item.append(key, label);
      wrap.appendChild(item);
    });
    return wrap;
  }

  function headline(row) {
    const bias = deltaDisplay(row.bias_c);
    const mae = deltaText(row.mae_c);
    if (bias == null) return null;
    const mag = Math.abs(bias);
    let verdict;
    if (mag < 0.3) verdict = `NOAA's ${row.lead_hours}-hour forecast is unbiased at your station.`;
    else verdict = `NOAA's ${row.lead_hours}-hour forecast runs ${mag.toFixed(1)}° too ${bias > 0 ? 'warm' : 'cold'} at your station.`;
    return `${verdict} Across ${row.hours_scored} scored hours the average miss was ${mae}.`;
  }

  function table(byLead) {
    const wrap = document.createElement('div');
    wrap.className = 'acc-table';
    const t = document.createElement('table');
    t.className = 'data';
    const head = t.createTHead().insertRow();
    [['Looking ahead'], ['Average miss', 'num'], ['Bias', 'num'], ['Worst', 'num'], ['Hours', 'num']].forEach(([label, cls]) => {
      const th = document.createElement('th');
      th.textContent = label;
      if (cls) th.className = cls;
      head.appendChild(th);
    });
    const body = t.createTBody();
    byLead.forEach((r) => {
      const tr = body.insertRow();
      if (r.lead_hours === state.lead) tr.className = 'is-selected';
      const bias = deltaDisplay(r.bias_c);
      const cells = [
        [`${r.lead_hours} h`],
        [r.hours_scored ? deltaText(r.mae_c) : '–', 'num'],
        [bias == null ? '–' : `${bias > 0 ? '+' : ''}${bias.toFixed(1)}°`, 'num'],
        [r.hours_scored ? deltaText(r.worst_c) : '–', 'num'],
        [String(r.hours_scored || 0), 'num'],
      ];
      cells.forEach(([text, cls]) => {
        const td = tr.insertCell();
        td.textContent = text;
        if (cls) td.className = cls;
      });
    });
    wrap.appendChild(t);
    return wrap;
  }

  function render() {
    const card = document.getElementById('accuracy');
    const body = document.getElementById('accuracy-body');
    if (!card || !body) return;

    const d = state.data;
    const station = window.WX.station;
    if (!station || !station.state.online || !d || !d.enabled) {
      card.hidden = true;
      return;
    }

    const scored = d.by_lead.filter((r) => r.hours_scored > 0);
    card.hidden = false;
    body.replaceChildren();

    if (!scored.length) {
      const p = document.createElement('p');
      p.className = 'station-empty';
      p.textContent = d.forecasts_archived
        ? `${d.forecasts_archived.toLocaleString()} forecast hours archived so far. Scoring starts once your station has measured hours that were forecast earlier — give it a day.`
        : 'Waiting for the first NOAA forecast to be archived. Scores appear after a day or two of measurements.';
      body.appendChild(p);
      return;
    }

    const selected = d.by_lead.find((r) => r.lead_hours === state.lead && r.hours_scored > 0) || scored[scored.length - 1];
    state.lead = selected.lead_hours;
    document.querySelectorAll('#lead-toggle [data-lead]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.lead) === state.lead));
    });

    const h = document.createElement('p');
    h.className = 'acc-headline';
    h.textContent = headline(selected);
    body.appendChild(h);

    body.appendChild(legend());

    const chart = document.createElement('div');
    chart.className = 'acc-chart';
    body.appendChild(chart);
    const tz = (window.WX.app && window.WX.app.timeZone()) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (d.series && d.series.points.length >= 3) {
      renderChart(chart, d.series.points, tz);
    } else {
      const p = document.createElement('p');
      p.className = 'station-empty';
      p.textContent = `Not enough paired hours yet to chart the ${state.lead}-hour forecast.`;
      chart.appendChild(p);
    }

    body.appendChild(table(d.by_lead));

    const foot = document.createElement('p');
    foot.className = 'acc-foot';
    foot.textContent = `Temperature only — a BME280 can't verify rain or wind. Based on ${d.forecasts_archived.toLocaleString()} archived forecast hours over the last ${d.days} days.`;
    body.appendChild(foot);
  }

  function setLead(lead) {
    state.lead = lead;
    const station = window.WX.station;
    if (station && station.state.online) load(station.state.base);
  }

  function start(base) { load(base); }

  // The card can be rendered while the dashboard is still hidden, where every
  // element measures 0 wide and the chart would be drawn at its fallback size.
  // Redraw whenever the card's own width actually changes.
  let lastWidth = 0;
  const card = document.getElementById('accuracy');
  if (card && 'ResizeObserver' in window) {
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w && w !== lastWidth) {
        lastWidth = w;
        if (state.data) requestAnimationFrame(render);
      }
    }).observe(card);
  }

  document.querySelectorAll('#lead-toggle [data-lead]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lead = Number(btn.dataset.lead);
      document.querySelectorAll('#lead-toggle [data-lead]').forEach((b) => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.lead) === lead));
      });
      setLead(lead);
    });
  });

  window.WX = window.WX || {};
  window.WX.accuracy = { start, render, setLead, state };
})();
