/* Inline SVG weather icons + mapping from NOAA's shortForecast text. */
(function () {
  'use strict';

  const CLOUD = 'M6.5 19h11a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.6 1.2 3.9 3.9 0 0 0 .1 7.77z';
  const cloud = (t = '') =>
    `<path d="${CLOUD}" transform="${t}" fill="var(--cloud-fill)" stroke="var(--cloud-stroke)" stroke-width="1.3" stroke-linejoin="round"/>`;

  function sun(cx, cy, r, rayIn, rayOut) {
    let rays = '';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * rayIn, y1 = cy + Math.sin(a) * rayIn;
      const x2 = cx + Math.cos(a) * rayOut, y2 = cy + Math.sin(a) * rayOut;
      rays += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
    }
    return `<g stroke="var(--sun)" stroke-width="1.6" stroke-linecap="round">${rays}</g>` +
           `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--sun)"/>`;
  }
  const moon = (t = '') =>
    `<path d="M19.5 14.6A7.6 7.6 0 1 1 9.4 4.5a6.1 6.1 0 0 0 10.1 10.1z" transform="${t}" fill="var(--moon)" stroke="#9aa6bf" stroke-width=".8" stroke-linejoin="round"/>`;

  const drops = (color = 'var(--rain)') =>
    `<g stroke="${color}" stroke-width="1.8" stroke-linecap="round"><line x1="8.5" y1="18.5" x2="7.5" y2="21.5"/><line x1="12.5" y1="18.5" x2="11.5" y2="21.5"/><line x1="16.5" y1="18.5" x2="15.5" y2="21.5"/></g>`;
  const flakes =
    `<g fill="var(--snow)"><circle cx="8" cy="19.6" r="1.25"/><circle cx="12" cy="21.4" r="1.25"/><circle cx="16" cy="19.6" r="1.25"/></g>`;
  const sleet =
    `<g stroke="var(--rain)" stroke-width="1.8" stroke-linecap="round"><line x1="8.5" y1="18.5" x2="7.5" y2="21.5"/><line x1="16.5" y1="18.5" x2="15.5" y2="21.5"/></g><circle cx="12" cy="20.5" r="1.25" fill="var(--snow)"/>`;
  const bolt = `<path d="M13.2 14.2 9.6 19.4h2.8l-1.3 4 4.2-5.6h-2.8z" fill="var(--bolt)" stroke="var(--bolt)" stroke-width=".6" stroke-linejoin="round"/>`;
  const fogLines = `<g stroke="var(--cloud-stroke)" stroke-width="1.6" stroke-linecap="round"><line x1="4" y1="19.5" x2="20" y2="19.5"/><line x1="6" y1="22.3" x2="18" y2="22.3"/></g>`;

  const ICONS = {
    'clear-day':    sun(12, 12, 4.6, 7, 9.6),
    'clear-night':  moon('translate(-1.5 0.5)'),
    'partly-day':   sun(8.6, 8.4, 3.5, 5.4, 7.3) + cloud('translate(3 3.4) scale(.82)'),
    'partly-night': moon('translate(-3.2 -2.2) scale(.78)') + cloud('translate(3 3.4) scale(.82)'),
    'cloudy':       cloud('translate(-1 -0.5) scale(1.05)'),
    'rain':         cloud('translate(0 -3.6)') + drops(),
    'storm':        cloud('translate(0 -4.2)') + bolt,
    'snow':         cloud('translate(0 -3.6)') + flakes,
    'sleet':        cloud('translate(0 -3.6)') + sleet,
    'fog':          cloud('translate(0 -4.4)') + fogLines,
    'wind':         `<g fill="none" stroke="var(--cloud-stroke)" stroke-width="1.8" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 17h7"/></g>`,
  };

  /** Map a NOAA shortForecast (e.g. "Chance Rain Showers then Mostly Sunny") to an icon key. */
  function kindFor(shortForecast, isDaytime = true) {
    const s = String(shortForecast || '').split(/\bthen\b/i)[0].toLowerCase();
    const dn = isDaytime ? 'day' : 'night';
    if (/thunder|t-storm|tstorm/.test(s)) return 'storm';
    if (/sleet|freezing|ice pellets|wintry|frzg/.test(s)) return 'sleet';
    if (/rain|drizzle/.test(s) && /snow/.test(s)) return 'sleet'; // "Rain And Snow Showers" (but not plain "Snow Showers")
    if (/snow|flurr|blizzard/.test(s)) return 'snow';
    if (/rain|shower|drizzle|sprinkle/.test(s)) return 'rain';
    if (/fog|haze|smoke|mist|dust/.test(s)) return 'fog';
    if (/mostly cloudy|overcast|^cloudy|considerable cloud/.test(s)) return 'cloudy';
    if (/partly|mostly sunny|mostly clear|few clouds|increasing clouds|decreasing clouds/.test(s)) return `partly-${dn}`;
    if (/sunny|clear|fair/.test(s)) return `clear-${dn}`;
    if (/wind|breez|blustery|gust/.test(s)) return 'wind';
    if (/cloud/.test(s)) return 'cloudy';
    return `partly-${dn}`;
  }

  function svg(kind, label = '') {
    const body = ICONS[kind] || ICONS['cloudy'];
    const a11y = label ? `role="img" aria-label="${label.replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
    return `<svg viewBox="0 0 24 24" ${a11y}>${body}</svg>`;
  }

  /* small UI glyphs (stroke = currentColor) */
  const UI = {
    drop:    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5s6 6.6 6 10.8a6 6 0 0 1-12 0C6 10.1 12 3.5 12 3.5z" fill="var(--series-precip)"/></svg>',
    alert:   '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
    thermo:  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--series-temp)" stroke-width="1.8" stroke-linecap="round"><path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z"/><path d="M12 9v6.5"/></svg>',
    wind:    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--text-secondary)" stroke-width="1.8" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 17h7"/></svg>',
    clock:   '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };

  window.WX = window.WX || {};
  window.WX.icons = { kindFor, svg, UI };
})();
