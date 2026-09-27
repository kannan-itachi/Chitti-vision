// Exact maths for CHITTI (mathjs, offline): arithmetic, percentages, fractions, powers, roots,
// unit conversion, equation solving, and date/time calculations. The language model is never
// asked to do arithmetic.
import { solveSequence } from './mind';

let mathP = null;
const loadMath = () => (mathP ??= import('mathjs').then((m) => m.create(m.all, { number: 'number', precision: 14 })));

const WORDS = [
  [/\bsquare root of\b|\bsqrt of\b/g, 'sqrt '], [/\bcube root of\b/g, 'cbrt '], [/\bto the power (of )?\b|\braised to( the power of)?\b/g, '^'],
  [/\bsquared\b/g, '^2'], [/\bcubed\b/g, '^3'], [/\bplus\b/g, '+'], [/\bminus\b/g, '-'], [/\btimes\b|\bmultiplied by\b|×|✕/g, '*'],
  [/\bdivided by\b|÷/g, '/'], [/\bmod(ulo)?\b/g, ' mod '], [/\bpi\b/g, 'pi'],
];

const UNIT = {
  kilometers: 'km', kilometres: 'km', kilometer: 'km', kilometre: 'km', kms: 'km', meters: 'm', metres: 'm', meter: 'm', metre: 'm',
  centimeters: 'cm', centimetres: 'cm', centimeter: 'cm', millimeters: 'mm', millimetres: 'mm', miles: 'mi', mile: 'mi', feet: 'ft', foot: 'ft',
  inches: 'inch', inch: 'inch', yards: 'yd', yard: 'yd', kilograms: 'kg', kilogram: 'kg', kilos: 'kg', kilo: 'kg', grams: 'g', gram: 'g',
  milligrams: 'mg', pounds: 'lb', pound: 'lb', lbs: 'lb', ounces: 'oz', ounce: 'oz', tonnes: 'tonne', tons: 'tonne', liters: 'L', litres: 'L',
  liter: 'L', litre: 'L', milliliters: 'mL', millilitres: 'mL', ml: 'mL', gallons: 'gal', gallon: 'gal', celsius: 'degC', centigrade: 'degC',
  fahrenheit: 'degF', kelvin: 'K', hours: 'h', hour: 'h', hrs: 'h', minutes: 'min', minute: 'min', mins: 'min', seconds: 's', second: 's',
  secs: 's', days: 'day', weeks: 'week', months: 'month', years: 'year', 'km/h': 'km/h', kmph: 'km/h', mph: 'mi/h', 'm/s': 'm/s',
  gigabytes: 'GB', gb: 'GB', megabytes: 'MB', mb: 'MB', kilobytes: 'kB', kb: 'kB', terabytes: 'TB', tb: 'TB', bytes: 'B',
  'square meters': 'm^2', 'square metres': 'm^2', 'square feet': 'ft^2', acres: 'acre', hectares: 'hectare', degrees: 'deg', radians: 'rad',
};
const unitOf = (u) => {
  const k = String(u).toLowerCase().trim().replace(/\.$/, '');
  return UNIT[k] || UNIT[k.replace(/s$/, '')] || u.trim();
};

const round = (x) => (Math.abs(x) >= 1e15 || (Math.abs(x) < 1e-6 && x !== 0) ? x.toExponential(6) : String(Math.round(x * 1e10) / 1e10));

function fractionText(math, value, expr) {
  if (!/\d\s*\/\s*\d/.test(expr) || Number.isInteger(value)) return '';
  try {
    const f = math.fraction(value);
    return f.d <= 1000 ? ` (${f.s < 0 ? '-' : ''}${f.n}/${f.d})` : '';
  } catch {
    return '';
  }
}

// ---------- arithmetic & percentages ----------

export async function calculate(input) {
  const math = await loadMath();
  let e = ` ${String(input).toLowerCase().replace(/\?+$/, '')} `
    .replace(/^\s*(what('?s| is)|calculate|compute|evaluate|how much is|find)\s+/, ' ')
    .replace(/,(?=\d{3}\b)/g, '');
  // percentages
  let m;
  if ((m = e.match(/(\d+(?:\.\d+)?)\s*(%|percent)\s*of\s*(\d+(?:\.\d+)?)/))) {
    const v = (Number(m[1]) / 100) * Number(m[3]);
    return { value: v, say: `${m[1]}% of ${m[3]} is ${round(v)}.` };
  }
  if ((m = e.match(/what (percent|percentage) is (\d+(?:\.\d+)?) of (\d+(?:\.\d+)?)/) || e.match(/(\d+(?:\.\d+)?) is what (percent|percentage) of (\d+(?:\.\d+)?)/))) {
    const [a, b] = m[1].startsWith('per') ? [Number(m[2]), Number(m[3])] : [Number(m[1]), Number(m[3])];
    const v = (a / b) * 100;
    return { value: v, say: `${a} is ${round(v)}% of ${b}.` };
  }
  if ((m = e.match(/(increase|decrease|add|subtract)\s+(\d+(?:\.\d+)?)\s+by\s+(\d+(?:\.\d+)?)\s*(%|percent)/))) {
    const base = Number(m[2]);
    const v = /increase|add/.test(m[1]) ? base * (1 + Number(m[3]) / 100) : base * (1 - Number(m[3]) / 100);
    return { value: v, say: `${base} ${/increase|add/.test(m[1]) ? 'increased' : 'decreased'} by ${m[3]}% is ${round(v)}.` };
  }
  for (const [re, rep] of WORDS) e = e.replace(re, rep);
  e = e.replace(/\b(sqrt|cbrt)\s+(\d+(?:\.\d+)?)/g, '$1($2)').replace(/(\d)\s*x\s*(\d)/g, '$1*$2').replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)').trim();
  if (!/\d/.test(e)) throw new Error('No numbers to calculate.');
  const value = math.evaluate(e);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (value && typeof value.toString === 'function' && !Number.isNaN(Number(value))) return { value: Number(value), say: `${input.trim().replace(/\?$/, '')} = ${value}.` };
    throw new Error('That calculation has no finite answer.');
  }
  return { value, say: `${e.replace(/\*/g, ' × ').replace(/\s+/g, ' ')} = ${round(value)}${fractionText(math, value, e)}.` };
}

// ---------- unit conversion ----------

export async function convertUnits(value, from, to) {
  const math = await loadMath();
  const f = unitOf(from);
  const t = unitOf(to);
  let out;
  try {
    out = math.unit(Number(value), f).to(t);
  } catch {
    throw new Error(`I can't convert ${from} to ${to}.`);
  }
  const num = out.toNumber(t);
  const pretty = (u) => ({ degC: '°C', degF: '°F', 'mi/h': 'mph' }[u] || u);
  // Storage units: SI (1 GB = 1000 MB) is exact, but people often mean binary (1 GB = 1024 MB).
  const BYTES = ['B', 'kB', 'MB', 'GB', 'TB'];
  let binary = '';
  if (BYTES.includes(f) && BYTES.includes(t) && f !== t) {
    const bin = Number(value) * 1024 ** (BYTES.indexOf(f) - BYTES.indexOf(t));
    binary = ` In binary units, where 1 ${f} is 1024 of the next size down, it is ${round(bin)} ${t}.`;
  }
  return { value: num, say: `${value} ${from} is ${round(num)} ${pretty(t) === t ? to : pretty(t)}.${binary}` };
}

export function parseConversion(text) {
  const m = text.toLowerCase().replace(/\?$/, '')
    .match(/(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([a-z°/²^ ]+?)\s+(?:to|into|in)\s+([a-z°/²^ ]+)$/);
  if (!m) return null;
  const from = m[2].replace(/°\s*c|degrees? c(elsius)?/, 'celsius').replace(/°\s*f|degrees? f(ahrenheit)?/, 'fahrenheit').trim();
  const to = m[3].replace(/^°\s*c$|^degrees? c(elsius)?$/, 'celsius').replace(/^°\s*f$|^degrees? f(ahrenheit)?$/, 'fahrenheit').trim();
  if (/^(the|a|my|an)\b/.test(to)) return null;
  return { value: Number(m[1]), from, to };
}

// ---------- equations ----------

export async function solveEquation(input) {
  const math = await loadMath();
  const eq = String(input).toLowerCase().replace(/^\s*(solve|find|what is)\s*(for\s+[a-z]\s*)?[:,]?/, '').replace(/\?$/, '').replace(/×/g, '*').trim();
  if (!eq.includes('=')) throw new Error('An equation needs an equals sign, like x + 25 = 70.');
  const [lhs, rhs] = eq.split('=');
  // The unknown is the first letter that isn't part of a function/constant name ("3y - 7 = 2y + 5" → y).
  const v = (eq.replace(/\b(sqrt|cbrt|sin|cos|tan|log|ln|abs|pi|exp)\b/g, '').match(/[a-z]/) || ['x'])[0];
  const f = (x) => math.evaluate(`(${lhs}) - (${rhs})`, { [v]: x });
  const f0 = f(0), f1 = f(1), fm = f(-1);
  const a = (f1 + fm) / 2 - f0;
  const b = (f1 - fm) / 2;
  const c = f0;
  // verify the model at another point so we only claim a result we have checked
  const check = (x) => Math.abs(f(x) - (a * x * x + b * x + c)) < 1e-6 * (1 + Math.abs(f(x)));
  if (!check(3) || !check(-7)) throw new Error('I can only solve linear and quadratic equations exactly.');
  const fmt = (x) => round(Math.abs(x) < 1e-12 ? 0 : x);
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return { say: Math.abs(c) < 1e-12 ? 'Every value is a solution.' : 'There is no solution.' };
    const x = -c / b;
    return { value: x, say: `${v} = ${fmt(x)}.` };
  }
  const d = b * b - 4 * a * c;
  if (d < 0) return { say: `There are no real solutions for ${v}.` };
  const r1 = (-b + Math.sqrt(d)) / (2 * a);
  const r2 = (-b - Math.sqrt(d)) / (2 * a);
  return { value: [r1, r2], say: Math.abs(r1 - r2) < 1e-12 ? `${v} = ${fmt(r1)}.` : `${v} = ${fmt(Math.max(r1, r2))} or ${v} = ${fmt(Math.min(r1, r2))}.` };
}

// ---------- dates & times ----------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY = 86400e3;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtDate = (d) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function parseDate(s, { future = false } = {}) {
  const t = s.toLowerCase().trim().replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/,/g, '');
  const now = new Date();
  if (/^today$/.test(t)) return startOfDay(now);
  if (/^tomorrow$/.test(t)) return new Date(startOfDay(now).getTime() + DAY);
  if (/^yesterday$/.test(t)) return new Date(startOfDay(now).getTime() - DAY);
  let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); // dd/mm/yyyy (Indian format)
  if (m) return new Date(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[2]) - 1, Number(m[1]));
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = t.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/) || t.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (m) {
    const [dayStr, monStr] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const mi = MONTHS.findIndex((x) => x.startsWith(monStr.slice(0, 3)));
    if (mi >= 0) {
      let d = new Date(m[3] ? Number(m[3]) : now.getFullYear(), mi, Number(dayStr));
      if (!m[3] && future && d < startOfDay(now)) d = new Date(now.getFullYear() + 1, mi, Number(dayStr));
      return d;
    }
  }
  return null;
}

export function dateCalc(q) {
  const t = q.toLowerCase().replace(/\?$/, '').trim();
  const now = new Date();
  let m;
  // "what date is 45 days from today", "date after 3 weeks", "10 days ago"
  if ((m = t.match(/(\d+)\s*(day|week|month|year)s?\s*(from (today|now)|later|after today|from now|ago|before today)/)) || (m = t.match(/(?:in|after)\s+(\d+)\s*(day|week|month|year)s?$/))) {
    const n = Number(m[1]) * (/ago|before/.test(m[3] || '') ? -1 : 1);
    const d = startOfDay(now);
    if (m[2] === 'day') d.setDate(d.getDate() + n);
    else if (m[2] === 'week') d.setDate(d.getDate() + n * 7);
    else if (m[2] === 'month') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    return { say: `That is ${fmtDate(d)}.` };
  }
  // "what time will it be in 3 hours 20 minutes"
  if ((m = t.match(/(?:time|clock).*\bin\s+(?:(\d+)\s*hours?)?\s*(?:and\s*)?(?:(\d+)\s*min(?:ute)?s?)?/)) && (m[1] || m[2])) {
    const d = new Date(now.getTime() + (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60e3);
    return { say: `It will be ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${d.getDate() !== now.getDate() ? ' tomorrow' : ''}.` };
  }
  // "days between 1 jan 2026 and 15 aug 2026"
  if ((m = t.match(/(?:days?|weeks?) (?:between|from) (.+?) (?:and|to|till|until) (.+)$/))) {
    const a = parseDate(m[1]);
    const b = parseDate(m[2]);
    if (a && b) {
      const days = Math.round((b - a) / DAY);
      return { say: `There are ${Math.abs(days)} days between ${fmtDate(a)} and ${fmtDate(b)}${Math.abs(days) >= 14 ? `, about ${Math.round(Math.abs(days) / 7)} weeks` : ''}.` };
    }
  }
  // "how many days until 25 december" / "days left for diwali" (dates only)
  if ((m = t.match(/(?:how many )?days? (?:until|till|to go (?:until|till|for)|left (?:until|till|for)|to) (.+)$/))) {
    const d = parseDate(m[1], { future: true });
    if (d) {
      const days = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
      return { say: days >= 0 ? `${days} day${days === 1 ? '' : 's'} until ${fmtDate(d)}.` : `${fmtDate(d)} was ${-days} days ago.` };
    }
  }
  // "how old am i if i was born on 5 june 2004" / "age born 2004"
  if ((m = t.match(/born (?:on |in )?(.+)$/))) {
    const d = /^\d{4}$/.test(m[1].trim()) ? new Date(Number(m[1]), 0, 1) : parseDate(m[1]);
    if (d) {
      let age = now.getFullYear() - d.getFullYear();
      if (!/^\d{4}$/.test(m[1].trim()) && (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate()))) age--;
      return { say: /^\d{4}$/.test(m[1].trim()) ? `You would be ${age - 1} or ${age} years old this year.` : `You are ${age} years old.` };
    }
  }
  // "what day is 15 august 2026"
  if ((m = t.match(/what day (?:is|was|will be) (.+)$/))) {
    const d = parseDate(m[1]);
    if (d) return { say: `${fmtDate(d)}.` };
  }
  return null;
}

// ---------- sequences ----------

export function nextInSequence(text) {
  const s = solveSequence(text.includes('?') || /next/.test(text) ? text : `${text} ?`);
  return s ? { say: `The next number is ${s}` } : null;
}
