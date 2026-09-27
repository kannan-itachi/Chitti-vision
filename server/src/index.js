import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import { CLIENT_DIST, DATA_DIR } from './paths.js';
import * as kb from './knowledge.js';
import * as brain from './brain.js';
import * as memory from './memory.js';
import { lookup, RateLimited } from './wiki.js';
import crypto from 'node:crypto';
import * as tools from './tools/index.js';
import { plan, CLIENT_TOOLS } from './planner.js';

const PORT = Number(process.env.PORT) || 8787;

// A local assistant should not vanish because one tool hit an unexpected error: log it and keep serving.
const ERROR_LOG = path.join(DATA_DIR, 'server-errors.log');
const logFatal = (kind) => (err) => {
  const line = `${new Date().toISOString()} ${kind}: ${err?.stack || err}\n`;
  console.error(`  ${kind}: ${err?.message || err}`);
  try { fs.appendFileSync(ERROR_LOG, line); } catch { /* ignore */ }
};
process.on('uncaughtException', logFatal('uncaughtException'));
process.on('unhandledRejection', logFatal('unhandledRejection'));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ai: brain.status(), docs: kb.listDocs().length });
});

// ---------- tools (system control, files, screen, maps, web) ----------
// Every tool call needs this per-run token, which only a page served from localhost can read
// (CORS). A random website therefore cannot trigger actions on this PC through the local server.
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function guard(req, res, next) {
  const origin = req.get('origin');
  if (origin && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ success: false, error: 'Forbidden origin.' });
  if (req.get('x-chitti-token') !== SESSION_TOKEN) return res.status(401).json({ success: false, error: 'Missing or invalid session token.' });
  next();
}

app.get('/api/session', (req, res) => {
  const origin = req.get('origin');
  if ((origin && !LOCAL_ORIGIN.test(origin)) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).end();
  res.json({ token: SESSION_TOKEN });
});

app.get('/api/tools', guard, (req, res) => res.json({ server: tools.catalog(), client: CLIENT_TOOLS.map(([name, category, description]) => ({ name, category, description })) }));

app.post('/api/tools/confirm', guard, async (req, res) => {
  const { confirmId, approved } = req.body || {};
  res.json(await tools.confirm(String(confirmId || ''), approved === true));
});

app.post('/api/tools/:name', guard, async (req, res) => {
  const out = await tools.call(req.params.name, req.body?.args || {});
  if (!out.success && out.error) console.warn(`  tool ${req.params.name} failed: ${out.error}`);
  res.json(out);
});

app.post('/api/plan', guard, async (req, res) => {
  const { text, context } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ steps: [], error: 'Empty request.' });
  try {
    res.json(await plan(text.slice(0, 1000), context || {}));
  } catch (e) {
    res.json({ steps: [], error: e.message });
  }
});

// ---------- knowledge bank ----------

app.get('/api/docs', (req, res) => res.json(kb.listDocs()));

// Multer errors (too large, aborted) → a clear JSON message instead of a dropped connection.
const receiveFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is larger than 50 MB.' });
  return res.status(400).json({ error: err.message || 'Upload failed.' });
});

app.post('/api/docs', receiveFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  try {
    const text = await kb.extractText(req.file.buffer, name, req.file.mimetype);
    if (!text || !text.trim()) return res.status(422).json({ error: 'No readable text found in that file.' });
    res.json(kb.addDoc({ name, size: req.file.size, type: req.file.mimetype || path.extname(name), text }));
  } catch (e) {
    res.status(415).json({ error: e.message || 'Could not read that file.' });
  }
});

app.delete('/api/docs/:id', (req, res) => {
  res.status(kb.removeDoc(req.params.id) ? 204 : 404).end();
});

// ---------- wikipedia ----------

app.get('/api/wiki', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing topic.' });
  try {
    const hit = await lookup(q, { full: req.query.full === '1', search: req.query.search === '1' });
    if (!hit) return res.status(404).json({ error: `No Wikipedia article found for "${q}".` });
    res.json(hit);
  } catch (e) {
    if (e instanceof RateLimited) return res.status(429).json({ error: e.message });
    res.status(502).json({ error: 'Wikipedia is unreachable right now.' });
  }
});

// ---------- memory ----------

app.get('/api/memory', (req, res) => res.json(memory.get()));
app.patch('/api/memory', (req, res) => res.json(memory.patch(req.body)));

// ---------- conversation (Server-Sent Events) ----------

app.post('/api/chat', async (req, res) => {
  const { message, history, context, image, docId, docOnly, reference } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Empty message.' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());

  const hits = kb.hasDocs() && !reference ? kb.search(message, { docId, k: 5 }) : [];
  // A Wikipedia article the HUD already fetched, used to ground a factual answer.
  const refs = reference?.text ? [{ docName: `Wikipedia: ${String(reference.title).slice(0, 120)}`, chunk: 0, text: String(reference.text).slice(0, 6000) }] : [];
  if (hits.length) send({ type: 'sources', sources: hits.map((h) => ({ doc: h.docName, block: h.chunk + 1 })) });

  try {
    if (brain.status().enabled && !(docOnly && !hits.length)) {
      await brain.streamReply({ message, history, context, excerpts: [...refs, ...hits], image, signal: ctrl.signal }, (text) => send({ type: 'delta', text }));
    } else {
      send({ type: 'delta', text: offlineReply(message, hits, { docOnly, image }) });
    }
  } catch (e) {
    if (!ctrl.signal.aborted) send({ type: 'error', message: e.message || 'Unknown fault in the language core.' });
  }
  send({ type: 'done' });
  res.end();
});

// ---------- reflection: one inner thought about recent events (self-thinking) ----------

app.post('/api/reflect', async (req, res) => {
  const { events = [], scene = '', user } = req.body || {};
  if (!brain.status().enabled) return res.status(503).json({ error: 'No language core online.' });
  const message = [
    'This is an internal reflection, not a reply to the user.',
    `Recent events you observed:\n${events.slice(-12).map((e) => `- ${String(e).slice(0, 200)}`).join('\n')}`,
    `Current scene: ${String(scene).slice(0, 500)}`,
    user ? `The user's name is ${String(user).slice(0, 40)}.` : '',
    'Write ONE short inner thought (max 25 words) as Chitti: a pattern you notice, a prediction, or a helpful idea for the user. No greeting, no quotes.',
  ].filter(Boolean).join('\n\n');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  let text = '';
  try {
    await brain.streamReply({ message, history: [], context: { mode: 'calm', channel: 'internal reflection' }, excerpts: [], signal: ctrl.signal }, (d) => { text += d; });
    res.json({ text: text.trim().replace(/^["'“]+|["'”]+$/g, '').slice(0, 240) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    clearTimeout(timeout);
  }
});

function offlineReply(message, hits, { docOnly, image }) {
  const ans = kb.extractiveAnswer(message, hits);
  if (ans) return `${ans.text} (from ${ans.source})`;
  if (docOnly) return kb.hasDocs()
    ? 'I searched my knowledge bank but found nothing about that. Teach me with "remember that", or start a language core such as Ollama.'
    : 'No document loaded. Upload a file with the plus button first.';
  if (image) return 'Image analysis needs Claude or a vision model in Ollama. My on-device detector and classifier are still working.';
  return 'No language core is online. Start Ollama for offline conversation, or add an ANTHROPIC_API_KEY. Say help to hear what I can do.';
}

// ---------- serve the built HUD in production ----------

app.use(express.static(CLIENT_DIST));
app.get(/^(?!\/api).*/, (req, res, next) => res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => err && next()));

// Express 5 passes listen errors to the callback instead of throwing. Without handling them,
// a busy port (e.g. the previous instance still shutting down during a --watch restart, or a
// second `npm run dev`) made the server exit silently and every request failed with 500.
function start(attempt = 1) {
  const server = app.listen(PORT, '127.0.0.1', async (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE' && attempt <= 20) {
        if (attempt === 1) console.warn(`  Port ${PORT} is busy (another Chitti server running?). Retrying…`);
        setTimeout(() => start(attempt + 1), 1500);
        return;
      }
      console.error(`  Could not start the brain server: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    await brain.ready;
    const ai = brain.status();
    console.log(`\n  CHITTI brain online  →  http://127.0.0.1:${PORT}`);
    console.log(`  Language core: ${ai.enabled ? `${ai.provider.toUpperCase()} (${ai.model})` : `OFFLINE MIND ONLY — ${ai.reason}`}\n`);
  });
  return server;
}
start();
