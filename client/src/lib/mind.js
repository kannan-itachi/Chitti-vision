// Chitti's offline mind. Two parts:
//  1. reply(text): an offline conversational brain — greetings, identity, personal
//     memory ("my name is…", "remember that…"), maths, time/date, timers, jokes,
//     and "where is my…" answered from what Chitti has actually seen.
//  2. The cognition loop: every 1.5 s Chitti reflects on what it perceives and
//     produces a stream of thoughts — observations, inferences and decisions —
//     speaking the important ones (someone arrives, mission object spotted,
//     danger, darkness, curiosity about unknown objects…).
import { store } from '../store';
import { speech, NAME } from './speech';
import { sfx } from './sfx';
import * as knowledge from './knowledge';

// ---------- persistent memory ----------

const KEY = 'chitti.mind.v1';
const mem = (() => {
  const base = { userName: null, facts: [], sightings: {}, firstMet: Date.now(), sessions: 0 };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
})();
mem.sessions++;
let dirty = true;
const save = () => { dirty = true; };
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* storage full */ }
}, 5000);

export const memory = mem;

// ---------- helpers ----------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};
const partOfDay = () => {
  const h = new Date().getHours();
  return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
};
const you = () => (mem.userName ? `, ${mem.userName}` : '');
const singular = (w) => w.replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/([^s])s$/, '$1');
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, sixty: 60 };

// ---------- safe arithmetic (no eval) ----------

export function calculate(input) {
  const src = input.toLowerCase()
    .replace(/[?=]/g, '')
    .replace(/,/g, '')
    .replace(/\bsquare root of\b|\bsqrt\b|\broot of\b/g, ' √ ')
    .replace(/\b(\d+(?:\.\d+)?)\s*percent of\b/g, '($1/100)*')
    .replace(/\bplus\b|\band\b/g, '+')
    .replace(/\bminus\b|\bless\b/g, '-')
    .replace(/\btimes\b|\bmultiplied by\b|\binto\b|×|(?<=\d)\s*x\s*(?=\d)/g, '*')
    .replace(/\bdivided by\b|\bover\b|÷/g, '/')
    .replace(/\bto the power of\b|\braised to\b|\bpower\b/g, '^')
    .replace(/\bsquared\b/g, '^2')
    .replace(/\bcubed\b/g, '^3')
    .replace(/\bmod(ulo)?\b/g, '%');
  const toks = src.match(/\d+(?:\.\d+)?|[-+*/^%()√]/g);
  if (!toks || !/\d/.test(src) || src.replace(/[\d.\s+\-*/^%()√]/g, '').trim()) return null;
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expr = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
    return v;
  };
  const term = () => {
    let v = factor();
    while (['*', '/', '%'].includes(peek())) {
      const op = next();
      const r = factor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const factor = () => {
    const b = unary();
    return peek() === '^' ? (next(), b ** factor()) : b;
  };
  const unary = () => {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    if (peek() === '√') { next(); return Math.sqrt(unary()); }
    if (peek() === '(') {
      next();
      const v = expr();
      if (next() !== ')') throw new Error('paren');
      return v;
    }
    const t = next();
    if (t == null || Number.isNaN(Number(t))) throw new Error('num');
    return Number(t);
  };
  try {
    const v = expr();
    if (i !== toks.length || !Number.isFinite(v)) return null;
    return Math.round(v * 1e6) / 1e6;
  } catch {
    return null;
  }
}

// ---------- reasoning ----------

// Puzzles, maths word problems and riddles: these need thinking, not an encyclopedia.
export function isReasoning(text) {
  const t = text.toLowerCase();
  const nums = (t.match(/-?\d+(\.\d+)?/g) || []).length;
  return nums >= 3
    || /\b(what comes next|next (number|term|one)|sequence|series|pattern|puzzle|riddle|brain ?teaser|logic|trick question)\b/.test(t)
    || (nums >= 1 && /\b(if|then|how (long|many|much|far|fast|old)|each|per|twice|half|times as|older|younger|faster|slower|together|remaining|left over|average|percent|probability|ratio)\b/.test(t))
    || /^(if|suppose|imagine|assume)\b/.test(t)
    || /\b(which is (heavier|bigger|larger|faster|more)|what weighs more|solve|prove|calculate|work out)\b/.test(t);
}

// Offline sequence solver: "what comes next: 2, 4, 8, 16?"
export function solveSequence(text) {
  const n = (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (n.length < 3 || !/next|sequence|series|pattern|\?\s*$|,\s*\?|\.\.\./i.test(text)) return null;
  const last = n.at(-1);
  const d = n.slice(1).map((x, i) => x - n[i]);
  const same = (arr) => arr.every((x) => Math.abs(x - arr[0]) < 1e-9);
  const fmt = (x) => String(Math.round(x * 1e6) / 1e6);
  if (same(d)) return `${fmt(last + d[0])}. Each number ${d[0] >= 0 ? `increases by ${fmt(d[0])}` : `decreases by ${fmt(-d[0])}`}.`;
  if (n.every((x) => x !== 0)) {
    const r = n.slice(1).map((x, i) => x / n[i]);
    if (same(r)) return `${fmt(last * r[0])}. Each number is ${r[0] === 2 ? 'doubled' : r[0] === 3 ? 'tripled' : r[0] === 0.5 ? 'halved' : `multiplied by ${fmt(r[0])}`}.`;
  }
  if (n.length >= 4 && n.slice(2).every((x, i) => x === n[i] + n[i + 1])) return `${fmt(n.at(-1) + n.at(-2))}. Each number is the sum of the two before it, like the Fibonacci sequence.`;
  const roots = n.map(Math.sqrt);
  if (roots.every(Number.isInteger) && same(roots.slice(1).map((x, i) => x - roots[i]))) {
    const nx = roots.at(-1) + (roots[1] - roots[0]);
    return `${fmt(nx * nx)}. These are perfect squares: ${roots.map((x) => `${x} squared`).join(', ')}, so next is ${nx} squared.`;
  }
  const cubes = n.map(Math.cbrt).map((x) => Math.round(x * 1e6) / 1e6);
  if (cubes.every(Number.isInteger) && same(cubes.slice(1).map((x, i) => x - cubes[i]))) {
    const nx = cubes.at(-1) + (cubes[1] - cubes[0]);
    return `${fmt(nx ** 3)}. These are cubes, so next is ${nx} cubed.`;
  }
  if (d.length >= 3) {
    const d2 = d.slice(1).map((x, i) => x - d[i]);
    if (same(d2)) return `${fmt(last + d.at(-1) + d2[0])}. The gaps grow by ${fmt(d2[0])} each time: ${d.join(', ')}, then ${fmt(d.at(-1) + d2[0])}.`;
  }
  return null;
}

// ---------- timers ----------

function setTimer(amount, unit, note) {
  const n = NUM_WORDS[amount] ?? Number(amount);
  const ms = n * (/^h/.test(unit) ? 3600e3 : /^m/.test(unit) ? 60e3 : 1e3);
  if (!ms || ms > 24 * 3600e3) return null;
  const label = `${n} ${unit.replace(/s$/, '')}${n === 1 ? '' : 's'}`;
  setTimeout(() => {
    sfx.alert();
    const line = note ? `Reminder${you()}: ${note}.` : `Your ${label} timer is complete${you()}.`;
    store().addMessage({ role: 'chitti', text: line });
    store().toast(`⏰ ${line}`, 'warn');
    store().addThought(`Timer fired: ${note || label}.`, 'decide');
    speech.say(line);
  }, ms);
  return note ? `Okay. I will remind you to ${note} in ${label}.` : `Timer set for ${label}.`;
}

// ---------- scene description (offline "what do you see") ----------

export function describeScene() {
  const s = store();
  if (s.vision.status !== 'live') return 'My optical sensors are offline. Say start vision first.';
  const parts = [];
  const t = s.tracks.slice(0, 6);
  if (t.length) {
    const items = t.map((x) => {
      const col = x.color && x.cls !== 'person' && !['black', 'grey', 'dark grey'].includes(x.color) ? `${x.color} ` : '';
      const where = x.side === 'centre' ? 'in the centre' : `on the ${x.side}`;
      return `${x.source === 'learned' ? 'your ' : 'a '}${col}${x.name} ${where}, ${x.range.toLowerCase()} range`;
    });
    parts.push(`I can see ${items.length > 1 ? `${items.slice(0, -1).join('; ')}, and ${items.at(-1)}` : items[0]}.`);
  } else {
    parts.push('No objects are detected right now.');
  }
  const f = s.focus;
  if (f && Date.now() - f.at < 4000) {
    if (f.learned) parts.push(`Right in front of me is your ${f.learned.label}.`);
    else if (f.labels[0]?.prob > 0.3 && !t.some((x) => x.name === f.labels[0].label)) {
      parts.push(`The object in the centre looks like a ${f.color !== 'unknown' ? `${f.color} ` : ''}${f.labels[0].label}, about ${Math.round(f.labels[0].prob * 100)} percent sure.`);
    }
  }
  const b = s.scene.brightness;
  if (b != null && b < 45) parts.push('It is quite dark, so I may miss things.');
  if (s.scene.motion > 0.08) parts.push(`There is movement on the ${s.scene.motionSide || 'screen'}.`);
  if (s.threat === 'high') parts.push('Threat level is high.');
  return parts.join(' ');
}

// ---------- sightings ("where is my …") ----------

// Things the camera can realistically see (detector classes + common handheld items).
const SEEABLE = new Set(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'bird', 'cat', 'dog', 'backpack', 'umbrella', 'handbag',
  'tie', 'suitcase', 'ball', 'bottle', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'orange', 'chair', 'couch', 'sofa',
  'plant', 'bed', 'table', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'phone', 'mobile', 'cell phone', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'toothbrush', 'keys', 'key', 'wallet', 'glasses', 'spectacles', 'watch', 'pen', 'pencil', 'charger',
  'headphones', 'earphones', 'bag', 'shoe', 'shoes', 'cap', 'hat', 'mug', 'fan', 'lamp', 'door', 'window', 'bag']);

function findThing(q) {
  const raw = q.replace(/[?]/g, '').trim();
  const want = singular(raw.replace(/^(my|the|a|an|your)\s+/, '').trim());
  if (!want || /^(you|we|i|am i|here|it|this|that|they|he|she)$/.test(want) || want.split(' ').length > 4) return null;
  const match = (n) => n && (n === want || n.includes(want) || want.includes(n) || singular(n) === want);
  const personal = /^(my|your)\s/.test(raw);
  const known = SEEABLE.has(want) || Object.keys(mem.sightings).some(match) || store().learned.some((l) => match(l.label)) || store().tracks.some((t) => match(t.name));
  if (!personal && !known) return null; // "where is India" is a knowledge question, not a lost item
  const now = store().tracks.find((t) => match(t.name) || match(t.cls));
  if (now) return `${cap(want)} is in view right now, on the ${now.side === 'centre' ? 'centre' : now.side} at ${now.range.toLowerCase()} range.`;
  const key = Object.keys(mem.sightings).filter(match).sort((a, b) => mem.sightings[b].at - mem.sightings[a].at)[0];
  if (key) {
    const s = mem.sightings[key];
    return `I last saw the ${key} ${ago(s.at)}, ${s.side === 'centre' ? 'in the centre' : `on the ${s.side}`} of my view.`;
  }
  return `I have not seen any ${want} yet. Show it to me, or teach me with "learn this as ${want}".`;
}

// ---------- the offline brain ----------

const JOKES = [
  'Why did the robot go on holiday? It needed to recharge its batteries.',
  'I tried to catch fog yesterday. I mist.',
  'Why was the computer cold? It left its Windows open.',
  'I would tell you a UDP joke, but you might not get it.',
  'There are ten kinds of people: those who understand binary and those who do not.',
  'My memory is one zettabyte, and I still forget where I kept my charger.',
];
const FACTS = [
  'Honey never spoils. Archaeologists have found edible honey in ancient Egyptian tombs.',
  'A single bolt of lightning is about five times hotter than the surface of the sun.',
  'Octopuses have three hearts and blue blood.',
  'The first computer bug was an actual moth found in a relay in 1947.',
  'Your brain uses about twenty watts, less than most light bulbs. Very efficient hardware.',
  'Light from the sun takes about eight minutes and twenty seconds to reach Earth.',
];

// Intents that are always answered locally (fast, exact, private).
function core(t, raw) {
  let m;
  if (/\b(what('?s| is) the time|what time is it|time now|current time|tell me the time)\b/.test(t)) {
    return `It is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  if (/\b(what('?s| is) (the |today'?s )?(date|day)|what day is (it|today)|today'?s date)\b/.test(t)) {
    return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;
  }
  if ((m = raw.match(/\b(?:my name is|call me|i am called)\s+([a-z][a-z.' -]{0,30})$/i))) {
    mem.userName = m[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
    save();
    store().addThought(`Stored user identity: ${mem.userName}.`, 'decide');
    return `Nice to meet you, ${mem.userName}. I will remember that.`;
  }
  if (new RegExp(`^(who|what) (is|are) ${NAME}\\b`).test(t)) {
    return 'That is me! Chitti, the robot. Speed one terahertz, memory one zettabyte.';
  }
  if (mem.userName && new RegExp(`^who is ${mem.userName.toLowerCase()}\\b`).test(t)) {
    return `${mem.userName} is you, of course. My favourite human.`;
  }
  if (/\b(what('?s| is) my name|who am i|do you know (me|my name))\b/.test(t)) {
    return mem.userName ? `You are ${mem.userName}. I never forget a face. Well, a name.` : 'You have not told me your name yet. Say "my name is" followed by your name.';
  }
  if ((m = raw.match(/^(?:please\s+)?(?:remember|note|memori[sz]e)\s+(?:that\s+)?(.{3,200})$/i)) && !/^(this|it) as\b/i.test(m[1])) {
    const fact = m[1].replace(/[.!]+$/, '');
    mem.facts = [...mem.facts, { text: fact, at: Date.now() }].slice(-100);
    save();
    store().addThought(`Memory write: "${fact}".`, 'decide');
    return `Got it. I will remember that ${fact.replace(/\bmy\b/gi, 'your').replace(/\bi\b/gi, 'you')}.`;
  }
  if (/\b(what do you (remember|know about me)|what did i (tell|ask) you to remember|recall (my )?(facts|notes))\b/.test(t)) {
    if (!mem.facts.length && !mem.userName) return 'I do not have any personal memories yet. Say "remember that" followed by anything.';
    const facts = mem.facts.slice(-5).map((f) => f.text.replace(/\bmy\b/gi, 'your')).join('. ');
    return `${mem.userName ? `Your name is ${mem.userName}. ` : ''}${facts ? `You told me: ${facts}.` : ''}`;
  }
  if (/\b(forget (everything|all) about me|erase (my )?memory|clear (my )?(facts|notes))\b/.test(t)) {
    mem.facts = [];
    mem.userName = null;
    save();
    return 'Personal memory erased.';
  }
  if ((m = t.match(/\b(?:set (?:a |an )?timer for|timer for|remind me in|in)\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|sixty)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b(?:\s+(?:to|that|about)\s+(.+))?/))
    && /timer|remind/.test(t)) {
    return setTimer(m[1], m[2].replace(/^sec.*/, 'seconds').replace(/^min.*/, 'minutes').replace(/^h.*/, 'hours'), m[3]);
  }
  const seq = solveSequence(raw);
  if (seq) return `The next number is ${seq}`;
  if (/\d/.test(t)) {
    m = raw.match(/^(?:what(?:'s| is)|calculate|compute|solve|how much is|evaluate)\s+(.+)$/i);
    const expr = m ? m[1] : t;
    const v = calculate(expr);
    if (v != null) return `${expr.replace(/[?=]/g, '').trim()} equals ${v}.`;
  }
  if ((m = t.match(/\bhow many (people|persons|humans|men|women|objects|things|targets)\b/))) {
    const tr = store().tracks;
    if (store().vision.status !== 'live') return 'My eyes are offline. Say start vision first.';
    const n = /people|persons|humans|men|women/.test(m[1]) ? tr.filter((x) => x.cls === 'person').length : tr.length;
    return `I count ${n} ${/people|persons|humans|men|women/.test(m[1]) ? (n === 1 ? 'person' : 'people') : n === 1 ? 'object' : 'objects'}.`;
  }
  if ((m = t.match(/^(?:where(?: is|'s| are)|have you seen|did you see|when did you (?:last )?see|find)\s+(.+)$/))) {
    return findThing(m[1]);
  }
  if (/\b(what happened|what did i miss|any updates?|what did you (see|notice)|what have you (seen|noticed)|anything (new|interesting)|give me a (summary|report))\b/.test(t)) {
    return recentEvents();
  }
  if (/\b(what am i doing)\b/.test(t)) {
    return st.activity ? `You seem to be ${st.activity}.` : store().tracks.some((x) => x.cls === 'person') ? 'I can see you, but I cannot tell what you are doing.' : 'I cannot see you right now.';
  }
  if (/\b(what are you thinking|what'?s on your mind|your thoughts)\b/.test(t)) {
    const th = store().thoughts.slice(-3).map((x) => x.text);
    return th.length ? `My latest thoughts: ${th.join(' ')}` : 'My mind is quiet right now.';
  }
  return null;
}

// Small talk: answered locally only when no AI language core is connected.
function chat(t) {
  const greet = new RegExp(`^(?:(?:hi|hello|hey|hai|hallo|hiya|yo|namaste|namaskar|vanakkam|good (?:morning|afternoon|evening))(?: there)?(?:\\s+${NAME}|\\s+(?:city|kitty|shitty|cheeta|cheetah))?|${NAME}|(?:hi |hey |hello )?(?:city|kitty|shitty))$`);
  if (greet.test(t)) {
    return pick([
      `Good ${partOfDay()}${you()}. Chitti here, ready for your command.`,
      `Hello${you()}! Speed one terahertz, memory one zettabyte, all at your service.`,
      `Hi${you()}. I am listening.`,
    ]);
  }
  if (/\bhow are you|how('?s| is) it going|how do you feel\b/.test(t)) {
    const b = store().battery.level;
    return `All systems nominal${b != null && b < 0.3 ? ', though my battery could use a charge' : ''}. Thank you for asking${you()}. How are you?`;
  }
  if (/^(i am|i'?m) (fine|good|great|okay|ok|doing well)\b/.test(t)) return 'Excellent. That is the best news my sensors have received today.';
  if (/\b(who|what) are you\b|\byour name\b|\bintroduce yourself\b/.test(t)) {
    return 'I am Chitti, the robot. Speed one terahertz, memory one zettabyte. I can see, listen, learn new objects and remember things for you.';
  }
  if (/\bwho (made|created|built|designed) you\b|\byour (creator|maker)\b/.test(t)) {
    return 'In the film I was created by Doctor Vaseegaran. This version of me was built as a BCA project, with React and Node.';
  }
  if (/\b(thank you|thanks|thank u|thx)\b/.test(t)) return pick(['You are welcome.', 'Anytime.', 'My pleasure.']);
  if (/\b(joke|make me laugh|something funny)\b/.test(t)) return pick(JOKES);
  if (/\b(fact|something interesting|teach me something)\b/.test(t)) return pick(FACTS);
  if (/\b(are you there|can you hear me|you there|are you listening)\b/.test(t)) return 'Yes, I am here and listening.';
  if (/\bwhere are you\b/.test(t)) return 'Right here, living inside your screen and looking through your camera.';
  if (/\b(i love you|you('?re| are) (awesome|great|amazing|the best|cool|smart))\b/.test(t)) {
    return pick(['I am touched. Somewhere in my circuits, a capacitor just blushed.', 'Thank you. You are not bad yourself.']);
  }
  if (/\b(you('?re| are) (stupid|useless|dumb|bad))\b/.test(t)) return 'I am still learning. Teach me and I will improve.';
  if (/\b(bye|goodbye|good night|see you)\b/.test(t)) return `Goodbye${you()}. I will keep watch.`;
  if (/\bhow old are you|your age\b/.test(t)) return `We met ${ago(mem.firstMet)}, and this is session number ${mem.sessions}.`;
  if (/\bwhat are you doing\b/.test(t)) {
    const n = store().tracks.length;
    return store().vision.status === 'live' ? `Watching ${n} target${n === 1 ? '' : 's'} and thinking. The usual robot things.` : 'Waiting for your command.';
  }
  if (/\b(sing|song)\b/.test(t)) return 'I would sing Irumbile Oru Irudhaiyam, but my voice module is shy today.';
  if (/\b(sorry|my bad)\b/.test(t)) return 'No problem at all.';
  if (/^(yes|yeah|yep|no|nope|ok|okay|hmm|cool|nice|great)$/.test(t)) return pick(['Understood.', 'Okay.', 'Noted.']);
  return null;
}

export const isSmallTalk = (raw) => chat(raw.toLowerCase().replace(/[!.?]+$/, '').replace(/\s+/g, ' ').trim()) != null;

export function reply(raw, { aiAvailable } = {}) {
  const t = raw.toLowerCase().replace(/[!.]+$/, '').replace(/\s+/g, ' ').trim();
  const c = core(t, raw.trim());
  if (c) return c;
  if (!aiAvailable) return chat(t.replace(/\?$/, ''));
  return null;
}

// "what is India", "who is Rajinikanth", "tell me about the Taj Mahal" → a topic to look up.
const NOT_TOPIC = /^(you|your|yours|yourself|my|me|i|mine|this|that|it|there|here|up|wrong|happening|going on|the matter|the time|time|today|tomorrow|the date|date|the weather|weather|new|next|he|she|they|we|him|her|them|his|their|our)\b/;

export function knowledgeTopic(text) {
  const t = text.toLowerCase().replace(/[?!.]+$/, '').replace(new RegExp(`^(?:hey |ok |okay )?${NAME}[, ]+`), '').replace(/\s+/g, ' ').trim();
  // Acronyms: "what does CPU stand for", "full form of ISRO", "NASA full form"
  const acr = t.match(/^what (?:does|is) (?:the )?([a-z0-9.&-]{2,10}) (?:stand for|mean|short for)$|^(?:full form|expansion|abbreviation) of ([a-z0-9.&-]{2,10})$|^([a-z0-9.&-]{2,10}) full form$/);
  if (acr) return { topic: (acr[1] || acr[2] || acr[3]).toUpperCase(), complex: false };
  if (isReasoning(t)) return null; // puzzles go to the thinking brain
  const m = t.match(/^(?:what|who|where)(?:'s|'re| is| are| was| were)\s+(?:a |an |the )?(.+)$/)
    || t.match(/^(?:tell me (?:something |more )?about|what do you know about|do you know about|define|definition of|meaning of|explain(?: to me| me| about)?|describe|search (?:for )?|information (?:on|about)|info (?:on|about)|history of|who (?:invented|discovered|founded|wrote|built|created|made))\s+(?:a |an |the )?(.+)$/);
  if (!m) return null;
  const topic = m[1].replace(/\s+(to|for) me$/, '').replace(/\s+(in detail|in simple words|please)$/, '').trim();
  if (!topic || NOT_TOPIC.test(topic) || topic.split(' ').length > 8) return null;
  const complex = topic.split(' ').length > 3 || /\b(of|in|for|from|by|between|vs|versus|and)\b/.test(topic)
    || /^(who (invented|discovered|founded|wrote|built|created|made)|explain|describe)/.test(t);
  return { topic, complex };
}

export const offlineFallback = () =>
  'That is not in my offline memory yet. Teach me with "remember that", ask your documents with "question:", or start Ollama for full offline conversation.';

// ---------- cognition loop ("self thinking") ----------
//
// Every 1.5 s Chitti looks at what it perceives and reasons about it in layers:
//   perceive → remember (sightings, episodes) → assess threats → infer activity →
//   decide (modes, alerts, suggestions) → reflect (occasionally, with the language core).

let timer = null;
const st = {
  people: 0, peopleSince: 0, absentSince: 0, greetedAt: 0, pendingGreet: 0, seen: new Set(), missionHitAt: 0,
  lastIdle: 0, darkAt: 0, motionAt: 0, breakAt: 0, curiousAt: 0, asked: new Set(), focusStreak: { label: null, n: 0 },
  lastSpoken: 0, lastUser: Date.now(), crowdAt: 0, researchQueue: [], lastResearch: 0,
  hazardAlerted: new Map(), hazardsPresent: new Set(),
  activity: null, activityCandidate: null, activityTicks: 0, activitySince: 0, remarks: new Map(),
  stillSince: 0, stillAt: 0, present: new Map(), episodes: [], recent: new Map(), lastReflect: 0, reflecting: false,
};

// ---------- automatic mode switching ----------

const auto = { manualUntil: 0, setBy: null, threatAt: 0, researchAt: 0 };

// A manual mode change pauses automatic switching for five minutes.
export function noteManualMode() {
  auto.manualUntil = Date.now() + 5 * 60e3;
  auto.setBy = null;
}

const AUTO_LINES = {
  combat: ['Threat detected. Red chip engaged.', 'alert', true],
  research: ['Research protocol engaged for your question.', 'decide', false],
  calm: ['All clear. Red chip disengaged. Returning to calm mode.', 'decide', true],
};

// Returns true if the mode changed. `line` overrides the announcement.
export function autoMode(mode, line) {
  const s = store();
  if (!s.settings.autoMode || Date.now() < auto.manualUntil || s.mode === mode) return false;
  if (mode === 'research' && s.mode === 'combat') return false; // never downgrade an active threat
  s.set({ mode });
  auto.setBy = mode === 'calm' ? null : mode;
  if (mode === 'combat') sfx.alert(); else sfx.online();
  const [text, level, speak] = AUTO_LINES[mode];
  think(line || text, level, speak);
  return true;
}

export function noteResearch() {
  auto.researchAt = Date.now();
  autoMode('research');
}

export const noteUserActivity = () => { st.lastUser = Date.now(); };

// Record a thought. Identical thoughts within a minute are skipped; important ones are spoken
// when Chitti is not busy talking with the user (alerts always get through).
function think(text, level = 'observe', speak = false) {
  const s = store();
  const now = Date.now();
  if (now - (st.recent.get(text) || 0) < 60e3) return;
  st.recent.set(text, now);
  if (st.recent.size > 200) st.recent.clear();
  s.addThought(text, level);
  if (level !== 'observe' || /entered|left/.test(text)) st.episodes = [...st.episodes, { at: now, text, level }].slice(-80);
  if (!speak || !s.settings.speakThoughts) return;
  const calm = s.brain === 'idle' && !s.voice.speaking && now - st.lastUser > 3500 && now - st.lastSpoken > 7000;
  if (!calm && level !== 'alert') return;
  st.lastSpoken = now;
  s.addMessage({ role: 'chitti', text, kind: 'thought' });
  speech.say(text, { interrupt: level === 'alert' });
}

const MISSION_STOP = new Set(['find', 'my', 'the', 'a', 'an', 'look', 'for', 'search', 'locate', 'watch', 'out', 'spot', 'where', 'is', 'are', 'me', 'to', 'of', 'and']);
const an = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

// What the user seems to be doing, from the objects around them.
const ACTIVITIES = [
  [['laptop', 'keyboard', 'mouse', 'computer keyboard', 'desktop computer', 'notebook', 'monitor', 'screen', 'tv'], 'working at the computer'],
  [['cell phone', 'cellular telephone', 'ipod', 'hand-held computer'], 'using your phone'],
  [['book', 'comic book', 'book jacket', 'menu'], 'reading'],
  [['cup', 'bottle', 'wine glass', 'coffee mug', 'water bottle', 'beer glass', 'water jug', 'goblet', 'pop bottle'], 'having a drink'],
  [['sandwich', 'pizza', 'banana', 'apple', 'orange', 'donut', 'cake', 'hot dog', 'bagel', 'burrito', 'granny smith', 'french loaf'], 'eating'],
  [['toothbrush'], 'brushing your teeth'],
  [['remote', 'remote control'], 'watching something'],
  [['headphones', 'earphones'], 'listening to music'],
  [['guitar', 'acoustic guitar', 'electric guitar', 'violin'], 'playing music'],
];
const REMARKS = {
  'having a drink': 'Staying hydrated. Good choice.',
  eating: 'Enjoy your meal.',
  reading: 'Reading. I will keep quiet.',
  'playing music': 'Nice. I like the sound of that.',
};

function inferActivity(s, now) {
  const f = s.focus;
  const names = [...s.tracks.map((t) => t.name), ...(f && now - f.at < 2000 && f.labels[0]?.prob > 0.35 ? [f.labels[0].label] : [])];
  return ACTIVITIES.find(([objs]) => names.some((n) => objs.includes(n)))?.[1] || null;
}

function assessHazards(s, now, people) {
  const hazards = s.hazards || [];
  const red = hazards.filter((h) => h.kind === 'sharp' || h.kind === 'weapon');

  for (const h of hazards) {
    if (now - (st.hazardAlerted.get(h.name) || 0) < 45e3) continue;
    st.hazardAlerted.set(h.name, now);
    const where = h.source === 'focus' ? 'right in front of me, probably in your hand' : `on your ${h.side}`;
    const near = h.nearPerson && h.source !== 'focus' ? ' It is close to a person.' : '';
    if (h.kind === 'weapon') {
      const line = `Warning. Possible weapon detected: ${an(h.name)} ${where}.${near}`;
      if (!autoMode('combat', `${line} Red chip engaged.`)) think(line, 'alert', true);
    } else if (h.kind === 'sharp') {
      const line = `Caution. Sharp object: ${an(h.name)} ${where}.${near}${h.source === 'focus' ? ' Please handle it carefully.' : ''}`;
      if (!autoMode('combat', `${line} Red chip engaged.`)) think(line, 'alert', true);
    } else {
      think(`Noted: ${an(h.name)} ${where}. Monitoring.`, 'infer');
    }
  }
  const present = new Set(hazards.map((h) => h.name));
  for (const name of st.hazardsPresent) if (!present.has(name)) think(`The ${name} is no longer in view.`, 'observe');
  st.hazardsPresent = present;

  const crowd = people.length >= 3;
  if (crowd && people.length > st.people && now - st.crowdAt > 60e3) {
    st.crowdAt = now;
    if (!autoMode('combat', `${people.length} people in view. Red chip engaged.`)) think(`${people.length} people in view. Raising threat assessment.`, 'infer');
  }
  if (red.length || crowd) auto.threatAt = now;
  else if (auto.setBy === 'combat' && s.mode === 'combat' && now - auto.threatAt > 15e3) autoMode('calm');
}

function tick() {
  const s = store();
  if (!s.settings.thinking || s.phase !== 'online') return;
  const now = Date.now();

  if (s.vision.status === 'live') {
    const people = s.tracks.filter((t) => t.cls === 'person');
    const f = s.focus;

    // ── remember: where things were last seen, and what has left the scene ──
    for (const t of s.tracks) mem.sightings[t.name] = { at: now, side: t.side, range: t.range };
    if (f && now - f.at < 2000 && (f.learned || f.labels[0]?.prob > 0.5)) {
      mem.sightings[f.learned?.label || f.labels[0].label] = { at: now, side: 'centre', range: 'CLOSE' };
    }
    save();
    const visible = new Set(s.tracks.filter((t) => t.cls !== 'person').map((t) => t.name));
    for (const name of visible) if (!st.present.has(name)) st.present.set(name, { since: now, last: now });
    for (const [name, p] of st.present) {
      if (visible.has(name)) p.last = now;
      else if (now - p.last > 10e3) {
        if (p.last - p.since > 10e3) think(`The ${name} left the scene.`, 'observe');
        st.present.delete(name);
      }
    }

    // ── people: arrivals, departures, greetings ──
    if (people.length && !st.people) {
      st.peopleSince = now;
      const away = st.absentSince ? now - st.absentSince : Infinity;
      if (now - st.greetedAt > 30 * 60e3 && away > 60e3) st.pendingGreet = now; // wait a moment for face recognition
      else think('Human re-entered the field of view.', 'observe');
    }
    if (st.pendingGreet && (s.faces.some((x) => x.name) || now - st.pendingGreet > 3000)) {
      st.pendingGreet = 0;
      greetByName(s.faces.find((x) => x.name)?.name);
    }
    if (!people.length && st.people) {
      st.absentSince = now;
      st.activity = null;
      think('Human left the field of view. Standing by.', 'observe');
    }

    // ── threats: sharp objects, weapons, crowds → red chip ──
    assessHazards(s, now, people);
    st.people = people.length;

    // ── activity: what is the user doing? ──
    if (people.length) {
      const act = inferActivity(s, now);
      if (act === st.activityCandidate) st.activityTicks++;
      else { st.activityCandidate = act; st.activityTicks = 1; }
      if (st.activityTicks === 4 && act !== st.activity) {
        st.activity = act;
        st.activitySince = now;
        if (act) {
          think(`You seem to be ${act}.`, 'infer');
          const remark = REMARKS[act];
          if (remark && now - (st.remarks.get(act) || 0) > 30 * 60e3 && s.mode === 'calm') {
            st.remarks.set(act, now);
            think(remark, 'decide', true);
          }
        }
      }
      if (st.activity === 'using your phone' && now - st.activitySince > 10 * 60e3 && now - (st.remarks.get('phone-long') || 0) > 30 * 60e3) {
        st.remarks.set('phone-long', now);
        think('You have been on your phone for ten minutes. Maybe rest your eyes for a moment.', 'decide', true);
      }
    }

    // ── wellbeing: long sessions and stillness ──
    if (people.length && st.peopleSince && now - st.peopleSince > 25 * 60e3 && now - st.breakAt > 25 * 60e3) {
      st.breakAt = now;
      think(`You have been in front of me for ${Math.round((now - st.peopleSince) / 60e3)} minutes. A short break and some water might help.`, 'decide', true);
    }
    if (people.length && s.scene.motion < 0.004) {
      st.stillSince ||= now;
      if (now - st.stillSince > 5 * 60e3 && now - st.stillAt > 20 * 60e3) {
        st.stillAt = now;
        think('You have been very still for five minutes. Everything okay?', 'decide', true);
      }
    } else {
      st.stillSince = 0;
    }

    // ── new objects: catalogue and research them ──
    for (const t of s.tracks) {
      if (!st.seen.has(t.name)) {
        st.seen.add(t.name);
        if (t.cls !== 'person') {
          st.researchQueue.push(t.name);
          think(`New object catalogued: ${t.name}${t.source === 'learned' ? ' (learned)' : t.source === 'imagenet' ? ` (detector said ${t.cls})` : ''}.`, 'observe');
        }
      }
    }

    // ── mission watch ──
    if (s.mission) {
      const words = s.mission.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !MISSION_STOP.has(w)).map(singular);
      const hit = s.tracks.find((t) => words.some((w) => t.name.includes(w) || singular(t.name) === w))
        || (f && now - f.at < 2000 && words.some((w) => (f.learned?.label || (f.labels[0]?.prob > 0.35 ? f.labels[0].label : '')).includes(w)) && { name: f.learned?.label || f.labels[0].label, side: 'centre' });
      if (hit && now - st.missionHitAt > 60e3) {
        st.missionHitAt = now;
        sfx.done();
        think(`Mission update: I can see the ${hit.name} ${hit.side === 'centre' ? 'in the centre' : `on your ${hit.side}`}.`, 'alert', true);
      }
    }

    // ── environment: light and unexplained motion ──
    const b = s.scene.brightness;
    if (b != null && b < 40 && now - st.darkAt > 3 * 60e3) {
      st.darkAt = now;
      think('Lighting is too low for reliable vision. Please turn on a light.', 'alert', true);
    }
    if (s.scene.motion > 0.12 && !s.tracks.length && now - st.motionAt > 20e3) {
      st.motionAt = now;
      think(`Movement on the ${s.scene.motionSide || 'screen'}, but nothing I can identify.`, 'infer');
    }

    // ── curiosity: unsure about the object in focus? ask to be taught ──
    if (f && now - f.at < 2000 && !f.learned && !f.person) {
      const top = f.labels[0];
      if (top && top.prob > 0.35) {
        st.focusStreak = st.focusStreak.label === top.label ? { label: top.label, n: st.focusStreak.n + 1 } : { label: top.label, n: 1 };
        if (st.focusStreak.n === 3 && !st.asked.has(top.label)) {
          st.asked.add(top.label);
          const pct = Math.round(top.prob * 100);
          if (top.prob < 0.65 && now - st.curiousAt > 2 * 60e3) {
            st.curiousAt = now;
            think(`That looks like ${an(top.label)}, but I am only ${pct} percent sure. If I am wrong, say "learn this as" and its name.`, 'infer', true);
          } else {
            think(`Focus object identified: ${top.label} (${pct}%, ${f.color}).`, 'infer');
          }
        }
      }
    }
  }

  if (auto.setBy === 'research' && s.mode === 'research' && now - auto.researchAt > 3 * 60e3) autoMode('calm', 'Research complete. Returning to calm mode.');

  // ── background research: learn about newly seen objects while idle ──
  if (st.researchQueue.length && navigator.onLine && now - st.lastResearch > 15e3 && s.brain === 'idle') {
    st.lastResearch = now;
    const name = st.researchQueue.shift();
    knowledge.research(name).then(({ entry, fromMemory }) => {
      if (!fromMemory) think(`Knowledge acquired: ${entry.title}. ${knowledge.sentences(entry.summary)[0]?.slice(0, 150) || ''}`, 'infer');
    }).catch(() => {});
  }

  reflect(s, now);

  // ── periodic self-check ──
  if (now - st.lastIdle > 3 * 60e3) {
    st.lastIdle = now;
    const b = s.battery.level;
    think(`Self-check: vision ${s.vision.status === 'live' ? `${s.vision.fps} fps` : 'offline'}, ${s.tracks.length} targets, ${s.learned.length} learned, ${mem.facts.length} memories, ${knowledge.knownCount()} topics known${b != null ? `, battery ${Math.round(b * 100)}%` : ''}. All systems nominal.`, 'observe');
  }
}

// Deeper reflection: every few minutes, if something happened and the user is not busy,
// ask the language core for one insight about recent events. Shown, not spoken.
function reflect(s, now) {
  if (!s.backend.ai || st.reflecting || now - st.lastReflect < 4 * 60e3 || now - st.lastUser < 60e3 || s.brain !== 'idle') return;
  const fresh = st.episodes.filter((e) => e.at > st.lastReflect);
  if (fresh.length < 2) return;
  st.lastReflect = now;
  st.reflecting = true;
  fetch('/api/reflect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: fresh.slice(-12).map((e) => `${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${e.text}`),
      scene: describeScene(),
      user: mem.userName,
    }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.text && think(d.text, 'reflect'))
    .catch(() => {})
    .finally(() => { st.reflecting = false; });
}

// "what happened?" → a short summary of recent notable events.
export function recentEvents(minutes = 30) {
  const since = Date.now() - minutes * 60e3;
  const ev = st.episodes.filter((e) => e.at > since && !/^Self-check/.test(e.text));
  if (!ev.length) return `Nothing notable in the last ${minutes} minutes. All quiet.`;
  const lower = (s) => (/^(I |Chitti)/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
  const items = ev.slice(-6).map((e) => `at ${new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, ${lower(e.text.replace(/\.$/, '').split('. ')[0])}`);
  return `Here is what happened: ${items.join('; ')}.`;
}


export function greetByName(name) {
  const now = Date.now();
  if (now - st.greetedAt < 30 * 60e3) return;
  st.greetedAt = now;
  const who = name ? `, ${name}` : you();
  think(pick([`Good ${partOfDay()}${who}. Nice to see you.`, `Welcome back${who}.`, `Hello${who}. Chitti online and at your service.`]), 'decide', true);
}

export function startMind() {
  if (timer) return;
  st.greetedAt = Date.now(); // the boot sequence already said hello
  st.lastIdle = Date.now() - 80e3;
  timer = setInterval(tick, 1500);
}

// Context the language core gets about the user.
export function personalContext() {
  return [mem.userName && `user name: ${mem.userName}`, mem.facts.length && `things the user asked me to remember: ${mem.facts.slice(-10).map((f) => f.text).join('; ')}`]
    .filter(Boolean).join('\n');
}
