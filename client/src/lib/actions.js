// Command router + actions. Every input (typed or spoken) flows through handleInput:
//   1. built-in commands (vision, learning, modes, missions…)
//   2. the offline mind (time, memory, maths, timers, "where is…", small talk)
//   3. the language core (Claude or local Ollama) when one is connected
//   4. otherwise the local document bank, then an honest "teach me" fallback.
import { store, MODES, nid } from '../store';
import * as api from './api';
import { parse, HELP } from './commands';
import { speech } from './speech';
import { sfx } from './sfx';
import { vision } from './vision';
import { perception, forget as forgetLearned, learnedLabels } from './perception';
import * as mind from './mind';
import * as knowledge from './knowledge';
import { NAME } from './speech';
import { route, looksActionable } from './intents';
import * as agent from './agent';
import { runTool } from './tools';

const MODE_LINES = {
  combat: 'Red chip activated. Combat protocol engaged.',
  calm: 'Good chip restored. Friendly protocol active.',
  research: 'Research protocol online. I will analyse everything in detail.',
};

let brainCtrl = null;
let lastAnnounce = 0;
const announced = new Map();

// ---------- output helpers ----------

export function reply(text, { speak = true, kind, links, files } = {}) {
  store().addMessage({ role: 'chitti', text, kind, links: links?.length ? links : undefined, files: files?.length ? files : undefined });
  if (speak) speech.say(text);
}

function system(text) {
  store().addMessage({ role: 'system', text });
}

// ---------- telemetry snapshot sent to the brain ----------

function perceptionSummary() {
  const s = store();
  const bits = [];
  const f = s.focus;
  if (f && Date.now() - f.at < 4000) {
    bits.push(f.learned ? `object in centre: the user's ${f.learned.label} (learned)` : `object in centre (classifier): ${f.labels.map((l) => `${l.label} ${Math.round(l.prob * 100)}%`).join(', ')}; colour ${f.color}`);
  }
  if (s.scene.brightness != null) bits.push(`brightness ${s.scene.brightness}/255`);
  if (s.scene.motion > 0.05) bits.push(`motion on the ${s.scene.motionSide}`);
  if (s.learned.length) bits.push(`objects the user taught me: ${s.learned.map((l) => l.label).join(', ')}`);
  return bits.join('; ');
}

function telemetry(channel) {
  const s = store();
  const t = s.tracks;
  const locked = t.find((x) => x.id === s.lockId);
  const pct = s.battery.level == null ? 'unknown' : `${Math.round(s.battery.level * 100)}%${s.battery.charging ? ' (charging)' : ''}`;
  return {
    time: new Date().toLocaleString(),
    mode: s.lowPower ? `${s.mode} (low-power)` : s.mode,
    vision: s.vision.status === 'live' ? `online, ${s.vision.fps} fps` : s.vision.status,
    targets: t.length ? t.slice(0, 8).map((x) => `T-${x.id} ${x.name}${x.name !== x.cls ? ` (detector: ${x.cls})` : ''}, ${x.color ? `${x.color}, ` : ''}${x.side}, ${x.range.toLowerCase()} range`).join('; ') : 'none',
    locked: locked ? `T-${locked.id} ${locked.name}` : 'none',
    threat: s.threat,
    mission: s.mission || 'none',
    battery: pct,
    perception: perceptionSummary(),
    personal: [mind.personalContext(), sessionContext()].filter(Boolean).join('\n'),
    thoughts: s.thoughts.slice(-4).map((x) => x.text).join(' '),
    channel,
  };
}

function historyForBrain() {
  return store().messages
    .filter((m) => (m.role === 'user' || m.role === 'chitti') && m.text && !m.streaming && !m.error)
    .slice(-14)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
}

// ---------- the language core (streaming, spoken sentence by sentence) ----------

export async function askBrain(message, { image, thumb, docOnly = false, channel = 'keyboard', history, info, reference, reasoning = false, links } = {}) {
  const s = store();
  brainCtrl?.abort();
  const ctrl = (brainCtrl = new AbortController());
  speech.stop();

  const id = s.addMessage({ role: 'chitti', text: '', streaming: true, image: thumb, links: links?.length ? links : undefined });
  s.set({ brain: 'thinking' });
  sfx.think();

  let full = '';
  let spoken = 0;
  const speakReady = (final) => {
    const pending = full.slice(spoken);
    const m = final ? pending : pending.match(/^[\s\S]*[.!?…](?=\s)/)?.[0];
    if (m && m.trim()) {
      speech.say(m);
      spoken += m.length;
    }
  };

  try {
    await api.streamChat(
      { message, history: history ?? historyForBrain(), context: { ...telemetry(channel), reasoning }, image, docId: s.activeDocId, docOnly, reference },
      (ev) => {
        if (ev.type === 'sources') store().updateMessage(id, { sources: ev.sources });
        else if (ev.type === 'delta') {
          if (store().brain !== 'streaming') store().set({ brain: 'streaming' });
          full += ev.text;
          store().updateMessage(id, { text: full });
          speakReady(false);
        } else if (ev.type === 'error') {
          full += (full ? ' ' : '') + ev.message;
          store().updateMessage(id, { text: full, error: true });
          sfx.alert();
        }
      },
      ctrl.signal,
    );
    speakReady(true);
  } catch {
    if (ctrl.signal.aborted) {
      full ||= '[interrupted]';
    } else {
      full = 'My neural link to the server is down. Start it with npm run dev, then try again.';
      store().merge('backend', { online: false, ai: false });
      speech.say(full);
    }
    store().updateMessage(id, { error: !ctrl.signal.aborted });
  } finally {
    store().updateMessage(id, { text: full || '…', streaming: false });
    if (brainCtrl === ctrl) {
      brainCtrl = null;
      store().set({ brain: 'idle' });
    }
    if (info) store().merge('info', { status: 'ready', text: full, progress: 100 });
  }
  return full;
}

export function interrupt() {
  brainCtrl?.abort();
  speech.stop();
}

// ---------- vision actions ----------

export async function startVision() {
  const e = vision.engine;
  if (!e) return;
  if (store().vision.status === 'live') return reply('Optical sensors are already online.');
  system('Optical sensors initialising…');
  try {
    await e.start();
    sfx.online();
    const off = store().vision.detectorOffline;
    reply(`Vision online${off ? ', running fully offline' : ''}. Scanning the environment.`);
  } catch (err) {
    sfx.alert();
    reply(`Vision failure: ${err.message}`);
  }
}

export function stopVision() {
  vision.engine?.stop();
  reply('Optical sensors offline.');
}

async function ensureVision() {
  if (store().vision.status === 'live') return true;
  reply('Starting my eyes first.');
  await startVision();
  if (store().vision.status !== 'live') return false;
  await new Promise((r) => setTimeout(r, 800));
  return true;
}

function sceneSummary() {
  const t = store().tracks;
  if (store().vision.status !== 'live') return 'My optical sensors are offline. Say start vision first.';
  if (!t.length) return 'Area scanned. No significant objects in view.';
  const main = t[0];
  const counts = {};
  t.forEach((x) => (counts[x.name] = (counts[x.name] || 0) + 1));
  const list = Object.entries(counts).map(([c, n]) => (n > 1 ? `${n} ${c}s` : `a ${c}`)).join(', ');
  return `Scan complete. I see ${list}. Primary target is a ${main.name} at ${main.range.toLowerCase()} range. Threat level ${store().threat}.`;
}

async function analyzeScene(q, channel, history) {
  if (!(await ensureVision())) return;
  const e = vision.engine;
  const { backend } = store();
  // Image-capable brain (Claude, or a vision model in Ollama): send the actual frame.
  if (backend.ai && backend.vision) {
    const frame = e.capture();
    if (!frame) return reply('I could not capture a frame from the camera.');
    flash();
    sfx.lock();
    return askBrain(q, { image: frame.base64, thumb: frame.dataUrl, channel, history });
  }
  // Otherwise describe it from on-device perception (works offline).
  flash();
  sfx.lock();
  if (!perception.model && store().settings.smartIdentify) await perception.init();
  reply(mind.describeScene());
}

function flash() {
  const el = document.querySelector('.stage');
  el?.classList.add('flash');
  setTimeout(() => el?.classList.remove('flash'), 500);
}

async function identify({ colorOnly = false } = {}) {
  if (!(await ensureVision())) return;
  const r = await vision.engine.identifyNow();
  if (!r) return reply('My recognition model is not available. Run npm run models once with internet.');
  flash();
  if (r.person) {
    if (colorOnly) return reply('That is a person. Hold an object up in the centre and ask again.');
    if (r.name) return reply(`That is ${r.name === mind.memory.userName ? 'you, ' : ''}${r.name}. Face match ${Math.round(r.sim * 100)} percent.`);
    return reply('I see a person, but I do not recognise the face. Say "my name is" and your name, and I will remember you.');
  }
  const [a, b] = r.labels;
  const where = r.track ? 'The locked target' : 'That';
  if (colorOnly) {
    const name = r.learned?.label || (a.prob > 0.3 ? a.label : 'object');
    return reply(`${where} ${name === 'object' ? 'object' : name} looks mostly ${r.color}.`);
  }
  if (r.learned) {
    sfx.done();
    return reply(`${where} is your ${r.learned.label}. I am ${Math.round(r.learned.sim * 100)} percent sure.`);
  }
  const col = r.color && r.color !== 'unknown' ? `${r.color} ` : '';
  if (a.prob < 0.25) return reply(`I am not sure what that is. My best guess is a ${a.label}. Hold it closer to the centre, or teach me with "learn this as" and its name.`);
  // Analyse it: add what Chitti knows (or quickly researches) about the object.
  const info = await knowledge.describe(a.label);
  if (info) knowledge.setTopic(info, 1);
  const about = info ? ` ${knowledge.sentences(info.summary)[0] || ''}` : '';
  const more = info ? ' Say "explain more" to learn more.' : '';
  if (a.prob >= 0.6) return reply(`${where} is a ${col}${a.label}.${about}${more}`);
  return reply(`${where} looks like a ${col}${a.label}${b && b.prob > 0.1 ? `, or possibly a ${b.label}` : ''}.${about} If I am wrong, say "learn this as" and its name.`);
}

async function learnObject(label) {
  if (!label) return reply('Tell me the name, for example: learn this as my fan.');
  if (!(await ensureVision())) return;
  const kind = vision.engine.focusRegion().kind;
  reply(kind === 'face' ? `Look at the camera. Memorising ${label}'s face.` : `Hold it steady in the centre. Learning ${label}.`);
  try {
    const { n } = await vision.engine.learn(label);
    sfx.done();
    store().addThought(`Learned new ${kind === 'face' ? 'face' : 'object'}: ${label} (${n} views).`, 'decide');
    if (kind === 'face') return reply(`Done. I will recognise ${label} from now on.`);
    reply(`Learned. I will recognise your ${label} from now on. ${n > 8 ? 'Extra views make me more accurate.' : 'Teach me again from another angle to improve accuracy.'}`);
  } catch (e) {
    sfx.alert();
    reply(`Learning failed: ${e.message}.`);
  }
}

// Remember the face in view under a name (used after "my name is …").
async function learnFace(name) {
  try {
    await vision.engine.learn(name, { forceFace: true });
    store().addThought(`Face memorised: ${name}.`, 'decide');
    speech.say('I have memorised your face too.');
  } catch { /* no face or model not ready — the name is still remembered */ }
}

let greetedFaces = {};
export function onFaceRecognized(name) {
  store().addThought(`Face recognised: ${name}.`, 'infer');
  const now = Date.now();
  if (now - (greetedFaces[name] || 0) < 20 * 60e3) return;
  greetedFaces[name] = now;
  if (store().brain === 'idle' && store().settings.thinking) mind.greetByName(name);
}

function lockTarget(name) {
  const e = vision.engine;
  if (store().vision.status !== 'live' || !e) return reply('No visual feed. Start vision before locking a target.');
  const t = e.pickTarget(name);
  if (!t) return reply(name ? `No ${name} in view to lock onto.` : 'No target in view to lock onto.');
  store().set({ lockId: t.id });
  sfx.lock();
  reply(`Target locked. T ${t.id}, ${t.alias || t.cls}.`);
}

export function lockById(id) {
  const t = store().tracks.find((x) => x.id === id);
  if (!t) return;
  if (store().lockId === id) {
    store().set({ lockId: null });
    return reply('Target released.');
  }
  store().set({ lockId: id });
  sfx.lock();
  reply(`Locking onto T ${id}, ${t.name}.`);
}

// Called by the vision engine when a new target is confirmed (after re-identification).
export function onNewTarget(t) {
  const s = store();
  sfx.blip();
  const name = t.alias || t.cls;
  if (s.recordMode) record(`${new Date().toLocaleTimeString()} — ${name} detected`);
  if (!s.settings.callouts || s.brain !== 'idle' || s.voice.speaking) return;
  const now = Date.now();
  const gap = s.mode === 'combat' ? 3000 : s.mode === 'research' ? 5000 : 8000;
  if (now - lastAnnounce < gap || now - (announced.get(name) || 0) < 60000) return;
  lastAnnounce = now;
  announced.set(name, now);
  const line = s.mode === 'combat' ? `Contact. ${name}.` : t.source === 'learned' ? `I see your ${name}.` : `${name[0].toUpperCase() + name.slice(1)} detected.`;
  speech.say(line);
}

export function onTargetLost() {
  sfx.alert();
  reply('Target lost.');
}

// ---------- knowledge ----------

export async function uploadFile(file) {
  if (!file) return;
  const s = store();
  s.set({ upload: { name: file.name, size: file.size, type: file.type || 'unknown', progress: 0, phase: 'uploading', preview: '' } });
  speech.say('Retrieving content. Analysing file.');
  try {
    const doc = await api.uploadDoc(file, (p) => store().merge('upload', { progress: Math.min(92, p * 90) }));
    store().merge('upload', { progress: 100, phase: 'done', preview: doc.preview, chunks: doc.chunks });
    store().set((st) => ({ docs: [doc, ...st.docs.filter((d) => d.id !== doc.id && d.name !== doc.name)], activeDocId: doc.id }));
    sfx.done();
    store().addThought(`Indexed ${doc.name} into ${doc.chunks} memory blocks.`, 'decide');
    reply(`File scan complete. ${doc.name} is indexed into ${doc.chunks} memory blocks. Ask me anything about it.`);
  } catch (e) {
    store().merge('upload', { phase: 'error', error: e.message });
    sfx.alert();
    reply(`Unable to read file. ${e.message}`);
  }
  setTimeout(() => {
    if (store().upload?.phase !== 'uploading') store().set({ upload: null });
  }, 6000);
}

export async function removeDoc(id) {
  await api.deleteDoc(id).catch(() => {});
  store().set((s) => ({ docs: s.docs.filter((d) => d.id !== id), activeDocId: s.activeDocId === id ? null : s.activeDocId }));
}

export function pickFile() {
  document.getElementById('file-input')?.click();
}

// Session-only context for the language core (never persisted).
function sessionContext() {
  const s = store().session;
  return [
    s.location && `user's current location (this session): ${s.location.label}`,
    s.destination && `current destination: ${s.destination}`,
    s.task && `current task: ${s.task}`,
    s.notes.length && `session notes: ${s.notes.join('; ')}`,
    s.last && `last tool result: ${s.last}`,
  ].filter(Boolean).join('\n');
}

// Wire the agent and camera tools to the existing HUD functions.
agent.setAgentHooks({
  reply: (text, opts) => reply(text, opts),
  askBrain: (q, { reference, links } = {}) => askBrain(q, { reference, links }),
  showCard: (card) => store().set({ info: { id: nid(), status: 'ready', image: null, ...card } }),
});
store().set({ visionHooks: { describe: () => analyzeScene('what do you see?', 'keyboard'), identify: () => identify() } });

function showInfo(kind, term, source) {
  const info = { id: nid(), kind, term, source, status: 'retrieving', text: '', image: null, url: null };
  store().set({ info });
  return info;
}

async function docQuestion(q, channel) {
  const s = store();
  if (!s.docs.length) return reply('No document loaded. Upload a file with the plus button first.');
  const doc = s.docs.find((d) => d.id === s.activeDocId);
  showInfo('doc', q, doc?.name || 'ALL DOCUMENTS');
  await askBrain(q, { docOnly: true, channel, info: true });
}

function showWiki(entry) {
  store().merge('info', { status: 'ready', term: entry.title, text: entry.summary, image: entry.image, url: entry.url, description: entry.description });
}

const FRESH = ['', '', 'Here is what I found. ', 'Analysis complete. '];
const REMEMBERED = ['I know this. ', 'Yes, I remember. ', 'From my memory: '];

// Say "let me check" only if research takes longer than a moment, so fast answers stay snappy.
function thinkingAloud(topic) {
  const t = setTimeout(() => {
    speech.say(['Let me check.', 'Analysing.', 'One moment, searching my knowledge core.'][Math.floor(Math.random() * 3)]);
    store().addThought(`Researching "${topic}"…`, 'infer');
  }, 700);
  return () => clearTimeout(t);
}

async function wikiLookup(q) {
  showInfo('wiki', q, 'WIKIPEDIA');
  const done = thinkingAloud(q);
  try {
    const { entry, fromMemory } = await knowledge.research(q);
    done();
    showWiki(entry);
    knowledge.setTopic(entry, 2);
    reply((fromMemory && !navigator.onLine ? REMEMBERED[0] : '') + knowledge.sentences(entry.summary).slice(0, 2).join(' '), { kind: 'wiki' });
    return entry;
  } catch (e) {
    done();
    const msg = navigator.onLine ? e.message : 'Wikipedia needs internet, and I have nothing about that in memory yet.';
    store().merge('info', { status: 'error', text: msg });
    reply(msg);
    return null;
  }
}

// Knowledge questions ("what is India", "why is the sky blue", "explain black holes"):
// research on Wikipedia (or recall it offline), switch to research mode, then either read a
// short answer or — for specific questions, when a language core is online — let the AI
// answer grounded in the article.
async function answerTopic({ topic, complex, search = false }, raw, channel, history, { noBrainFallback = false } = {}) {
  const { backend, docs } = store();
  mind.noteResearch();
  showInfo('wiki', topic, 'WIKIPEDIA');
  const done = thinkingAloud(topic);
  let res = null;
  let error = null;
  try {
    res = await knowledge.research(topic, { search, full: complex });
  } catch (e) {
    error = e;
  }
  done();
  if (res) {
    const { entry, fromMemory } = res;
    showWiki(entry);
    const n = complex ? 3 : 2;
    knowledge.setTopic(entry, n);
    store().addThought(`${fromMemory ? 'Recalled' : 'Learned'}: ${entry.title}.`, 'decide');
    if (complex && backend.ai) {
      return askBrain(raw, { channel, history, reference: { title: entry.title, text: entry.full || entry.summary } });
    }
    const opener = fromMemory ? REMEMBERED[Math.floor(Math.random() * REMEMBERED.length)] : FRESH[Math.floor(Math.random() * FRESH.length)];
    const text = knowledge.sentences(complex && entry.full ? entry.full : entry.summary).slice(0, n).join(' ');
    return reply(`${opener}${text}${complex ? '' : ' Say "explain more" for details.'}`, { kind: 'wiki' });
  }
  store().set({ info: null });
  if (noBrainFallback) return reply(`I searched, but could not find reliable information about ${topic} either.`);
  if (backend.ai) return askBrain(raw, { channel, history });
  if (backend.online && docs.length) return askBrain(raw, { channel, history, docOnly: true });
  if (!navigator.onLine) return reply(`I have not learned about ${topic} yet, and I need internet to research it. Start Ollama for offline answers.`);
  return reply(error?.message || `I searched, but could not find anything about ${topic}.`);
}

// Follow-ups: "explain more", "tell me more", "in simple words" continue the current topic.
async function explainMore(kind, raw, channel, history) {
  const cur = knowledge.topic.current;
  if (!cur) return reply('Explain what? Ask me about something first, for example "what is India".');
  mind.noteResearch();
  const entry = await knowledge.ensureFull(cur);
  knowledge.topic.current = entry;
  showWiki(entry);
  const { backend } = store();
  if (backend.ai) {
    const ask = kind === 'simple'
      ? `Explain ${entry.title} in very simple words, like to a school student, with one everyday example.`
      : `Explain more about ${entry.title}. Go beyond what you already told me, in four or five spoken sentences.`;
    return askBrain(ask, { channel, history, reference: { title: entry.title, text: entry.full || entry.summary } });
  }
  const all = knowledge.sentences(entry.full || entry.summary);
  if (kind === 'simple') {
    // Offline "simple words": the shortest defining sentences.
    const simple = all.slice(0, 4).sort((a, b) => a.length - b.length).slice(0, 2);
    return reply(`In simple words: ${simple.join(' ')}`);
  }
  const next = all.slice(knowledge.topic.spoken, knowledge.topic.spoken + 3);
  if (!next.length) return reply(`That is everything I know about ${entry.title}. Open the article link on the card for the full story.`);
  knowledge.topic.spoken += next.length;
  return reply(next.join(' '), { kind: 'wiki' });
}

// ---------- memory ----------

function record(text) {
  store().set((s) => ({ scans: [...s.scans, { at: Date.now(), text }].slice(-50) }));
  api.patchMemory({ scan: text }).catch(() => {});
}

export async function loadMemory() {
  try {
    const m = await api.getMemory();
    store().set({ mission: m.mission, recordMode: m.recordMode, scans: m.scans || [] });
  } catch { /* backend offline */ }
  try {
    store().set({ docs: await api.listDocs() });
  } catch { /* backend offline */ }
}

// ---------- mode ----------

export function setMode(mode) {
  mind.noteManualMode();
  if (store().mode === mode) return reply(`${MODES[mode].label} protocol is already active.`);
  store().set({ mode });
  if (mode === 'combat') sfx.alert(); else sfx.online();
  reply(MODE_LINES[mode]);
}

export function cycleMode() {
  const order = ['calm', 'combat', 'research'];
  setMode(order[(order.indexOf(store().mode) + 1) % order.length]);
}

// ---------- main router ----------

// "Chitti, what is this?" → "what is this?" (so every command works with the name in front).
const NAME_PREFIX = new RegExp(`^(?:(?:hey|hi|hello|ok|okay|oh|yo)\\s+)?${NAME}[\\s,!.:-]*`, 'i');
// Call-out words and fillers people put in front of a request: "hey what is…", "ok so, scan".
const LEAD_IN = /^(?:hey|hi|hello|ok|okay|oh|yo|oye|so|um+|uh+|hmm+|well|please|excuse me|listen|tell me,)\b[\s,!.:-]*/i;

function stripLeadIn(text) {
  let s = text.trim();
  for (let prev = ''; s !== prev;) {
    prev = s;
    s = s.replace(NAME_PREFIX, '').replace(LEAD_IN, '').trim();
  }
  return s;
}

// Questions about the world (not about Chitti) that are worth researching automatically.
const QUESTION = /^(what|who|whom|whose|where|when|why|how|which|is|are|was|were|can|could|does|do|did|will|would|should|tell me|explain|define|describe)\b|\?$/i;
const FILLER = new Set('what who whom whose where when why how which is are was were can could does do did will would should the a an of to in on for and or it this that there tell me explain define describe about please know does do much many'.split(' '));
function researchable(t) {
  if (!QUESTION.test(t) || /\b(you|your|yourself|u|ur)\b/i.test(t)) return false;
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).some((w) => w.length > 2 && !FILLER.has(w));
}

// A bare topic like "Bermuda Triangle" or "photosynthesis": short, no verbs or pronouns.
const NOT_A_TOPIC = new RegExp('\\b(i|me|my|you|your|we|us|it|this|that|is|am|are|was|were|be|do|does|did|have|has|had|can|will|want|need|like|love|hate|think|feel|go|get|make|let|please|thanks|thank|ok|okay|yes|no|hmm'
  + '|good|great|nice|cool|awesome|wow|bad|job|well|done|sure|sorry|hello|hi|bye|lol|haha|welcome'
  + '|open|close|turn|show|stop|start|play|give|take|put|come|look|wait|run|move|call|send|set|find|keep|bring|check)\\b', 'i');
const isBareTopic = (t) => {
  const words = t.replace(/[?.!]+$/, '').trim().split(/\s+/);
  return words.length >= 1 && words.length <= 4 && /[a-z]{3}/i.test(t) && !NOT_A_TOPIC.test(t);
};

// Language-core answers that mean "I don't know" → research it instead of giving up.
const UNSURE = /\b(i (do not|don'?t) (know|have (any |enough |specific )?(information|info|data|details|knowledge))|i'?m not (sure|aware|familiar)|i am not (sure|aware|familiar)|i (couldn'?t|could not|can'?t|cannot|was unable to) find|no (specific |reliable )?(information|info|data) (about|on)|not (in|within) my (knowledge|database|memory|training)|beyond my knowledge|unable to (find|provide)|knowledge cutoff|i have no (idea|knowledge|information))\b/i;

async function askOrResearch(input, channel, history) {
  const answer = await askBrain(input, { channel, history });
  if (!UNSURE.test(answer || '') || !navigator.onLine) return;
  store().addThought(`I did not know "${input}". Researching it myself.`, 'decide');
  speech.say('Let me look that up.');
  return answerTopic({ topic: input.replace(/\?+$/, ''), complex: true, search: true }, input, channel, history, { noBrainFallback: true });
}

export async function handleInput(raw, channel = 'keyboard') {
  const text = raw.trim();
  if (!text) return;
  const s = store();
  const history = historyForBrain();
  s.addMessage({ role: 'user', text, channel });
  mind.noteUserActivity();
  sfx.click();

  const input = stripLeadIn(text) || text; // a bare "hey" / "hello chitti" stays a greeting

  // A sensitive action is waiting for yes/no: nothing else runs until it is answered.
  if (agent.hasPendingConfirmation()) {
    if (agent.YES.test(input)) return agent.answerConfirmation(true);
    if (agent.NO.test(input)) return agent.answerConfirmation(false);
    return reply('Please answer yes or no first.');
  }
  // "open the second one" after a list of files.
  const choice = agent.pickChoice(input);
  if (choice) {
    const action = s.session.pendingAction || 'open';
    store().merge('session', { pendingChoice: null });
    const tool = { open: 'open_file', delete: 'delete_path', read: 'read_file' }[action];
    return agent.runSteps([{ tool, args: { path: choice }, category: 'FILES' }], { text: input, channel });
  }

  const cmd = parse(input);
  if (!cmd) {
    const fu = knowledge.followUp(input);
    if (fu && knowledge.topic.current) return explainMore(fu.kind, input, channel, history);
    // Tools: apps, system, screen, files, maps, location, web, maths (deterministic, no model call).
    const routed = route(input);
    if (routed) return agent.runSteps(routed.steps, { text: input, channel });
    const local = mind.reply(input, { aiAvailable: s.backend.ai });
    if (local) {
      reply(local);
      // Introduced yourself while on camera? Remember the face too.
      const name = input.match(/\b(?:my name is|call me|i am called)\s+([a-z][a-z.' -]{0,30})$/i)?.[1];
      if (name && vision.engine?.faces.length) learnFace(mind.memory.userName || name.trim());
      return;
    }
    const k = mind.knowledgeTopic(input);
    if (k) return answerTopic(k, input, channel, history);
    if (fu) return explainMore(fu.kind, input, channel, history);
    if (s.backend.ai && mind.isSmallTalk(input)) return askBrain(input, { channel, history });
    // Puzzles, maths word problems, riddles: think, don't look it up.
    if (mind.isReasoning(input)) {
      if (s.backend.ai) {
        store().addThought('Reasoning problem detected. Thinking it through.', 'infer');
        return askBrain(input, { channel, history, reasoning: true });
      }
      return reply('That needs real reasoning, and my thinking core is offline. Start Ollama, or add an Anthropic key, and ask me again.');
    }
    // An action request the router didn't recognise: let the local model plan tool steps.
    if (s.backend.provider === 'ollama' && !QUESTION.test(input) && looksActionable(input)) {
      if (await agent.planAndRun(input, { channel })) return;
    }
    // Doesn't know? Research it automatically.
    if (researchable(input) && (navigator.onLine || knowledge.recall(input))) {
      return answerTopic({ topic: input.replace(/\?+$/, ''), complex: true, search: true }, input, channel, history);
    }
    if (isBareTopic(input) && (navigator.onLine || knowledge.recall(input))) {
      return answerTopic({ topic: input.replace(/[?.!]+$/, ''), complex: false }, input, channel, history);
    }
    // Ask the language core; if it admits it doesn't know, research and answer again.
    if (s.backend.ai) return askOrResearch(input, channel, history);
    if (s.backend.online && s.docs.length) return askBrain(input, { channel, history, docOnly: true });
    if (navigator.onLine && input.split(/\s+/).length <= 8) {
      return answerTopic({ topic: input.replace(/[?.!]+$/, ''), complex: false, search: true }, input, channel, history);
    }
    return reply(mind.offlineFallback());
  }

  switch (cmd.intent) {
    case 'help':
      store().addMessage({ role: 'chitti', kind: 'help', text: 'Here is what I can do.', help: HELP });
      return speech.say('Here is what I can do. The full list is on your screen.');
    case 'hush':
      return interrupt();
    case 'mute':
      store().merge('voice', { muted: cmd.on });
      if (cmd.on) speech.stop();
      return reply(cmd.on ? 'Voice output muted.' : 'Voice output restored.');
    case 'wake':
      store().setSetting({ wakeWord: cmd.on });
      return reply(cmd.on ? 'Wake word enabled. Start commands with "Chitti".' : 'Wake word disabled. I am listening to everything.');
    case 'settings':
      store().set({ settingsOpen: true });
      return reply('Opening settings.', { speak: false });
    case 'thinking':
      store().setSetting({ thinking: cmd.on });
      return reply(cmd.on ? 'Self-thinking enabled. I will share my observations.' : 'Self-thinking paused. I will only speak when spoken to.');
    case 'upload':
      pickFile();
      return reply('Opening file interface. Choose a document.');
    case 'docQuestion':
      return docQuestion(cmd.q, channel);
    case 'wiki':
      return wikiLookup(cmd.q);
    case 'visionOn':
      return startVision();
    case 'visionOff':
      return stopVision();
    case 'analyze':
      return analyzeScene(cmd.q, channel, history);
    case 'identify':
      return identify();
    case 'color':
      return identify({ colorOnly: true });
    case 'learn':
      return learnObject(cmd.label.replace(/[.!?]+$/, '').replace(/^(my|the|a|an|your)\s+/i, '').toLowerCase());
    case 'forgetObject': {
      const gone = forgetLearned(cmd.label.replace(/^my\s+/, ''));
      return reply(gone ? `Forgotten: ${gone}.` : `I have not learned anything called ${cmd.label}.`);
    }
    case 'learnedList': {
      const objs = learnedLabels('object');
      const faces = learnedLabels('face');
      if (!objs.length && !faces.length) return reply('I have not learned anything yet. Hold something up and say "learn this as" and its name, or tell me your name.');
      return reply([objs.length && `Objects: ${objs.join(', ')}.`, faces.length && `People: ${faces.join(', ')}.`].filter(Boolean).join(' '));
    }
    case 'scan': {
      const sum = sceneSummary();
      document.querySelector('.stage')?.classList.add('scanning');
      setTimeout(() => document.querySelector('.stage')?.classList.remove('scanning'), 1600);
      if (s.recordMode) record(`${new Date().toLocaleTimeString()} — ${sum}`);
      return reply(sum);
    }
    case 'lock':
      return lockTarget(cmd.cls);
    case 'release':
      store().set({ lockId: null });
      return reply('Target released.');
    case 'mode':
      return setMode(cmd.mode);
    case 'autoMode':
      store().setSetting({ autoMode: cmd.on });
      return reply(cmd.on ? 'Automatic mode switching enabled. I will choose the right protocol myself.' : 'Automatic mode switching disabled.');
    case 'record':
      store().set({ recordMode: cmd.on });
      api.patchMemory({ recordMode: cmd.on }).catch(() => {});
      return reply(cmd.on ? 'Record mode enabled. I will remember every scan.' : 'Record mode disabled.');
    case 'recall': {
      const scans = store().scans;
      if (!scans.length) return reply('No scan records stored.');
      store().addMessage({ role: 'chitti', kind: 'records', text: scans.slice(-10).map((x) => `• ${x.text}`).join('\n') });
      return speech.say(`Recalling ${scans.length} scan events. The latest ones are on screen.`);
    }
    case 'clearRecords':
      store().set({ scans: [] });
      api.patchMemory({ clearScans: true }).catch(() => {});
      return reply('Scan memory erased.');
    case 'missionSet': {
      const m = cmd.text?.trim() || 'unlabelled mission';
      store().set({ mission: m });
      api.patchMemory({ mission: m }).catch(() => {});
      store().addThought(`Mission accepted: ${m}. Watching for it.`, 'decide');
      return reply(`Mission recorded: ${m}. I will alert you when I spot it.`);
    }
    case 'missionStatus':
      return reply(s.mission ? `Active mission: ${s.mission}.` : 'No mission assigned.');
    case 'missionClear':
      store().set({ mission: null });
      api.patchMemory({ mission: null }).catch(() => {});
      return reply('All missions cleared.');
    case 'threat':
      return reply(`Current threat level is ${s.threat}.${s.vision.status !== 'live' ? ' Note: vision is offline.' : ''}`);
    case 'battery': {
      const b = s.battery;
      if (b.level == null) return reply('Battery status is not available in this browser.');
      return reply(`Battery at ${Math.round(b.level * 100)} percent, ${b.charging ? 'charging' : 'discharging'}.`);
    }
    case 'diagnostics': {
      const b = s.battery.level == null ? 'unknown' : `${Math.round(s.battery.level * 100)} percent`;
      const brain = s.backend.provider === 'claude' ? 'Claude online' : s.backend.provider === 'ollama' ? `local model ${s.backend.model} online` : 'offline mind only';
      const lines = [
        `Vision ${s.vision.status === 'live' ? `online at ${s.vision.fps} frames per second with ${s.tracks.length} active targets` : 'offline'}.`,
        `Recognition model ${s.vision.classifier}. ${s.learned.length} learned objects.`,
        `Language core: ${brain}. Server ${s.backend.online ? 'online' : 'offline'}.`,
        `Voice ${s.voice.stt ? (s.voice.micOn ? `listening${s.voice.local ? ' on-device' : ''}` : 'standby') : 'unsupported'}.`,
        `Battery ${b}. Mode ${s.mode}${s.lowPower ? ', low power' : ''}. ${s.docs.length} documents in memory.`,
      ];
      return reply(lines.join(' '));
    }
    case 'announce':
      store().setSetting({ callouts: cmd.on });
      return reply(cmd.on ? 'Target callouts enabled.' : 'Target callouts silenced.');
    case 'clearChat':
      store().set({ messages: [] });
      return;
    case 'history': {
      const said = store().messages.filter((m) => m.role === 'user').slice(-4, -1).map((m) => m.text);
      return reply(said.length ? `You recently said: ${said.join('. ')}.` : 'No conversation history yet.');
    }
    default:
      return askBrain(text, { channel, history });
  }
}
