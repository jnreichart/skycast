/* Unit conversion and formatting helpers. All temperatures are carried
   internally in °F (NOAA's forecast default) and converted at display time. */
(function () {
  'use strict';

  const state = { units: 'us' }; // 'us' | 'metric'

  const cToF = (c) => c * 9 / 5 + 32;
  const fToC = (f) => (f - 32) * 5 / 9;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function temp(f, { unit = false } = {}) {
    if (!isNum(f)) return '–';
    const v = state.units === 'metric' ? fToC(f) : f;
    return `${Math.round(v)}°${unit ? (state.units === 'metric' ? 'C' : 'F') : ''}`;
  }
  function tempValue(f) {
    if (!isNum(f)) return null;
    return state.units === 'metric' ? fToC(f) : f;
  }
  function tempDelta(dF) {
    return state.units === 'metric' ? dF * 5 / 9 : dF;
  }

  /** speed in mph -> display string */
  function speed(mph) {
    if (!isNum(mph)) return '–';
    return state.units === 'metric' ? `${Math.round(mph * 1.609344)} km/h` : `${Math.round(mph)} mph`;
  }
  /** NOAA wind strings: "5 mph", "10 to 15 mph" -> {min, max} in mph */
  function parseWind(str) {
    if (!str) return { min: null, max: null };
    const nums = (String(str).match(/\d+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) return { min: null, max: null };
    return { min: Math.min(...nums), max: Math.max(...nums) };
  }
  function windText(str, dir) {
    const { min, max } = parseWind(str);
    if (max === null) return str || '–';
    if (max === 0) return 'Calm';
    const conv = (v) => state.units === 'metric' ? Math.round(v * 1.609344) : Math.round(v);
    const u = state.units === 'metric' ? 'km/h' : 'mph';
    const range = min !== max ? `${conv(min)}–${conv(max)}` : `${conv(max)}`;
    return `${dir ? dir + ' ' : ''}${range} ${u}`;
  }

  function pressure(pa) {
    if (!isNum(pa)) return '–';
    return state.units === 'metric' ? `${Math.round(pa / 100)} hPa` : `${(pa / 3386.389).toFixed(2)} inHg`;
  }
  function distance(m) {
    if (!isNum(m)) return '–';
    if (state.units === 'metric') {
      const km = m / 1000;
      return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
    }
    const mi = m / 1609.344;
    return mi >= 10 ? `${Math.round(mi)} mi` : `${mi.toFixed(1)} mi`;
  }
  function percent(v) { return isNum(v) ? `${Math.round(v)}%` : '–'; }

  /** degrees -> 16-point compass */
  function compass(deg) {
    if (!isNum(deg)) return '';
    const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  }

  /* ---- time, always in the forecast location's time zone ---- */
  const fmtCache = new Map();
  function fmt(tz, opts) {
    const key = tz + JSON.stringify(opts);
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }));
    return fmtCache.get(key);
  }
  const hourLabel   = (d, tz) => fmt(tz, { hour: 'numeric' }).format(d);              // "3 PM"
  const timeLabel   = (d, tz) => fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(d); // "3:41 PM"
  const weekday     = (d, tz) => fmt(tz, { weekday: 'short' }).format(d);             // "Thu"
  const weekdayLong = (d, tz) => fmt(tz, { weekday: 'long' }).format(d);              // "Thursday"
  const monthDay    = (d, tz) => fmt(tz, { month: 'short', day: 'numeric' }).format(d); // "Nov 13"
  function localHour(d, tz) {
    const h = Number(fmt(tz, { hour: 'numeric', hourCycle: 'h23' }).format(d));
    return h === 24 ? 0 : h;
  }
  function dayKey(d, tz) { return fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }

  function ago(date) {
    const mins = Math.round((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return hrs === 1 ? '1 hr ago' : `${hrs} hr ago`;
  }

  /** "3 PM" -> "3p" style compact range e.g. "1 – 4 PM" */
  function hourRange(a, b, tz) {
    const A = hourLabel(a, tz), B = hourLabel(b, tz);
    const [an, ap] = A.split(' '), [bn, bp] = B.split(' ');
    return ap === bp ? `${an}–${bn} ${bp}` : `${A} – ${B}`;
  }

  window.WX = window.WX || {};
  window.WX.fmt = {
    state, cToF, fToC, isNum, temp, tempValue, tempDelta, speed, parseWind, windText,
    pressure, distance, percent, compass, hourLabel, timeLabel, weekday, weekdayLong,
    monthDay, localHour, dayKey, ago, hourRange,
  };
})();
