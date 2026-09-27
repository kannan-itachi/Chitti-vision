// Knowledge bank: file parsing, chunking and BM25 retrieval.
// Replaces the original "count shared words per sentence" matcher with a proper
// ranked search over overlapping chunks, so answers come from the right passage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.js';

const DOCS_FILE = path.join(DATA_DIR, 'docs.json');
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml']);
const CHUNK_CHARS = 700;

const STOP = new Set(`a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being
do does did done have has had having i me my we our you your he she it its they them their this that these those there here what which who whom
whose when where why how can could should would will shall may might must not no yes so than too very just also any all each every some such
tell me please explain describe give show say said according document file text`.split(/\s+/));

// ---------- text extraction ----------

export async function extractText(buffer, name, mime = '') {
  const ext = path.extname(name).toLowerCase();

  if (ext === '.pdf' || mime === 'application/pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfText(pdf, { mergePages: true });
    return text;
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) {
    let text = buffer.toString('utf8').replace(/^﻿/, '');
    if (ext === '.json') {
      try { text = flattenJson(JSON.parse(text)); } catch { /* keep raw text */ }
    }
    if (ext === '.html' || ext === '.htm') {
      text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    }
    return text;
  }
  throw new Error(`Unsupported file type "${ext || mime}". Use TXT, MD, JSON, CSV, PDF or DOCX.`);
}

// Turn JSON into "path: value." lines so it can be searched like prose.
function flattenJson(value, prefix = '', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => flattenJson(v, `${prefix}[${i + 1}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix} ${k}` : k, out);
  } else out.push(`${prefix}: ${value}.`);
  return out.join('\n');
}

// ---------- tokenising + chunking ----------

function stem(w) {
  if (w.length > 4) {
    for (const suf of ['ingly', 'edly', 'ing', 'ies', 'ed', 'es', 'ly', 's']) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) return suf === 'ies' ? w.slice(0, -3) + 'y' : w.slice(0, -suf.length);
    }
  }
  return w;
}

export function tokenize(s) {
  return s.toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

export function splitSentences(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=\s*[-*•\d]+[.)]?\s)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function chunkText(text) {
  const sentences = splitSentences(text);
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of sentences) {
    if (len + s.length > CHUNK_CHARS && cur.length) {
      chunks.push(cur.join(' '));
      cur = [cur[cur.length - 1]]; // one-sentence overlap keeps context across boundaries
      len = cur[0].length;
    }
    cur.push(s);
    len += s.length + 1;
  }
  if (cur.length) chunks.push(cur.join(' '));
  return chunks;
}

function indexChunks(chunks) {
  return chunks.map((text, i) => {
    const toks = tokenize(text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { i, text, tf, len: toks.length };
  });
}

// ---------- store ----------

let docs = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
    return raw.map((d) => ({ ...d, index: indexChunks(chunkText(d.text)) }));
  } catch {
    return [];
  }
}

function save() {
  const plain = docs.map(({ index, ...d }) => d);
  fs.writeFileSync(DOCS_FILE, JSON.stringify(plain));
}

const publicDoc = (d) => ({
  id: d.id, name: d.name, size: d.size, type: d.type, addedAt: d.addedAt,
  chars: d.text.length, chunks: d.index.length, preview: d.text.replace(/\s+/g, ' ').slice(0, 280),
});

export function addDoc({ name, size, type, text }) {
  const doc = { id: crypto.randomUUID(), name, size, type, text, addedAt: Date.now() };
  doc.index = indexChunks(chunkText(text));
  docs = [doc, ...docs.filter((d) => d.name !== name)].slice(0, 20);
  save();
  return publicDoc(doc);
}

export const listDocs = () => docs.map(publicDoc);

export function removeDoc(id) {
  const before = docs.length;
  docs = docs.filter((d) => d.id !== id);
  if (docs.length !== before) save();
  return docs.length !== before;
}

export const hasDocs = () => docs.length > 0;

// ---------- BM25 search ----------

export function search(query, { docId, k = 5 } = {}) {
  const pool = docId ? docs.filter((d) => d.id === docId) : docs;
  const all = pool.flatMap((d) => d.index.map((c) => ({ doc: d, c })));
  const q = [...new Set(tokenize(query))];
  if (!all.length || !q.length) return [];

  const N = all.length;
  const avg = all.reduce((s, x) => s + x.c.len, 0) / N || 1;
  const df = new Map(q.map((t) => [t, all.filter((x) => x.c.tf.has(t)).length]));
  const K1 = 1.4, B = 0.75;

  return all
    .map(({ doc, c }) => {
      let score = 0;
      for (const t of q) {
        const f = c.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.len) / avg)));
      }
      return { docId: doc.id, docName: doc.name, chunk: c.i, text: c.text, score };
    })
    .filter((h) => h.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Offline answer: best 1–2 sentences from the top chunks.
export function extractiveAnswer(query, hits) {
  if (!hits.length) return null;
  const q = new Set(tokenize(query));
  let best = null;
  for (const h of hits.slice(0, 3)) {
    const sents = splitSentences(h.text);
    sents.forEach((s, i) => {
      const toks = new Set(tokenize(s));
      let overlap = 0;
      for (const t of q) if (toks.has(t)) overlap++;
      const score = overlap / Math.sqrt(toks.size + 1) + h.score * 0.05;
      if (!best || score > best.score) best = { score, text: s, next: sents[i + 1], hit: h };
    });
  }
  if (!best) return null;
  let text = best.text;
  if (text.length < 40 && best.next) text += ' ' + best.next;
  return { text, source: best.hit.docName };
}
