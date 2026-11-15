/* Hourly charts: temperature (line) and precipitation chance (columns) as two
   single-axis charts sharing one x-scale and one crosshair/tooltip. */
(function () {
  'use strict';
  const F = () => window.WX.fmt;
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function niceStep(span, target = 4) {
    const raw = span / target;
    const steps = [1, 2, 5, 10, 20, 25, 50];
    return steps.find((s) => s >= raw) || 50;
  }
  /** column with 4px rounded data-end, square at the baseline */
  function barPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  const tooltip = () => document.getElementById('tooltip');

  function ttRow(color, value, name, bar) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    key.style.background = color;
    if (bar) { key.style.height = '8px'; key.style.width = '6px'; key.style.borderRadius = '2px 2px 0 0'; }
    const v = document.createElement('span'); v.className = 'tt-val'; v.textContent = value;
    const n = document.createElement('span'); n.className = 'tt-name'; n.textContent = name;
    row.append(key, v, n);
    return row;
  }

  function showTooltip(h, tz, anchor) {
    const f = F();
    const tt = tooltip();
    tt.replaceChildren();
    const time = document.createElement('div');
    time.className = 'tt-time';
    time.textContent = `${f.weekday(h.start, tz)} ${f.hourLabel(h.start, tz)}`;
    tt.append(
      time,
      ttRow('var(--series-temp)', f.temp(h.tempF), 'Temperature'),
      ttRow('var(--series-precip)', f.percent(h.pop), 'Chance of precip', true),
    );
    const extra = document.createElement('div');
    extra.className = 'tt-cond';
    extra.textContent = `${h.short} · Wind ${f.windText(h.wind, h.windDir)}${h.rh != null ? ` · ${Math.round(h.rh)}% RH` : ''}`;
    tt.append(extra);
    tt.hidden = false;

    const { width: tw, height: th } = tt.getBoundingClientRect();
    let left = anchor.x + 16;
    if (left + tw > window.innerWidth - 8) left = anchor.x - tw - 16;
    left = Math.max(8, left);
    let top = anchor.y - th / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
  }
  function hideTooltip() { tooltip().hidden = true; }

  /**
   * Render into `container`. Returns a cleanup function.
   * hours: normalized hourly periods; tz: IANA zone of the forecast point.
   */
  function renderHourly(container, hours, tz) {
    const f = F();
    container.replaceChildren();
    if (!hours || !hours.length) {
      container.textContent = 'Hourly forecast unavailable.';
      return () => {};
    }

    const W = Math.max(280, container.clientWidth);
    const narrow = W < 560;
    const M = { left: 36, right: 8 };
    const plotW = W - M.left - M.right;
    const n = hours.length;
    const step = plotW / n;
    const cx = (i) => M.left + step * (i + 0.5);
    const hoursLocal = hours.map((h) => f.localHour(h.start, tz));

    // ---------- temperature chart ----------
    const H1 = narrow ? 150 : 176;
    const T = { top: 22, bottom: 20 };
    const temps = hours.map((h) => f.tempValue(h.tempF));
    let tMin = Math.min(...temps), tMax = Math.max(...temps);
    const tStep = niceStep(Math.max(4, tMax - tMin), narrow ? 3 : 4);
    let lo = Math.floor(tMin / tStep) * tStep, hi = Math.ceil(tMax / tStep) * tStep;
    if (hi === lo) hi = lo + tStep;
    const y1 = (v) => T.top + (1 - (v - lo) / (hi - lo)) * (H1 - T.top - T.bottom);

    const tLabel = document.createElement('div');
    tLabel.className = 'chart-label';
    tLabel.innerHTML = `<span class="key" style="background:var(--series-temp)"></span>`;
    tLabel.append(`Temperature (°${f.state.units === 'metric' ? 'C' : 'F'})`);
    container.appendChild(tLabel);

    const s1 = el('svg', { width: W, height: H1, viewBox: `0 0 ${W} ${H1}`, role: 'img',
      'aria-label': `Hourly temperature for the next ${n} hours, from ${f.temp(Math.min(...hours.map((h) => h.tempF)))} to ${f.temp(Math.max(...hours.map((h) => h.tempF)))}` });
    container.appendChild(s1);

    // night bands
    const nightBands = (svg, top, bottom) => {
      let i = 0;
      while (i < n) {
        if (!hours[i].isDaytime) {
          let j = i;
          while (j + 1 < n && !hours[j + 1].isDaytime) j++;
          el('rect', { class: 'night-band', x: M.left + step * i, y: top, width: step * (j - i + 1), height: bottom - top }, svg);
          i = j + 1;
        } else i++;
      }
    };
    nightBands(s1, T.top - 6, H1 - T.bottom);

    for (let v = lo; v <= hi + 1e-9; v += tStep) {
      const y = Math.round(y1(v)) + 0.5;
      el('line', { class: 'grid-line', x1: M.left, x2: W - M.right, y1: y, y2: y }, s1);
      const t = el('text', { class: 'ax-text', x: M.left - 6, y: y + 4, 'text-anchor': 'end' }, s1);
      t.textContent = `${Math.round(v)}°`;
    }
    // day dividers
    const dayLines = (svg, top, bottom) => {
      hoursLocal.forEach((hr, i) => {
        if (hr === 0 && i > 0) {
          const x = Math.round(M.left + step * i) + 0.5;
          el('line', { class: 'day-line', x1: x, x2: x, y1: top, y2: bottom }, svg);
        }
      });
    };
    dayLines(s1, T.top - 6, H1 - T.bottom);

    const pts = temps.map((v, i) => [cx(i), y1(v)]);
    const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    el('path', { class: 'temp-area', d: `${linePath}L${pts[n - 1][0].toFixed(1)},${H1 - T.bottom}L${pts[0][0].toFixed(1)},${H1 - T.bottom}Z` }, s1);
    el('path', { class: 'temp-line', d: linePath }, s1);

    // selective direct labels: the high and the low
    const iMax = temps.indexOf(tMax), iMin = temps.indexOf(tMin);
    const clampX = (x) => Math.max(M.left + 12, Math.min(W - M.right - 12, x));
    const labelAt = (i, dy) => {
      el('circle', { cx: pts[i][0], cy: pts[i][1], r: 4, fill: 'var(--series-temp)', stroke: 'var(--surface)', 'stroke-width': 2 }, s1);
      const t = el('text', { class: 'val-label', x: clampX(pts[i][0]), y: pts[i][1] + dy, 'text-anchor': 'middle' }, s1);
      t.textContent = f.temp(hours[i].tempF);
    };
    labelAt(iMax, -9);
    if (iMin !== iMax) labelAt(iMin, 17);

    const cross1 = el('line', { class: 'crosshair', y1: T.top - 6, y2: H1 - T.bottom, visibility: 'hidden' }, s1);
    const dot = el('circle', { class: 'cross-dot', r: 5, visibility: 'hidden' }, s1);

    // ---------- precipitation chart ----------
    const H2 = narrow ? 104 : 116;
    const P = { top: 8, bottom: 24 };
    const y2 = (v) => P.top + (1 - v / 100) * (H2 - P.top - P.bottom);

    const pLabel = document.createElement('div');
    pLabel.className = 'chart-label';
    pLabel.style.marginTop = '10px';
    pLabel.innerHTML = `<span class="key key-bar" style="background:var(--series-precip)"></span>`;
    pLabel.append('Chance of precipitation');
    container.appendChild(pLabel);

    const maxPop = Math.max(...hours.map((h) => h.pop || 0));
    const s2 = el('svg', { width: W, height: H2, viewBox: `0 0 ${W} ${H2}`, role: 'img',
      'aria-label': `Hourly chance of precipitation, peaking at ${maxPop}%` });
    container.appendChild(s2);
    nightBands(s2, P.top, H2 - P.bottom);

    [0, 50, 100].forEach((v) => {
      const y = Math.round(y2(v)) + 0.5;
      el('line', { class: v === 0 ? 'base-line' : 'grid-line', x1: M.left, x2: W - M.right, y1: y, y2: y }, s2);
      const t = el('text', { class: 'ax-text', x: M.left - 6, y: y + 4, 'text-anchor': 'end' }, s2);
      t.textContent = `${v}%`;
    });
    dayLines(s2, P.top, H2 - P.bottom);

    const bw = Math.max(1, Math.min(24, step - 2)); // 2px surface gap between neighbors
    const bars = hours.map((h, i) => {
      if (!h.pop) return null;
      const top = y2(h.pop), bottom = y2(0);
      return el('path', { class: 'precip-bar', d: barPath(cx(i) - bw / 2, top, bw, bottom - top) }, s2);
    });

    // x-axis labels — weekday at midnight, hours elsewhere
    const every = [1, 2, 3, 6, 12].find((k) => step * k >= (narrow ? 40 : 46)) || 12;
    hoursLocal.forEach((hr, i) => {
      if (hr % every !== 0) return;
      const isMidnight = hr === 0;
      const t = el('text', { class: isMidnight ? 'ax-day' : 'ax-text', x: cx(i), y: H2 - 7, 'text-anchor': 'middle' }, s2);
      t.textContent = isMidnight ? f.weekday(hours[i].start, tz) : f.hourLabel(hours[i].start, tz).replace(' ', ' ');
    });

    const cross2 = el('line', { class: 'crosshair', y1: P.top, y2: H2 - P.bottom, visibility: 'hidden' }, s2);

    // ---------- interaction: crosshair snaps to the nearest hour ----------
    let active = -1;
    function setActive(i, anchor) {
      if (i === active && !anchor) return;
      if (active >= 0 && bars[active]) bars[active].classList.remove('is-active');
      active = i;
      if (i < 0) {
        [cross1, cross2, dot].forEach((n) => n.setAttribute('visibility', 'hidden'));
        hideTooltip();
        return;
      }
      const x = Math.round(cx(i)) + 0.5;
      [cross1, cross2].forEach((ln) => { ln.setAttribute('x1', x); ln.setAttribute('x2', x); ln.setAttribute('visibility', 'visible'); });
      dot.setAttribute('cx', pts[i][0]); dot.setAttribute('cy', pts[i][1]); dot.setAttribute('visibility', 'visible');
      if (bars[i]) bars[i].classList.add('is-active');
      const rect = s1.getBoundingClientRect();
      showTooltip(hours[i], tz, anchor || { x: rect.left + cx(i), y: rect.top + pts[i][1] });
    }
    const indexFromEvent = (ev, svg) => {
      const rect = svg.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      return Math.max(0, Math.min(n - 1, Math.floor((x - M.left) / step)));
    };
    [s1, s2].forEach((svg) => {
      svg.addEventListener('pointermove', (ev) => setActive(indexFromEvent(ev, svg), { x: ev.clientX, y: ev.clientY }));
      svg.addEventListener('pointerdown', (ev) => setActive(indexFromEvent(ev, svg), { x: ev.clientX, y: ev.clientY }));
      svg.addEventListener('pointerleave', () => setActive(-1));
    });

    container.tabIndex = 0;
    container.setAttribute('aria-label', 'Hourly forecast chart. Use left and right arrow keys to read each hour.');
    const onKey = (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        const next = active < 0 ? 0 : Math.max(0, Math.min(n - 1, active + (ev.key === 'ArrowRight' ? 1 : -1)));
        setActive(next);
      } else if (ev.key === 'Escape') setActive(-1);
    };
    const onBlur = () => setActive(-1);
    container.addEventListener('keydown', onKey);
    container.addEventListener('blur', onBlur);
    const onScroll = () => setActive(-1);
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('blur', onBlur);
      window.removeEventListener('scroll', onScroll);
      hideTooltip();
    };
  }

  function renderHourlyTable(container, hours, tz) {
    const f = F();
    const table = document.createElement('table');
    table.className = 'data';
    const thead = table.createTHead().insertRow();
    [['Time'], ['Conditions'], ['Temp', 'num'], ['Precip', 'num'], ['Wind'], ['Humidity', 'num'], ['Dew point', 'num']].forEach(([label, cls]) => {
      const th = document.createElement('th');
      th.textContent = label;
      if (cls) th.className = cls;
      thead.appendChild(th);
    });
    const tbody = table.createTBody();
    hours.forEach((h, i) => {
      const tr = tbody.insertRow();
      const midnight = f.localHour(h.start, tz) === 0;
      if (midnight && i > 0) tr.className = 'day-start';
      const cells = [
        [(i === 0 || midnight) ? `${f.weekday(h.start, tz)} ${f.hourLabel(h.start, tz)}` : f.hourLabel(h.start, tz)],
        [h.short],
        [f.temp(h.tempF), 'num'],
        [f.percent(h.pop), 'num'],
        [f.windText(h.wind, h.windDir)],
        [f.percent(h.rh), 'num'],
        [f.temp(h.dewF), 'num'],
      ];
      cells.forEach(([text, cls]) => {
        const td = tr.insertCell();
        td.textContent = text;
        if (cls) td.className = cls;
      });
    });
    container.replaceChildren(table);
  }

  window.WX = window.WX || {};
  window.WX.charts = { renderHourly, renderHourlyTable, hideTooltip };
})();
