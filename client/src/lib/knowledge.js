// Chitti's knowledge core: researches what it doesn't know (Wikipedia), remembers what it
// learned in this browser (so it can answer again offline), and keeps track of the current
// topic so follow-ups like "explain more" or "in simple words" continue the conversation.
import * as api from './api';

const KEY = 'chitti.knowledge.v1';
const MAX = 250;

const kb = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
})();
const save = () => {
  const keys = Object.keys(kb);
  if (keys.length > MAX) keys.sort((a, b) => kb[a].at - kb[b].at).slice(0, keys.length - MAX).forEach((k) => delete kb[k]);
  try { localStorage.setItem(KEY, JSON.stringify(kb)); } catch { /* storage full */ }
};

const norm = (q) => q.toLowerCase().replace(/[?!.,]/g, '').replace(/^(a|an|the)\s+/, '').replace(/\s+/g, ' ').trim();

export const topic = { current: null, spoken: 0 }; // entry + how many sentences of `full` were already read out

export const knownCount = () => Object.keys(kb).length;

export function sentences(text) {
  const clean = (text || '').replace(/\s*\([^()]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  return clean.match(/[^.!?]+[.!?]+(?=\s|$)/g)?.map((s) => s.trim()) || (clean ? [clean] : []);
}

// Something Chitti already learned about this query (exact key, or an article title match).
export function recall(q) {
  const k = norm(q);
  if (kb[k]) return kb[k];
  return Object.values(kb).find((e) => e.title.toLowerCase() === k || e.aliases?.includes(k)) || null;
}

function store(q, hit) {
  const k = norm(q);
  const prev = Object.values(kb).find((e) => e.title === hit.title);
  const entry = {
    ...(prev || {}),
    title: hit.title, description: hit.description, summary: hit.extract, full: hit.full || prev?.full || null,
    image: hit.image, url: hit.url, at: Date.now(), aliases: [...new Set([...(prev?.aliases || []), k])],
  };
  kb[norm(hit.title)] = entry;
  if (k !== norm(hit.title)) kb[k] = entry;
  save();
  return entry;
}

// Look something up: memory first when offline, otherwise fresh from Wikipedia.
export async function research(q, { full = false, search = false } = {}) {
  const cached = recall(q);
  if (cached && (!full || cached.full) && (!navigator.onLine || Date.now() - cached.at < 7 * 86400e3)) {
    return { entry: cached, fromMemory: true };
  }
  try {
    const hit = await api.wiki(q, { full, search });
    return { entry: store(q, hit), fromMemory: false };
  } catch (e) {
    if (cached) return { entry: cached, fromMemory: true };
    throw e;
  }
}

// Make sure the current topic has its full introduction loaded (for "explain more").
export async function ensureFull(entry) {
  if (entry.full) return entry;
  try {
    const { entry: e } = await research(entry.title, { full: true });
    return e;
  } catch {
    return entry;
  }
}

export function setTopic(entry, spoken = 2) {
  topic.current = entry;
  topic.spoken = spoken;
}

// One-line description for "what is this?" answers; never blocks for long.
export async function describe(label, timeoutMs = 1800) {
  const cached = recall(label);
  if (cached) return cached;
  if (!navigator.onLine) return null;
  try {
    const r = await Promise.race([research(label), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), timeoutMs))]);
    return r.entry;
  } catch {
    return null;
  }
}

// ---------- understanding follow-ups ----------

// "explain", "tell me more", "explain it", "what does that mean", "in simple words"…
export function followUp(text) {
  const t = text.toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim()
    .replace(/^(ok|okay|so|then|and|please|chitti)[, ]+/, '').replace(/\s+please$/, '');
  if (/^(explain|explain (it|that|this|more|me|to me|again|in detail|more about (it|that|this))|explain (it|that|this) (to me|more|in detail|again)|tell me more|tell me more about (it|that|this)|more|more details?|more info(rmation)?|go on|continue|elaborate|what else|details|keep going|and then|explain me|(can|could) you explain( it| that| this| more)?)$/.test(t)) {
    return { kind: 'more' };
  }
  if (/^(what does (it|that|this) mean|i don'?t understand|in simple (words|terms|language)|explain (it |that |this )?(simply|in simple (words|terms))|simplify( it| that)?|make it simple|eli5|explain like i'?m (five|5|a kid))$/.test(t)) {
    return { kind: 'simple' };
  }
  if (/^(why|how|when|where|who)\s*\??$/.test(t)) return { kind: 'more' };
  return null;
}
