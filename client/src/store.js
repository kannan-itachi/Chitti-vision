import { create } from 'zustand';

let seq = 0;
export const nid = () => `${Date.now().toString(36)}-${++seq}`;

export const MODES = {
  calm: { label: 'CALM', sub: 'GOOD CHIP' },
  combat: { label: 'COMBAT', sub: 'RED CHIP' },
  research: { label: 'RESEARCH', sub: 'ANALYSIS' },
};

// Per-viewer preferences, kept in localStorage.
const SETTINGS_KEY = 'chitti.settings.v2';
export const DEFAULT_SETTINGS = {
  voiceURI: '', // '' = auto (natural online voice, offline Windows voice as fallback)
  volume: 1,
  rate: 1,
  pitch: 0.88, // a touch lower than default: Chitti's calm, confident tone
  wakeWord: false,
  lang: 'en-US',
  offlineSpeech: true, // use on-device recognition when the browser offers it
  detectQuality: 'accurate', // accurate = SSD MobileNet v2, fast = SSDLite
  smartIdentify: true, // second-opinion classifier (1000 classes) + learned objects
  callouts: true,
  thinking: true, // autonomous thought loop
  autoMode: true, // switch calm / research / combat automatically
  speakThoughts: true, // say important thoughts out loud
  sfx: true,
};

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    // Migrate v1 preferences, but reset the voice so the new natural-voice defaults apply.
    const { voiceURI, pitch, rate, ...rest } = JSON.parse(localStorage.getItem('chitti.settings.v1') || '{}');
    return { ...DEFAULT_SETTINGS, ...rest };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const useStore = create((set, get) => ({
  phase: 'standby', // standby → booting → online
  mode: 'calm',
  lowPower: false,
  settings: loadSettings(),
  settingsOpen: false,
  collapsed: (() => { try { return JSON.parse(localStorage.getItem('chitti.collapsed') || '{}'); } catch { return {}; } })(),

  vision: { status: 'off', fps: 0, error: null, model: null, classifier: 'off' }, // classifier: off | loading | ready | error
  tracks: [], // throttled snapshot for panels (the canvas reads the live tracker directly)
  lockId: null,
  threat: 'low',
  focus: null, // { labels:[{label,prob}], learned:{label,sim}|null, person:{name,sim,face}|null, color, at }
  faces: [], // [{ name, sim, score }]
  hazards: [], // confirmed dangerous objects: [{ name, kind, side, source, nearPerson }]
  scene: { motion: 0, motionSide: null, brightness: null },
  learned: [], // [{ label, count }]

  voice: { stt: false, tts: false, micOn: false, listening: false, speaking: false, interim: '', muted: false, local: false, voices: [] },
  brain: 'idle', // idle | thinking | streaming
  thoughts: [], // [{ id, at, text, level }]

  messages: [],
  docs: [],
  activeDocId: null,
  upload: null,
  info: null,
  toasts: [],

  backend: { online: false, ai: false, provider: 'none', model: null, vision: false, reason: null },

  // Tool/agent layer (session only, never persisted)
  task: null, // { id, text, status, steps: [{ tool, label, status, say, error }] }
  confirm: null, // { prompt } while waiting for the user's yes/no
  session: { location: null, destination: null, task: null, notes: [], last: null, pendingChoice: null },
  visionHooks: null, // { describe, identify } registered by actions.js
  mission: null,
  recordMode: false,
  scans: [],
  battery: { level: null, charging: null },

  set: (patch) => set(typeof patch === 'function' ? patch(get()) : patch),
  merge: (key, obj) => set((s) => ({ [key]: { ...s[key], ...obj } })),

  setSetting: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  },

  addMessage: (m) => {
    const msg = { id: nid(), at: Date.now(), text: '', ...m };
    set((s) => ({ messages: [...s.messages.slice(-120), msg] }));
    return msg.id;
  },
  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)),
    })),

  addThought: (text, level = 'observe') =>
    set((s) => ({ thoughts: [...s.thoughts.slice(-60), { id: nid(), at: Date.now(), text, level }] })),

  toast: (text, level = 'info') => {
    const id = nid();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, level }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
  },
}));

export const store = () => useStore.getState();
