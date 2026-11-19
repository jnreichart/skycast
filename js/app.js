/* Skycast — UI wiring. Depends on WX.fmt, WX.icons, WX.noaa, WX.charts. */
(function () {
  'use strict';
  const { fmt: f, icons, noaa, charts } = window.WX;
  const $ = (id) => document.getElementById(id);

  const QUICK_PICKS = [
    { name: 'New York', sub: 'New York', lat: 40.7128, lon: -74.006 },
    { name: 'Chicago', sub: 'Illinois', lat: 41.8781, lon: -87.6298 },
    { name: 'Denver', sub: 'Colorado', lat: 39.7392, lon: -104.9903 },
    { name: 'Miami', sub: 'Florida', lat: 25.7617, lon: -80.1918 },
    { name: 'Seattle', sub: 'Washington', lat: 47.6062, lon: -122.3321 },
    { name: 'Anchorage', sub: 'Alaska', lat: 61.2181, lon: -149.9003 },
  ];
  const REFRESH_MS = 15 * 60 * 1000;

  const state = {
    place: null,       // { lat, lon, name, sub }
    data: null,        // result of noaa.loadAll
    range: 48,
    view: 'chart',
    controller: null,
    chartCleanup: null,
    discussionFor: null,
    lastLoad: 0,
  };

  /* ---------- storage (best-effort; app works without it) ---------- */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`skycast:${key}`); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`skycast:${key}`, JSON.stringify(value)); } catch (_) { /* ignore */ }
    },
  };

  /* ---------- view switching ---------- */
  function show(view) {
    ['welcome', 'loading', 'error', 'dashboard'].forEach((id) => { $(id).hidden = id !== view; });
  }
  function showError(err) {
    $('error-title').textContent = err.title || 'Couldn’t load the forecast';
    $('error-text').textContent = err.message || String(err);
    show('error');
  }

  /* ---------- loading ---------- */
  async function loadPlace(place, { quiet = false } = {}) {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.place = place;

    const hasDashboard = !$('dashboard').hidden && state.data;
    if (hasDashboard && quiet) {
      $('dashboard').classList.add('is-refreshing');
    } else if (hasDashboard) {
      $('dashboard').classList.add('is-refreshing');
      $('place-name').textContent = place.name || 'Loading…';
    } else {
      $('loading-text').textContent = `Loading forecast${place.name ? ` for ${place.name}` : ''}…`;
      show('loading');
    }

    try {
      const data = await noaa.loadAll(place.lat, place.lon, { signal: controller.signal });
      if (controller.signal.aborted) return;
      state.data = data;
      state.lastLoad = Date.now();
      if (!place.name) {
        place.name = data.point.city || `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
        place.sub = data.point.state || '';
      }
      store.set('last', place);
      rememberRecent(place);
      const hash = `#${place.lat.toFixed(4)},${place.lon.toFixed(4)}`;
      if (location.hash !== hash) history.replaceState(null, '', hash);
      document.title = `${place.name} · Skycast`;
      render();
      show('dashboard');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      if (hasDashboard && quiet) return; // background refresh failure: keep showing last good data
      showError(err);
    } finally {
      if (state.controller === controller) {
        state.controller = null;
        $('dashboard').classList.remove('is-refreshing');
      }
    }
  }

  function rememberRecent(place) {
    const recents = store.get('recent', []).filter((p) => Math.abs(p.lat - place.lat) > 0.01 || Math.abs(p.lon - place.lon) > 0.01);
    recents.unshift({ name: place.name, sub: place.sub || '', lat: place.lat, lon: place.lon });
    store.set('recent', recents.slice(0, 6));
  }

  /* ---------- rendering ---------- */
  function render() {
    const d = state.data;
    if (!d) return;
    renderHeader(d);
    renderAlerts(d);
    renderCurrent(d);
    renderInsights(d);
    renderHourly();
    renderDaily(d);
    resetDiscussion(d);
    if (window.WX.station) window.WX.station.render();
  }

  function renderHeader(d) {
    const p = state.place;
    $('place-name').textContent = p.sub ? `${p.name}, ${p.sub}` : p.name;
    const tz = d.point.timeZone;
    const updated = d.forecast ? d.forecast.updated : d.hourly && d.hourly.updated;
    const parts = [`NWS ${d.point.office}`, `Grid ${d.point.gridX},${d.point.gridY}`];
    if (updated && !isNaN(updated)) parts.push(`Forecast issued ${f.weekday(updated, tz)} ${f.timeLabel(updated, tz)}`);
    $('place-meta').textContent = parts.join(' · ');
  }

  const SEV = { Extreme: 'critical', Severe: 'critical', Moderate: 'serious', Minor: 'warning' };

  function renderAlerts(d) {
    const wrap = $('alerts');
    wrap.replaceChildren();
    const tz = d.point.timeZone;
    d.alerts.forEach((a, i) => {
      const det = document.createElement('details');
      det.className = 'alert';
      det.dataset.sev = SEV[a.severity] || 'neutral';
      if (i === 0 && (a.severity === 'Extreme' || a.severity === 'Severe')) det.open = true;

      const sum = document.createElement('summary');
      const ic = document.createElement('span'); ic.className = 'alert-icon'; ic.innerHTML = icons.UI.alert;
      const title = document.createElement('span'); title.className = 'alert-title'; title.textContent = a.event;
      const sev = document.createElement('span'); sev.className = 'alert-sev'; sev.textContent = a.severity;
      const sub = document.createElement('span'); sub.className = 'alert-sub';
      const until = a.ends ? `Until ${f.weekday(a.ends, tz)} ${f.timeLabel(a.ends, tz)}` : '';
      sub.textContent = [until, a.sender].filter(Boolean).join(' · ');
      sum.append(ic, title, sev, sub);

      const body = document.createElement('div');
      body.className = 'alert-body';
      const add = (h, text) => {
        if (!text) return;
        const hh = document.createElement('h4'); hh.textContent = h;
        const pp = document.createElement('p'); pp.textContent = text.replace(/\n(?!\n)/g, ' ').replace(/ {2,}/g, ' ');
        body.append(hh, pp);
      };
      add('Details', a.description);
      add('What to do', a.instruction);
      det.append(sum, body);
      wrap.appendChild(det);
    });
  }

  function todayHiLo(d) {
    if (!d.forecast || !d.forecast.days.length) return '';
    const first = d.forecast.days[0];
    if (first.day && first.night) return `H ${f.temp(first.day.tempF)} · L ${f.temp(first.night.tempF)}`;
    if (first.night) {
      const next = d.forecast.days[1];
      return `Low tonight ${f.temp(first.night.tempF)}${next && next.day ? ` · High tomorrow ${f.temp(next.day.tempF)}` : ''}`;
    }
    return `High ${f.temp(first.day.tempF)}`;
  }

  function stat(label, value) {
    const s = document.createElement('div');
    s.className = 'stat';
    const l = document.createElement('div'); l.className = 'stat-label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'stat-value'; v.textContent = value;
    s.append(l, v);
    return s;
  }

  function renderCurrent(d) {
    const hero = $('current');
    const body = $('current-body');
    body.replaceChildren();
    const tz = d.point.timeZone;
    const o = d.obs;
    const h0 = d.hourly && d.hourly.hours[0];
    const isDay = h0 ? h0.isDaytime : true;
    const condText = (o && o.text) || (h0 && h0.short) || '';
    const kind = icons.kindFor(condText, isDay);
    hero.dataset.sky = kind;

    if (!o && !h0) {
      body.innerHTML = '<p class="hero-empty">Current conditions are unavailable for this location.</p>';
      return;
    }

    const tempF = o ? o.tempF : h0.tempF;
    const main = document.createElement('div');
    main.className = 'hero-main';
    const left = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'hero-temp';
    const tv = f.tempValue(tempF);
    t.textContent = Math.round(tv);
    const sup = document.createElement('sup'); sup.textContent = `°${f.state.units === 'metric' ? 'C' : 'F'}`;
    t.appendChild(sup);
    const c = document.createElement('div'); c.className = 'hero-cond'; c.textContent = condText || '—';
    const s = document.createElement('div'); s.className = 'hero-sub'; s.textContent = todayHiLo(d);
    left.append(t, c, s);
    const ic = document.createElement('div');
    ic.className = 'hero-icon';
    ic.innerHTML = icons.svg(kind, condText);
    main.append(left, ic);

    const stats = document.createElement('div');
    stats.className = 'hero-stats';
    if (o) {
      const wind = o.windMph == null ? '–' : (o.windMph < 1 ? 'Calm' : `${f.compass(o.windDeg)} ${f.speed(o.windMph)}`);
      stats.append(
        stat('Feels like', f.temp(o.feelsF)),
        stat(o.gustMph ? `Wind · gusts ${f.speed(o.gustMph)}` : 'Wind', wind),
        stat('Humidity', f.percent(o.rh)),
        stat('Dew point', f.temp(o.dewF)),
        stat('Pressure', f.pressure(o.pressurePa)),
        stat('Visibility', f.distance(o.visibilityM)),
      );
    } else {
      stats.append(
        stat('Wind', f.windText(h0.wind, h0.windDir)),
        stat('Humidity', f.percent(h0.rh)),
        stat('Dew point', f.temp(h0.dewF)),
        stat('Precip chance', f.percent(h0.pop)),
      );
    }

    const foot = document.createElement('div');
    foot.className = 'hero-foot';
    if (o) {
      const dist = f.state.units === 'metric' ? `${Math.round(o.distanceKm)} km` : `${Math.round(o.distanceKm / 1.609344)} mi`;
      foot.textContent = `Observed at ${o.stationName} (${o.stationId}), ${dist} away · ${f.ago(o.time)} (${f.timeLabel(o.time, tz)})`;
    } else {
      foot.textContent = 'No recent station observation nearby — showing NOAA’s forecast for this hour.';
    }
    body.append(main, stats, foot);
  }

  /* ---------- "prediction at a glance" insights derived from the forecast ---------- */
  function dayWord(date, tz) {
    const now = new Date();
    const k = f.dayKey(date, tz);
    if (k === f.dayKey(now, tz)) return '';
    if (k === f.dayKey(new Date(now.getTime() + 864e5), tz)) return 'tomorrow';
    return f.weekdayLong(date, tz);
  }
  function when(date, tz, prefix = 'around') {
    const dw = dayWord(date, tz);
    const t = f.hourLabel(date, tz);
    if (!dw) return `${prefix} ${t}`;
    return dw === 'tomorrow' ? `${prefix} ${t} tomorrow` : `${dw} ${prefix} ${t}`;
  }
  function precipWord(text) {
    const s = String(text || '').toLowerCase();
    if (/thunder|t-storm/.test(s)) return 'Storms';
    if (/sleet|freezing|wintry/.test(s)) return 'Wintry mix';
    if (/snow|flurr/.test(s)) return 'Snow';
    if (/drizzle/.test(s)) return 'Drizzle';
    if (/shower/.test(s)) return 'Showers';
    if (/rain/.test(s)) return 'Rain';
    return 'Precipitation';
  }

  function buildInsights(d) {
    const out = [];
    const tz = d.point.timeZone;
    const hours = d.hourly ? d.hourly.hours : [];
    const next24 = hours.slice(0, 24);
    const days = d.forecast ? d.forecast.days : [];

    // 1) precipitation timing
    if (next24.length) {
      const iLikely = next24.findIndex((h) => h.pop >= 50);
      const peak = next24.reduce((a, b) => (b.pop > a.pop ? b : a), next24[0]);
      if (iLikely >= 0) {
        let j = iLikely;
        while (j + 1 < hours.length && hours[j + 1].pop >= 50) j++;
        const kind = precipWord(next24[iLikely].short);
        const title = iLikely === 0 ? `${kind} likely now` : `${kind} likely ${when(next24[iLikely].start, tz, 'from')}`;
        const endTxt = j === iLikely ? '' : ` Tapering off ${when(hours[j].end, tz)}.`;
        out.push({ icon: icons.UI.drop, title, text: `Chances peak at ${peak.pop}% ${when(peak.start, tz)}.${endTxt}` });
      } else if (peak.pop >= 20) {
        out.push({ icon: icons.UI.drop, title: `Slight chance of ${precipWord(peak.short).toLowerCase()}`, text: `Up to ${peak.pop}% ${when(peak.start, tz)}; otherwise mostly dry.` });
      } else {
        const nextWet = days.slice(1).find((x) => Math.max(x.day ? x.day.pop : 0, x.night ? x.night.pop : 0) >= 40);
        const p = nextWet && (nextWet.day || nextWet.night);
        out.push({
          icon: icons.UI.drop,
          title: 'Dry for the next 24 hours',
          text: p ? `Next good chance: ${p.name} (${Math.max(nextWet.day ? nextWet.day.pop : 0, nextWet.night ? nextWet.night.pop : 0)}%).` : 'No meaningful precipitation in the 7-day forecast.',
        });
      }
    }

    // 2) temperature trend between the next two daytime highs
    const daytime = days.filter((x) => x.day);
    if (daytime.length >= 2) {
      const [a, b] = daytime;
      const diff = b.day.tempF - a.day.tempF;
      const dd = Math.round(Math.abs(f.tempDelta(diff)));
      const nameA = /today|this afternoon/i.test(a.day.name) ? 'today' : a.day.name;
      const title = Math.abs(diff) < 3 ? `Steady temperatures` : diff > 0 ? `Warming ${dd}° by ${b.day.name}` : `Cooling ${dd}° by ${b.day.name}`;
      const warmest = daytime.reduce((m, x) => (x.day.tempF > m.day.tempF ? x : m), daytime[0]);
      const coldest = days.filter((x) => x.night).reduce((m, x) => (!m || x.night.tempF < m.night.tempF ? x : m), null);
      let text = `High ${f.temp(a.day.tempF)} ${nameA}, ${f.temp(b.day.tempF)} ${b.day.name}.`;
      text += ` Warmest this week: ${warmest.day.name} (${f.temp(warmest.day.tempF)})`;
      text += coldest ? `; coldest night: ${coldest.night.name.replace(/ Night$/, ' night')} (${f.temp(coldest.night.tempF)}).` : '.';
      out.push({ icon: icons.UI.thermo, title, text });
    }

    // 3) wind
    if (next24.length) {
      const windy = next24.map((h) => ({ h, mph: f.parseWind(h.wind).max || 0 }));
      const top = windy.reduce((a, b) => (b.mph > a.mph ? b : a), windy[0]);
      if (top.mph >= 20) {
        out.push({ icon: icons.UI.wind, title: top.mph >= 30 ? 'Strong winds ahead' : 'Breezy at times', text: `Winds up to ${f.speed(top.mph)} ${when(top.h.start, tz)} from the ${top.h.windDir || 'variable directions'}.` });
      } else {
        out.push({ icon: icons.UI.wind, title: 'Light winds', text: `Staying at or below ${f.speed(top.mph)} over the next 24 hours.` });
      }
    }

    // 4) best time to be outside: the most comfortable 3-hour daytime window in the next ~48h
    const pool = hours.slice(0, 48);
    const score = (h) => {
      const t = h.tempF;
      const wind = f.parseWind(h.wind).max || 0;
      return -Math.abs(t - 70) - h.pop * 0.5 - Math.max(0, wind - 10) * 1.2 - (/thunder|snow|rain|shower/i.test(h.short) ? 15 : 0);
    };
    let best = null;
    for (let i = 0; i + 2 < pool.length; i++) {
      const win = pool.slice(i, i + 3);
      if (!win.every((h) => h.isDaytime)) continue;
      const s = win.reduce((acc, h) => acc + score(h), 0) / 3;
      if (!best || s > best.s) best = { s, i, win };
    }
    if (best) {
      const w = best.win;
      const dw = dayWord(w[0].start, tz);
      const label = dw ? (dw === 'tomorrow' ? 'Tomorrow' : dw) : 'Today';
      const temps = w.map((h) => h.tempF);
      out.push({
        icon: icons.UI.clock,
        title: `Best time outside: ${label} ${f.hourRange(w[0].start, w[2].end, tz)}`,
        text: `${w[1].short}, ${f.temp(Math.min(...temps))}–${f.temp(Math.max(...temps))}, ${Math.max(...w.map((h) => h.pop))}% chance of precipitation.`,
      });
    }
    return out;
  }

  function renderInsights(d) {
    const list = $('insights');
    list.replaceChildren();
    const items = buildInsights(d);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'insight-text';
      li.textContent = 'Forecast details are unavailable right now.';
      list.appendChild(li);
    }
    items.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'insight';
      const ic = document.createElement('span'); ic.className = 'insight-icon'; ic.innerHTML = it.icon;
      const txt = document.createElement('div');
      const t = document.createElement('div'); t.className = 'insight-title'; t.textContent = it.title;
      const p = document.createElement('div'); p.className = 'insight-text'; p.textContent = it.text;
      txt.append(t, p);
      li.append(ic, txt);
      list.appendChild(li);
    });

    const ps = $('period-summary');
    ps.replaceChildren();
    const first = d.forecast && d.forecast.periods[0];
    if (first) {
      const label = document.createElement('div'); label.className = 'ps-label'; label.textContent = `NWS forecast · ${first.name}`;
      const p = document.createElement('p'); p.textContent = first.detailed;
      ps.append(label, p);
    }
  }

  function renderHourly() {
    const d = state.data;
    if (!d) return;
    const hours = d.hourly ? d.hourly.hours.slice(0, state.range) : [];
    const tz = d.point.timeZone;
    $('hourly-title').textContent = `Next ${state.range} hours`;
    if (state.chartCleanup) { state.chartCleanup(); state.chartCleanup = null; }
    const chartEl = $('hourly-chart'), tableEl = $('hourly-table');
    chartEl.hidden = state.view !== 'chart';
    tableEl.hidden = state.view !== 'table';
    if (state.view === 'chart') state.chartCleanup = charts.renderHourly(chartEl, hours, tz);
    else charts.renderHourlyTable(tableEl, hours, tz);
  }

  function renderDaily(d) {
    const list = $('daily');
    list.replaceChildren();
    if (!d.forecast) {
      const li = document.createElement('li');
      li.textContent = '7-day forecast unavailable right now.';
      list.appendChild(li);
      return;
    }
    const tz = d.point.timeZone;
    const days = d.forecast.days.slice(0, 8);
    const allTemps = days.flatMap((x) => [x.day && x.day.tempF, x.night && x.night.tempF]).filter(f.isNum);
    const wMin = Math.min(...allTemps), wMax = Math.max(...allTemps);
    const pct = (t) => ((t - wMin) / Math.max(1, wMax - wMin)) * 100;
    const nowTemp = d.obs ? d.obs.tempF : d.hourly && d.hourly.hours[0] && d.hourly.hours[0].tempF;

    days.forEach((x, i) => {
      const main = x.day || x.night;
      const li = document.createElement('li');
      li.className = 'day';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-row';
      btn.setAttribute('aria-expanded', 'false');

      const name = document.createElement('span');
      name.className = 'day-name';
      name.textContent = i === 0 ? (x.day ? 'Today' : 'Tonight') : f.weekday(main.start, tz);
      const small = document.createElement('small'); small.textContent = f.monthDay(main.start, tz);
      name.appendChild(small);

      const ic = document.createElement('span'); ic.className = 'day-icon';
      ic.innerHTML = icons.svg(icons.kindFor(main.short, main.isDaytime), main.short);
      const cond = document.createElement('span'); cond.className = 'day-cond'; cond.textContent = main.short;

      const popV = Math.max(x.day ? x.day.pop : 0, x.night ? x.night.pop : 0);
      const pop = document.createElement('span');
      pop.className = 'day-pop' + (popV ? '' : ' is-zero');
      pop.innerHTML = icons.UI.drop;
      pop.append(`${popV}%`);
      pop.title = 'Chance of precipitation';

      const lo = document.createElement('span'); lo.className = 'day-lo';
      lo.textContent = x.night ? f.temp(x.night.tempF) : '';
      const hi = document.createElement('span'); hi.className = 'day-hi';
      hi.textContent = x.day ? f.temp(x.day.tempF) : '';

      const range = document.createElement('span');
      range.className = 'range';
      const a = x.night ? x.night.tempF : x.day.tempF;
      const b = x.day ? x.day.tempF : x.night.tempF;
      const fill = document.createElement('span');
      fill.className = 'range-fill';
      fill.style.left = `${pct(Math.min(a, b))}%`;
      fill.style.width = `${Math.max(3, pct(Math.max(a, b)) - pct(Math.min(a, b)))}%`;
      range.appendChild(fill);
      if (i === 0 && f.isNum(nowTemp)) {
        const now = document.createElement('span');
        now.className = 'range-now';
        now.style.left = `${Math.max(0, Math.min(100, pct(nowTemp)))}%`;
        now.title = `Now ${f.temp(nowTemp)}`;
        range.appendChild(now);
      }
      range.setAttribute('aria-hidden', 'true');

      btn.append(name, ic, cond, pop, lo, range, hi);
      btn.setAttribute('aria-label', `${name.firstChild.textContent}: ${main.short}. ${x.day ? `High ${f.temp(x.day.tempF)}.` : ''} ${x.night ? `Low ${f.temp(x.night.tempF)}.` : ''} ${popV}% chance of precipitation.`);

      const detail = document.createElement('div');
      detail.className = 'day-detail';
      detail.hidden = true;
      [x.day, x.night].filter(Boolean).forEach((p) => {
        const col = document.createElement('div');
        const h = document.createElement('h4'); h.textContent = p.name;
        const t = document.createElement('p'); t.textContent = p.detailed;
        const m = document.createElement('div'); m.className = 'dd-meta';
        m.textContent = `${p.isDaytime ? 'High' : 'Low'} ${f.temp(p.tempF)} · Wind ${f.windText(p.wind, p.windDir)} · Precip ${p.pop}%`;
        col.append(h, t, m);
        detail.appendChild(col);
      });
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!open));
        detail.hidden = open;
      });
      li.append(btn, detail);
      list.appendChild(li);
    });
  }

  /* ---------- forecaster's discussion (lazy) ---------- */
  function resetDiscussion(d) {
    if (state.discussionFor !== d.point.office) {
      $('discussion-body').replaceChildren();
      state.discussionFor = null;
      if ($('discussion').open) loadDiscussion();
    }
  }
  async function loadDiscussion() {
    const d = state.data;
    if (!d || state.discussionFor === d.point.office) return;
    const office = d.point.office;
    const body = $('discussion-body');
    body.textContent = 'Loading discussion…';
    try {
      const afd = await noaa.getDiscussion(office);
      if (!state.data || state.data.point.office !== office) return;
      state.discussionFor = office;
      body.replaceChildren();
      if (!afd) { body.textContent = 'No discussion available from this office.'; return; }
      const issued = document.createElement('p');
      issued.className = 'afd-issued';
      issued.textContent = `Issued by NWS ${office} · ${f.weekday(afd.issued, d.point.timeZone)} ${f.timeLabel(afd.issued, d.point.timeZone)}`;
      body.appendChild(issued);
      parseAFD(afd.text).forEach((sec) => {
        if (sec.heading) {
          const h = document.createElement('h3');
          h.textContent = prettyHeading(sec.heading, office);
          body.appendChild(h);
        }
        sec.paras.forEach((t) => {
          const p = document.createElement('p');
          p.style.whiteSpace = 'pre-line';
          if (/^Issued at /i.test(t)) p.className = 'afd-issued';
          p.textContent = t;
          body.appendChild(p);
        });
      });
    } catch (err) {
      body.textContent = `Couldn’t load the discussion: ${err.message}`;
    }
  }
  /** ".DISCUSSION /Through Thursday/" -> "Discussion — Through Thursday"; drops a leading office id. */
  function prettyHeading(raw, office) {
    const m = raw.match(/^([^/]*?)\s*(?:\/(.*)\/)?\s*$/) || [null, raw, null];
    const main = m[1].replace(new RegExp(`^${office}\\s+`, 'i'), '').trim();
    const nice = main.charAt(0).toUpperCase() + main.slice(1).toLowerCase();
    return m[2] ? `${nice} — ${m[2].charAt(0).toUpperCase()}${m[2].slice(1)}` : nice;
  }
  function parseAFD(text) {
    let lines = text.replace(/\r/g, '').split('\n');
    const i = lines.findIndex((l) => /Area Forecast Discussion/i.test(l));
    if (i >= 0) lines = lines.slice(i + 3);
    let body = lines.join('\n');
    body = body.split(/\n\$\$/)[0];
    return body.split(/\n\s*&&\s*\n/).map((chunk) => {
      chunk = chunk.trim();
      let heading = null;
      const m = chunk.match(/^\.([^\n]+?)\.\.\.\s*/);
      if (m) { heading = m[1].trim(); chunk = chunk.slice(m[0].length); }
      const paras = chunk.split(/\n\s*\n/)
        .map((p) => p.replace(/\n(?!\s*[-*•]\s)/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean);
      return { heading, paras };
    }).filter((s) => s.heading || s.paras.length);
  }

  /* ---------- search combobox ---------- */
  const input = $('search-input');
  const results = $('search-results');
  let searchTimer = null, searchCtl = null, options = [], activeIdx = -1;

  function parseCoords(q) {
    const m = q.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function openResults(items, { label, empty } = {}) {
    options = items;
    activeIdx = -1;
    results.replaceChildren();
    if (label && items.length) {
      const li = document.createElement('li'); li.className = 'r-label'; li.textContent = label; li.setAttribute('role', 'presentation');
      results.appendChild(li);
    }
    if (!items.length && empty) {
      const li = document.createElement('li'); li.className = 'r-empty'; li.textContent = empty; li.setAttribute('role', 'presentation');
      results.appendChild(li);
    }
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = `opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const n = document.createElement('span'); n.className = 'r-name'; n.textContent = it.name;
      const s = document.createElement('span'); s.className = 'r-sub'; s.textContent = it.sub || '';
      li.append(n, s);
      li.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(i); });
      results.appendChild(li);
    });
    const visible = items.length || empty;
    results.hidden = !visible;
    input.setAttribute('aria-expanded', String(!!visible));
  }
  function closeResults() {
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIdx = -1;
  }
  function highlight(i) {
    activeIdx = i;
    results.querySelectorAll('[role="option"]').forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', `opt-${i}`);
      const li = $(`opt-${i}`);
      if (li) li.scrollIntoView({ block: 'nearest' });
    }
  }
  function choose(i) {
    const it = options[i];
    if (!it) return;
    closeResults();
    input.value = '';
    input.blur();
    loadPlace({ lat: it.lat, lon: it.lon, name: it.name, sub: it.state || it.sub || '' });
  }
  function showRecents() {
    const rec = store.get('recent', []).map((r) => ({ ...r, state: r.sub }));
    if (rec.length) openResults(rec, { label: 'Recent' });
    else closeResults();
  }

  input.addEventListener('focus', () => { if (!input.value.trim()) showRecents(); });
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (searchCtl) searchCtl.abort();
    if (!q) { showRecents(); return; }
    const coords = parseCoords(q);
    if (coords) {
      openResults([{ ...coords, name: `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`, sub: 'Coordinates', state: '' }]);
      return;
    }
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      searchCtl = new AbortController();
      try {
        const found = await noaa.searchPlaces(q, searchCtl.signal);
        if (input.value.trim() !== q) return;
        openResults(found.map((r) => ({ ...r, sub: r.region, state: r.admin1 || '' })), { empty: `No U.S. places match “${q}”.` });
      } catch (err) {
        if (err.name !== 'AbortError') openResults([], { empty: err.message });
      }
    }, 220);
  });
  input.addEventListener('keydown', (ev) => {
    if (results.hidden && (ev.key === 'ArrowDown')) { if (!input.value.trim()) showRecents(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(Math.min(options.length - 1, activeIdx + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(Math.max(0, activeIdx - 1)); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (activeIdx >= 0) choose(activeIdx);
      else if (options.length) choose(0);
    } else if (ev.key === 'Escape') { closeResults(); }
  });
  input.addEventListener('blur', () => setTimeout(closeResults, 120));

  /* ---------- geolocation ---------- */
  function locate() {
    if (!('geolocation' in navigator)) {
      showError({ title: 'Location unavailable', message: 'This browser can’t share your location. Search for a city or ZIP code instead.' });
      return;
    }
    const btns = [$('locate-btn'), $('welcome-locate')];
    btns.forEach((b) => { b.disabled = true; });
    if ($('dashboard').hidden) { $('loading-text').textContent = 'Finding your location…'; show('loading'); }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btns.forEach((b) => { b.disabled = false; });
        loadPlace({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: null, sub: null });
      },
      (err) => {
        btns.forEach((b) => { b.disabled = false; });
        const msg = err.code === 1
          ? 'Location access was blocked. Allow it in your browser’s site settings, or search for a city or ZIP code.'
          : err.code === 3 ? 'Finding your location took too long. Try again or search instead.'
          : 'Your location couldn’t be determined. Search for a city or ZIP code instead.';
        if (state.data) { alert(msg); show('dashboard'); }
        else showError({ title: 'Couldn’t get your location', message: msg });
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 }
    );
  }

  /* ---------- controls ---------- */
  function setPressed(groupSel, attr, value) {
    document.querySelectorAll(`${groupSel} [data-${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));
  }
  function setUnits(u) {
    f.state.units = u;
    store.set('units', u);
    setPressed('.topbar', 'units', u);
    if (state.data) render();
  }
  document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => setUnits(b.dataset.units)));
  document.querySelectorAll('#range-toggle [data-range]').forEach((b) => b.addEventListener('click', () => {
    state.range = Number(b.dataset.range);
    store.set('range', state.range);
    setPressed('#range-toggle', 'range', state.range);
    renderHourly();
  }));
  document.querySelectorAll('#view-toggle [data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    setPressed('#view-toggle', 'view', state.view);
    renderHourly();
  }));

  $('locate-btn').addEventListener('click', locate);
  $('welcome-locate').addEventListener('click', locate);
  $('refresh-btn').addEventListener('click', () => state.place && loadPlace(state.place, { quiet: true }));
  $('error-retry').addEventListener('click', () => (state.place ? loadPlace(state.place) : show('welcome')));
  $('discussion').addEventListener('toggle', () => { if ($('discussion').open) loadDiscussion(); });
  $('brand').addEventListener('click', (ev) => { ev.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  const picks = $('quick-picks');
  QUICK_PICKS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = p.name;
    b.addEventListener('click', () => loadPlace({ ...p }));
    picks.appendChild(b);
  });

  // redraw the chart on resize (it's drawn at the container's pixel width)
  let lastW = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w && w !== lastW && state.view === 'chart' && state.data) {
      lastW = w;
      requestAnimationFrame(renderHourly);
    }
  }).observe($('hourly-chart').parentElement);

  // keep data fresh
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.place && Date.now() - state.lastLoad > REFRESH_MS) loadPlace(state.place, { quiet: true });
  }, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.place && state.data && Date.now() - state.lastLoad > REFRESH_MS) loadPlace(state.place, { quiet: true });
  });

  function placeFromHash() {
    const c = parseCoords(decodeURIComponent(location.hash.slice(1)));
    if (!c) return null;
    const last = store.get('last', null);
    if (last && Math.abs(last.lat - c.lat) < 1e-3 && Math.abs(last.lon - c.lon) < 1e-3) return last;
    return { ...c, name: null, sub: null };
  }
  window.addEventListener('hashchange', () => {
    const p = placeFromHash();
    if (p && (!state.place || Math.abs(p.lat - state.place.lat) > 1e-4 || Math.abs(p.lon - state.place.lon) > 1e-4)) loadPlace(p);
  });

  /* ---------- boot ---------- */
  f.state.units = store.get('units', 'us') === 'metric' ? 'metric' : 'us';
  setPressed('.topbar', 'units', f.state.units);
  state.range = [24, 48, 72].includes(store.get('range', 48)) ? store.get('range', 48) : 48;
  if (window.innerWidth < 560 && !store.get('range', null)) state.range = 24;
  setPressed('#range-toggle', 'range', state.range);

  // Exposed for the station module: it reads the NWS observation to compare against,
  // and the forecast time zone so its chart labels match the rest of the page.
  window.WX.app = {
    data: () => state.data,
    hasPlace: () => !!state.place,
    loadPlace: (p) => loadPlace(p),
    timeZone: () => (state.data && state.data.point.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  const initial = placeFromHash() || store.get('last', null);
  if (initial) loadPlace(initial);
  else show('welcome');

  if (window.WX.station) window.WX.station.start();
})();
