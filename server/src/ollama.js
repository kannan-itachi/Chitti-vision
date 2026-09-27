// Local, fully offline language core via Ollama (https://ollama.com).
// Used when no Anthropic key is configured. Starts `ollama serve` if it is
// installed but not running, picks an installed model and keeps it warm.
import { spawn } from 'node:child_process';

export const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const PREFERRED = ['llama3.2', 'llama3.1', 'qwen2.5', 'gemma3', 'phi3', 'mistral', 'llama3'];
const VISION = /llava|vision|moondream|bakllava|gemma3|qwen2\.5vl|minicpm-v/i;

let state = { up: false, model: null, vision: false, reason: 'Not checked yet' };
let spawned = false;
let failures = 0;

export const status = () => state;

async function tags() {
  const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).models?.map((m) => m.name) || [];
}

function choose(models) {
  const want = process.env.OLLAMA_MODEL;
  if (want) return models.find((m) => m === want || m.startsWith(`${want}:`)) || null;
  for (const p of PREFERRED) {
    const hit = models.find((m) => m.startsWith(`${p}:`) || m === p);
    if (hit) return hit;
  }
  return models.find((m) => !/embed/i.test(m)) || null;
}

export async function refresh() {
  try {
    const models = await tags();
    failures = 0;
    const model = choose(models);
    const changed = model !== state.model;
    state = model
      ? { up: true, model, vision: VISION.test(model), reason: null }
      : { up: true, model: null, vision: false, reason: 'Ollama is running but has no chat model. Run: ollama pull llama3.2' };
    if (changed && model) warm(model);
  } catch {
    // A busy Ollama (generating on CPU) can answer slowly; keep the last good state for one miss.
    if (state.model && ++failures < 2) return state;
    state = { up: false, model: null, vision: false, reason: 'Ollama not running' };
    if (!spawned && process.env.OLLAMA_AUTOSTART !== 'false') {
      spawned = true;
      try {
        const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => { state.reason = 'Ollama not installed'; });
        child.unref();
        state.reason = 'Starting Ollama…';
      } catch {
        state.reason = 'Ollama not installed';
      }
    }
  }
  return state;
}

// Load the model into memory ahead of time so the first reply is quick.
function warm(model) {
  fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: '30m' }),
  }).catch(() => {});
}

// Streams an answer; `messages` are plain {role, content}. Returns when done.
export async function streamChat({ system, messages, image, research, reasoning }, onText, signal) {
  if (!state.model) throw new Error('No local model available');
  const msgs = [{ role: 'system', content: system }, ...messages];
  if (image && state.vision) msgs[msgs.length - 1].images = [image];

  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: state.model,
      messages: msgs,
      stream: true,
      keep_alive: '30m',
      options: { temperature: reasoning ? 0.2 : 0.6, num_predict: reasoning || research ? 500 : 220 },
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Local model error ${res.status}: ${await res.text().catch(() => '')}`);

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(ev.error);
      if (ev.message?.content) onText(ev.message.content);
    }
  }
}
