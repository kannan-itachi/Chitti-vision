// Maps & location via free OpenStreetMap services (no API key):
//   Nominatim  – geocoding / reverse geocoding (max 1 request per second, cached)
//   OSRM       – road routes: distance + travel time for car, walking, cycling
//   Overpass   – nearby places (hospitals, fuel, restaurants…)
// The user's own position always comes from the HUD (browser geolocation with permission,
// or a place the user named) as coordinates. Nothing here guesses a location.
import { define, ToolError } from './registry.js';

const UA = 'ChittiVision/3.0 (educational BCA student project)';
const headers = { 'User-Agent': UA, 'Accept-Language': 'en' };
const cache = new Map();
let lastNominatim = 0;

async function getJson(url, opts = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeout || 12000), ...opts });
  if (res.status === 429) throw new ToolError('The map service is busy. Try again in a minute.');
  if (!res.ok) throw new ToolError(`The map service returned an error (${res.status}).`);
  return res.json();
}

async function nominatim(url) {
  if (cache.has(url)) return cache.get(url);
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  try {
    const data = await getJson(url);
    cache.set(url, data);
    return data;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('I cannot reach the map service. Maps and places need an internet connection.');
  }
}

export async function geocode(place, near) {
  const bias = near ? `&viewbox=${near.lon - 2},${near.lat + 2},${near.lon + 2},${near.lat - 2}` : '';
  const d = await nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(place)}${bias}`);
  if (!d.length) throw new ToolError(`I could not find a place called "${place}".`);
  // A bare name like "Erode" should mean the city, not the district's centre point.
  const SETTLEMENT = new Set(['city', 'town', 'village', 'suburb', 'hamlet', 'municipality', 'neighbourhood']);
  const best = d.find((r) => SETTLEMENT.has(r.addresstype) || SETTLEMENT.has(r.type)) && !/[,\d]/.test(place.trim()) && place.trim().split(/\s+/).length <= 3
    ? d.find((r) => SETTLEMENT.has(r.addresstype) || SETTLEMENT.has(r.type))
    : d[0];
  return { name: best.display_name, short: shortName(best), lat: Number(best.lat), lon: Number(best.lon) };
}

function shortName(r) {
  const a = r.address || {};
  return [r.name || a.suburb || a.village || a.town || a.city, a.city || a.town || a.county, a.state].filter((v, i, x) => v && x.indexOf(v) === i).slice(0, 3).join(', ') || r.display_name;
}

export async function reverse(lat, lon) {
  const d = await nominatim(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&lat=${lat}&lon=${lon}`);
  if (!d || d.error) throw new ToolError('I could not work out an address for that location.');
  return { name: d.display_name, short: shortName(d), lat, lon };
}

const toRad = (d) => (d * Math.PI) / 180;
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const PROFILE = { driving: 'routed-car/route/v1/driving', walking: 'routed-foot/route/v1/foot', cycling: 'routed-bike/route/v1/bike' };

export async function route(from, to, mode = 'driving') {
  const url = `https://routing.openstreetmap.de/${PROFILE[mode] || PROFILE.driving}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&steps=true`;
  let d;
  try {
    d = await getJson(url, { timeout: 15000 });
  } catch (e) {
    throw e instanceof ToolError ? e : new ToolError('I cannot reach the routing service right now.');
  }
  if (d.code !== 'Ok' || !d.routes?.length) throw new ToolError(`I could not find a ${mode} route between those places.`);
  const r = d.routes[0];
  const roads = [...new Set(r.legs[0].steps.map((s) => s.ref || s.name).filter(Boolean))].slice(0, 4);
  return { km: r.distance / 1000, minutes: r.duration / 60, roads };
}

export const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} metres` : `${km < 10 ? km.toFixed(1) : Math.round(km)} kilometres`);
export const fmtMin = (m) => {
  const total = Math.max(1, Math.round(m)); // round once, so 299.6 min is "5 hours", never "4 hours 60 minutes"
  if (total < 60) return `${total} minute${total === 1 ? '' : 's'}`;
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return `${h} hour${h > 1 ? 's' : ''}${mm ? ` ${mm} minute${mm === 1 ? '' : 's'}` : ''}`;
};

export function mapsUrl({ from, to, mode = 'driving', query, near }) {
  if (query) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}${near ? `+near+${near.lat},${near.lon}` : ''}`;
  const o = from ? `&origin=${from.lat},${from.lon}` : '';
  const dst = to.lat != null ? `${to.lat},${to.lon}` : encodeURIComponent(to.name);
  return `https://www.google.com/maps/dir/?api=1${o}&destination=${dst}&travelmode=${mode === 'cycling' ? 'bicycling' : mode}`;
}

// A point is either "lat,lon" coordinates (from the HUD) or a place name.
async function point(value, label) {
  const m = String(value || '').match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) return { lat: Number(m[1]), lon: Number(m[3]), short: label || 'your location', coords: true };
  if (!value) throw new ToolError('I need a start location. Allow location access in the browser, or tell me where you are, e.g. "I am in Erode".');
  return geocode(value);
}

define({
  name: 'geocode',
  category: 'MAPS',
  description: 'Find a place and its coordinates.',
  params: { place: { type: 'string', required: true, description: 'place name, e.g. Chennai Central' } },
  async run({ place }) {
    const p = await geocode(place);
    return { say: `${p.short} is at latitude ${p.lat.toFixed(4)}, longitude ${p.lon.toFixed(4)}.`, data: p };
  },
});

define({
  name: 'reverse_geocode',
  category: 'LOCATION',
  description: 'Turn coordinates into an address ("where am I").',
  params: { lat: { type: 'number', required: true, description: 'latitude' }, lon: { type: 'number', required: true, description: 'longitude' } },
  async run({ lat, lon }) {
    const r = await reverse(lat, lon);
    return { say: `You are near ${r.short}.`, data: r };
  },
});

define({
  name: 'route_info',
  category: 'MAPS',
  description: 'Distance and travel time between two places by road (driving, walking or cycling).',
  params: {
    from: { type: 'string', required: true, description: 'start place name or "lat,lon"' },
    to: { type: 'string', required: true, description: 'destination place name or "lat,lon"' },
    mode: { type: 'string', enum: ['driving', 'walking', 'cycling'], description: 'travel mode (default driving)' },
  },
  async run({ from, to, mode = 'driving' }) {
    const a = await point(from);
    const b = await point(to);
    const straight = haversineKm(a, b);
    let r = null;
    let note = '';
    try {
      r = await route(a, b, mode);
    } catch (e) {
      note = ` ${e.message}`;
    }
    const verb = { driving: 'drive', walking: 'walk', cycling: 'ride' }[mode];
    const say = r
      ? `${b.short} is ${fmtKm(r.km)} from ${a.coords ? 'here' : a.short} by road, about ${fmtMin(r.minutes)} to ${verb}${r.roads.length ? `, mainly via ${r.roads.slice(0, 2).join(' and ')}` : ''}. In a straight line it is ${fmtKm(straight)}.`
      : `${b.short} is ${fmtKm(straight)} from ${a.coords ? 'here' : a.short} in a straight line.${note}`;
    return { say, data: { from: a, to: b, mode, straightKm: straight, roadKm: r?.km ?? null, minutes: r?.minutes ?? null, via: r?.roads || [], url: mapsUrl({ from: a, to: b, mode }) } };
  },
});

define({
  name: 'navigation_link',
  category: 'MAPS',
  description: 'Build a Google Maps directions link from a start to a destination (to open for turn-by-turn navigation).',
  params: {
    to: { type: 'string', required: true, description: 'destination' },
    from: { type: 'string', description: 'start place or "lat,lon" (optional: Google Maps uses the device location)' },
    mode: { type: 'string', enum: ['driving', 'walking', 'cycling', 'transit'], description: 'travel mode' },
  },
  async run({ to, from, mode = 'driving' }) {
    const b = await point(to);
    const a = from ? await point(from) : null;
    const url = mapsUrl({ from: a, to: b, mode });
    return { say: `Directions to ${b.short} are ready.`, data: { url, from: a, to: b, mode } };
  },
});

const PLACES = {
  hospital: '["amenity"~"^(hospital|clinic)$"]', clinic: '["amenity"="clinic"]', doctor: '["amenity"~"^(doctors|clinic)$"]',
  pharmacy: '["amenity"="pharmacy"]', 'medical shop': '["amenity"="pharmacy"]', fuel: '["amenity"="fuel"]', petrol: '["amenity"="fuel"]',
  'petrol bunk': '["amenity"="fuel"]', 'gas station': '["amenity"="fuel"]', 'charging station': '["amenity"="charging_station"]',
  restaurant: '["amenity"~"^(restaurant|fast_food)$"]', hotel: '["tourism"~"^(hotel|guest_house)$"]', cafe: '["amenity"="cafe"]',
  atm: '["amenity"="atm"]', bank: '["amenity"="bank"]', police: '["amenity"="police"]', school: '["amenity"="school"]', college: '["amenity"~"^(college|university)$"]',
  supermarket: '["shop"~"^(supermarket|convenience)$"]', mall: '["shop"="mall"]', 'bus stop': '["highway"="bus_stop"]', 'bus station': '["amenity"="bus_station"]',
  'railway station': '["railway"="station"]', 'train station': '["railway"="station"]', airport: '["aeroway"="aerodrome"]', parking: '["amenity"="parking"]',
  temple: '["amenity"="place_of_worship"]["religion"="hindu"]', mosque: '["amenity"="place_of_worship"]["religion"="muslim"]', church: '["amenity"="place_of_worship"]["religion"="christian"]',
  park: '["leisure"="park"]', gym: '["leisure"="fitness_centre"]', cinema: '["amenity"="cinema"]', toilet: '["amenity"="toilets"]', 'post office': '["amenity"="post_office"]',
};

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export function placeFilter(kind) {
  const k = String(kind).toLowerCase().replace(/s$/, '').replace(/\b(nearest|nearby|near me|closest)\b/g, '').trim();
  if (PLACES[k]) return { key: k, filter: PLACES[k] };
  const hit = k && Object.entries(PLACES).find(([name]) => k.includes(name) || name.includes(k));
  return hit ? { key: hit[0], filter: hit[1] } : null;
}

define({
  name: 'nearby_places',
  category: 'MAPS',
  description: `Find the nearest places of a kind around a location. Kinds: ${Object.keys(PLACES).join(', ')}.`,
  params: {
    kind: { type: 'string', required: true, description: 'e.g. hospital, petrol, restaurant, atm, pharmacy' },
    near: { type: 'string', required: true, description: '"lat,lon" of the user, or a place name' },
    radius_km: { type: 'number', description: 'search radius in km (default 5)' },
  },
  async run({ kind, near, radius_km = 5 }) {
    const pf = placeFilter(kind);
    if (!pf) throw new ToolError(`I can't search for "${kind}" yet. Try: hospital, petrol, restaurant, pharmacy, ATM, bank, hotel, police, bus stop.`);
    const c = await point(near);
    const r = Math.round(Math.min(25, Math.max(1, radius_km)) * 1000);
    const q = `[out:json][timeout:20];(node${pf.filter}(around:${r},${c.lat},${c.lon});way${pf.filter}(around:${r},${c.lat},${c.lon}););out center 40;`;
    // The public Overpass servers are often busy; try mirrors in turn.
    let d = null;
    for (const [i, server] of OVERPASS.entries()) {
      try {
        d = await getJson(server, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: i === 0 ? 25000 : 15000 });
        break;
      } catch { /* try the next mirror */ }
    }
    if (!d) throw new ToolError('The places service is busy or unreachable right now. Try again in a minute.');
    const places = (d.elements || [])
      .map((e) => ({ name: e.tags?.name || e.tags?.['name:en'] || null, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, phone: e.tags?.phone || null }))
      .filter((p) => p.lat != null)
      .map((p) => ({ ...p, km: haversineKm(c, p) }))
      .sort((a, b) => a.km - b.km);
    const named = places.filter((p) => p.name);
    const top = (named.length ? named : places).slice(0, 5);
    if (!top.length) return { say: `I could not find any ${pf.key} within ${r / 1000} kilometres of ${c.coords ? 'you' : c.short}.`, data: { places: [], center: c } };
    const list = top.slice(0, 3).map((p) => `${p.name || `unnamed ${pf.key}`}, ${fmtKm(p.km)} away`).join('; ');
    return {
      say: `Nearest ${pf.key}${top.length > 1 ? 's' : ''}: ${list}. Distances are in a straight line.`,
      data: { kind: pf.key, center: c, places: top.map((p) => ({ ...p, url: mapsUrl({ to: p }) })), searchUrl: mapsUrl({ query: pf.key, near: c }) },
    };
  },
});
