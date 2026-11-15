/* NOAA / National Weather Service API client (https://api.weather.gov).
   Flow: /points/{lat},{lon} -> grid office + forecast URLs -> fetch the rest in parallel. */
(function () {
  'use strict';

  const API = 'https://api.weather.gov';
  const GEO = 'https://geocoding-api.open-meteo.com/v1/search';

  class NoaaError extends Error {
    constructor(message, { status, title } = {}) {
      super(message);
      this.status = status;
      this.title = title;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** GET JSON with retries — the NWS API intermittently returns 500/503 on grid endpoints. */
  async function getJSON(url, { retries = 2, signal } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = new NoaaError('Could not reach the weather service. Check your connection.', { title: 'Network error' });
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (res.ok) return res.json();

      let detail = '';
      try { const body = await res.json(); detail = body.detail || body.title || ''; } catch (_) { /* not JSON */ }
      lastErr = new NoaaError(detail || `Weather service responded with ${res.status}.`, { status: res.status });
      if (res.status >= 500 || res.status === 429) { await sleep(700 * (attempt + 1)); continue; }
      throw lastErr; // 4xx: retrying won't help
    }
    throw lastErr;
  }

  const r4 = (n) => Number(n).toFixed(4).replace(/\.?0+$/, '');

  async function getPoint(lat, lon, signal) {
    try {
      const data = await getJSON(`${API}/points/${r4(lat)},${r4(lon)}`, { signal });
      return data.properties;
    } catch (err) {
      if (err.status === 404) {
        throw new NoaaError('NOAA forecasts cover the United States and its territories. Try a U.S. city or ZIP code.', { status: 404, title: 'Location outside NWS coverage' });
      }
      throw err;
    }
  }

  /* ---------- normalizers ---------- */
  const toF = (v, unit) => (v == null ? null : (unit === 'C' ? v * 9 / 5 + 32 : v));
  const qvToF = (q) => (q && q.value != null ? (/degC/.test(q.unitCode || 'degC') ? q.value * 9 / 5 + 32 : q.value) : null);

  function normPeriod(p) {
    return {
      name: p.name,
      start: new Date(p.startTime),
      end: new Date(p.endTime),
      isDaytime: p.isDaytime,
      tempF: toF(p.temperature, p.temperatureUnit),
      trend: p.temperatureTrend,
      pop: p.probabilityOfPrecipitation ? (p.probabilityOfPrecipitation.value ?? 0) : 0,
      dewF: qvToF(p.dewpoint),
      rh: p.relativeHumidity ? p.relativeHumidity.value : null,
      wind: p.windSpeed,
      windDir: p.windDirection,
      short: p.shortForecast,
      detailed: p.detailedForecast,
    };
  }

  /** Pair day/night periods into calendar-day rows. A leading "Tonight" becomes its own row. */
  function groupDays(periods) {
    const days = [];
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      if (p.isDaytime) {
        const night = periods[i + 1] && !periods[i + 1].isDaytime ? periods[i + 1] : null;
        days.push({ day: p, night });
        if (night) i++;
      } else {
        days.push({ day: null, night: p });
      }
    }
    return days;
  }

  async function getForecast(url, signal) {
    const data = await getJSON(url, { signal });
    const periods = data.properties.periods.map(normPeriod);
    return { updated: new Date(data.properties.updateTime || data.properties.generatedAt), periods, days: groupDays(periods) };
  }

  async function getHourly(url, signal) {
    const data = await getJSON(url, { signal });
    const now = Date.now();
    const hours = data.properties.periods.map(normPeriod).filter((h) => h.end.getTime() > now);
    return { updated: new Date(data.properties.updateTime || data.properties.generatedAt), hours };
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const val = (q) => (q && q.value != null ? q.value : null);

  /** Latest usable observation from the nearest stations (skips stations with missing temperature or stale data). */
  async function getObservation(stationsUrl, lat, lon, signal) {
    const st = await getJSON(stationsUrl, { signal });
    const stations = (st.features || []).slice(0, 4);
    for (const f of stations) {
      const id = f.properties.stationIdentifier;
      try {
        const obs = await getJSON(`${API}/stations/${id}/observations?limit=6`, { retries: 1, signal });
        const hit = (obs.features || []).map((o) => o.properties).find((o) => val(o.temperature) != null);
        if (!hit) continue;
        const time = new Date(hit.timestamp);
        if (Date.now() - time.getTime() > 3 * 3600 * 1000) continue; // older than 3h — try next station
        const [slon, slat] = f.geometry.coordinates;
        const tC = val(hit.temperature);
        const feelsC = val(hit.heatIndex) ?? val(hit.windChill) ?? tC;
        const kmh = (q) => (val(q) == null ? null : (/m_s-1/.test(q.unitCode) ? q.value * 3.6 : q.value));
        return {
          stationId: id,
          stationName: f.properties.name,
          distanceKm: haversineKm(lat, lon, slat, slon),
          time,
          text: hit.textDescription,
          tempF: tC * 9 / 5 + 32,
          feelsF: feelsC * 9 / 5 + 32,
          dewF: val(hit.dewpoint) == null ? null : val(hit.dewpoint) * 9 / 5 + 32,
          rh: val(hit.relativeHumidity),
          windMph: kmh(hit.windSpeed) == null ? null : kmh(hit.windSpeed) / 1.609344,
          gustMph: kmh(hit.windGust) == null ? null : kmh(hit.windGust) / 1.609344,
          windDeg: val(hit.windDirection),
          pressurePa: val(hit.barometricPressure) ?? val(hit.seaLevelPressure),
          visibilityM: val(hit.visibility),
        };
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        /* try the next station */
      }
    }
    return null;
  }

  const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

  async function getAlerts(lat, lon, signal) {
    const data = await getJSON(`${API}/alerts/active?point=${r4(lat)},${r4(lon)}`, { signal });
    return (data.features || [])
      .map((f) => f.properties)
      .map((a) => ({
        id: a.id,
        event: a.event,
        headline: a.headline,
        severity: a.severity || 'Unknown',
        urgency: a.urgency,
        description: a.description,
        instruction: a.instruction,
        sender: a.senderName,
        onset: a.onset ? new Date(a.onset) : null,
        ends: a.ends ? new Date(a.ends) : (a.expires ? new Date(a.expires) : null),
      }))
      .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
  }

  /** Latest Area Forecast Discussion for the forecast office. */
  async function getDiscussion(office, signal) {
    const list = await getJSON(`${API}/products/types/AFD/locations/${office}`, { signal });
    const latest = (list['@graph'] || [])[0];
    if (!latest) return null;
    const prod = await getJSON(latest['@id'], { signal });
    return { issued: new Date(prod.issuanceTime), text: prod.productText || '' };
  }

  /**
   * Load everything for a lat/lon. Sub-requests are independent: one failing
   * (e.g. observations) doesn't block the rest. Forecasts are required.
   */
  async function loadAll(lat, lon, { signal } = {}) {
    const point = await getPoint(lat, lon, signal);
    const [forecast, hourly, obs, alerts] = await Promise.allSettled([
      getForecast(point.forecast, signal),
      getHourly(point.forecastHourly, signal),
      getObservation(point.observationStations, lat, lon, signal),
      getAlerts(lat, lon, signal),
    ]);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (forecast.status === 'rejected' && hourly.status === 'rejected') {
      throw new NoaaError(
        `The forecast for this grid isn’t available right now (${forecast.reason.message}). NOAA’s servers sometimes hiccup — try again in a moment.`,
        { title: 'Forecast temporarily unavailable' }
      );
    }
    const rel = point.relativeLocation && point.relativeLocation.properties;
    return {
      point: {
        lat, lon,
        office: point.cwa || point.gridId,
        gridId: point.gridId, gridX: point.gridX, gridY: point.gridY,
        timeZone: point.timeZone,
        city: rel ? rel.city : null,
        state: rel ? rel.state : null,
        radar: point.radarStation,
      },
      forecast: forecast.status === 'fulfilled' ? forecast.value : null,
      hourly: hourly.status === 'fulfilled' ? hourly.value : null,
      obs: obs.status === 'fulfilled' ? obs.value : null,
      alerts: alerts.status === 'fulfilled' ? alerts.value : [],
      errors: [forecast, hourly, obs, alerts].filter((r) => r.status === 'rejected').map((r) => r.reason.message),
      fetchedAt: new Date(),
    };
  }

  /* ---------- place search (Open-Meteo geocoding; NOAA has no geocoder) ---------- */
  async function searchPlaces(query, signal) {
    const url = `${GEO}?name=${encodeURIComponent(query)}&count=8&language=en&format=json&countryCode=US`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('Place search is unavailable right now.');
    const data = await res.json();
    return (data.results || []).map((r) => ({
      name: r.name,
      region: [
        r.admin2 && r.admin2 !== r.name ? r.admin2 + (r.admin1 === 'Louisiana' ? ' Parish' : r.admin1 === 'Alaska' ? '' : ' County') : null,
        r.admin1,
      ].filter(Boolean).join(', '),
      admin1: r.admin1,
      lat: r.latitude,
      lon: r.longitude,
    }));
  }

  window.WX = window.WX || {};
  window.WX.noaa = { loadAll, getDiscussion, searchPlaces, NoaaError };
})();
