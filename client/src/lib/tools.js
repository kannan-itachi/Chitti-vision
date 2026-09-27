// One entry point for every tool: runs HUD-side tools here (maths, location, camera,
// notifications, session memory) and forwards the rest to the local server with the session
// token. Always resolves to { success, result: { say, data }, error, needsConfirmation? }.
import { store } from '../store';
import * as calc from './calc';

// ---------- server bridge ----------

let token = null;
async function sessionToken() {
  if (token) return token;
  const r = await fetch('/api/session');
  if (!r.ok) throw new Error('The local server refused the session.');
  token = (await r.json()).token;
  return token;
}

async function post(path, body, retry = true) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-chitti-token': await sessionToken() }, body: JSON.stringify(body) });
  } catch {
    return { success: false, result: null, error: 'My local server is offline. Start it with npm run dev.' };
  }
  if (res.status === 401 && retry) { // server restarted → new token
    token = null;
    return post(path, body, false);
  }
  try {
    return await res.json();
  } catch {
    return { success: false, result: null, error: `Server error (${res.status}).` };
  }
}

export const serverTool = (name, args = {}) => post(`/api/tools/${name}`, { args });
export const confirmTool = (confirmId, approved) => post('/api/tools/confirm', { confirmId, approved });
export const planWithModel = (text, context) => post('/api/plan', { text, context });

// ---------- location (only real data: browser GPS/Wi-Fi with permission, or a place the user named) ----------

const HERE = /^(current_location|current location|here|my location|me|my position|where i am|from here|near me)$/i;
export const isHere = (v) => HERE.test(String(v || '').trim());

function browserPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share your location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission was denied.' : 'Your location is unavailable right now.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5 * 60e3 },
    );
  });
}

export async function currentLocation({ refresh = false } = {}) {
  const s = store().session;
  if (s.location && !refresh && (s.location.source === 'user' || Date.now() - s.location.at < 10 * 60e3)) return s.location;
  let pos;
  try {
    pos = await browserPosition();
  } catch (e) {
    throw new Error(`${e.message} Tell me where you are, for example "I am in Erode".`);
  }
  let label = `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}`;
  const rev = await serverTool('reverse_geocode', { lat: pos.lat, lon: pos.lon });
  if (rev.success) label = rev.result.data.short;
  const loc = { ...pos, label, source: 'gps', at: Date.now() };
  store().merge('session', { location: loc });
  return loc;
}

const coords = (loc) => `${loc.lat},${loc.lon}`;

// Replace "CURRENT_LOCATION"/"here" arguments with real coordinates (asking permission if needed).
async function resolveHere(args) {
  const out = { ...args };
  for (const k of ['from', 'to', 'near', 'destination']) {
    if (k in out && isHere(out[k])) out[k] = coords(await currentLocation());
  }
  return out;
}

// ---------- HUD-side tools ----------

const ok = (say, data = null) => ({ success: true, result: { say, data }, error: null });

const CLIENT = {
  async calculate({ expression }) {
    const r = await calc.calculate(expression);
    return ok(r.say, { value: r.value });
  },
  async convert_units({ value, from, to }) {
    const r = await calc.convertUnits(value, from, to);
    return ok(r.say, { value: r.value });
  },
  async solve_equation({ equation }) {
    const r = await calc.solveEquation(equation);
    return ok(r.say, { value: r.value });
  },
  async date_calc({ question }) {
    const r = calc.dateCalc(question);
    if (!r) throw new Error("I couldn't work out that date calculation. Try: days between 1 Jan 2026 and 15 Aug 2026.");
    return ok(r.say);
  },
  async next_in_sequence({ numbers }) {
    const r = calc.nextInSequence(numbers);
    if (!r) throw new Error('I could not find a simple pattern in that sequence.');
    return ok(r.say);
  },
  async current_location() {
    const loc = await currentLocation({ refresh: true });
    return ok(`You are near ${loc.label}${loc.accuracy ? `, accurate to about ${loc.accuracy < 1000 ? `${loc.accuracy} metres` : `${Math.round(loc.accuracy / 1000)} kilometres`}` : ''}.`, loc);
  },
  async set_location({ place }) {
    const r = await serverTool('geocode', { place });
    if (!r.success) throw new Error(r.error);
    const g = r.result.data;
    const loc = { lat: g.lat, lon: g.lon, label: g.short, source: 'user', at: Date.now() };
    store().merge('session', { location: loc });
    return ok(`Got it. I'll use ${g.short} as your location for this session.`, loc);
  },
  async navigate_to({ destination, mode = 'driving' }) {
    let from = null;
    try { from = await currentLocation(); } catch { /* Google Maps can use the device location itself */ }
    const link = await serverTool('navigation_link', { to: destination, from: from ? coords(from) : undefined, mode });
    if (!link.success) throw new Error(link.error);
    const opened = await serverTool('open_url', { url: link.result.data.url });
    if (!opened.success) throw new Error(opened.error);
    store().merge('session', { destination: link.result.data.to.short, task: `Travel to ${link.result.data.to.short}` });
    return ok(`Opening directions to ${link.result.data.to.short} in Google Maps${from ? ` from ${from.label}` : ''}.`, link.result.data);
  },
  async describe_camera() {
    await store().visionHooks?.describe?.();
    return ok('', { handled: true });
  },
  async identify_object() {
    await store().visionHooks?.identify?.();
    return ok('', { handled: true });
  },
  async notify({ message }) {
    if (!('Notification' in window)) throw new Error('Notifications are not supported in this browser.');
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') throw new Error('Notification permission was denied.');
    new Notification('CHITTI', { body: message, icon: '/chitti.svg' });
    return ok('Notification sent.');
  },
  async remember_session({ note }) {
    store().merge('session', { notes: [...store().session.notes, note].slice(-20) });
    return ok(`Noted for this session: ${note}.`);
  },
  async forget_task() {
    store().merge('session', { task: null, destination: null, notes: [], last: null, pendingChoice: null });
    return ok('Current task and session notes cleared.');
  },
};

export const isClientTool = (name) => name in CLIENT;

export async function runTool(name, args = {}) {
  try {
    if (CLIENT[name]) return await CLIENT[name](args);
    return await serverTool(name, await resolveHere(args));
  } catch (e) {
    return { success: false, result: null, error: e.message || String(e) };
  }
}
