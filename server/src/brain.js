// Picks Chitti's language core: Claude (cloud) when a key works, otherwise a local
// Ollama model (fully offline). With neither, the HUD's built-in offline mind answers.
import * as claude from './claude.js';
import * as ollama from './ollama.js';
import { SYSTEM, sanitizeHistory, buildContext, buildUser, tagFilter } from './prompt.js';

export const ready = Promise.all([claude.ready, ollama.refresh()]);
setInterval(() => ollama.refresh(), 15000).unref();

export function status() {
  const c = claude.status();
  if (c.enabled) return { enabled: true, provider: 'claude', model: c.model, vision: true, reason: null };
  const o = ollama.status();
  if (o.model) return { enabled: true, provider: 'ollama', model: o.model, vision: o.vision, reason: null };
  return { enabled: false, provider: 'none', model: null, vision: false, reason: `Claude: ${c.reason}. Local: ${o.reason}.` };
}

export async function streamReply(args, onText) {
  const s = status();
  if (s.provider === 'claude') return claude.streamReply(args, onText);
  if (s.provider === 'ollama') {
    const { message, history, excerpts = [], image, signal } = args;
    const reasoning = !!args.context?.reasoning;
    const context = reasoning ? { ...args.context, reasoning: 'scratchpad' } : args.context;
    // Small local models tend to echo structured context, so it goes in the system prompt
    // and the user turn carries only the question; a filter strips anything echoed anyway.
    const system = `${SYSTEM}\n\nCURRENT CONTEXT (private; never repeat or quote it):\n${buildContext(context, excerpts)}`;
    const messages = [...sanitizeHistory(history), { role: 'user', content: buildUser(message, context, excerpts) }];
    // Reasoning: let the model work step by step privately, and pass on only its "ANSWER:" line.
    let scratch = '';
    const filter = tagFilter(reasoning ? (t) => { scratch += t; } : onText);
    try {
      await ollama.streamChat({ system, messages, image, research: context?.mode === 'research', reasoning }, filter.push, signal);
      filter.end();
      if (reasoning) {
        const m = scratch.match(/ANSWER:\s*([\s\S]+)$/i);
        const answer = (m ? m[1] : scratch.trim().split(/\n+/).pop() || '').replace(/\*\*/g, '').trim();
        onText(answer || 'I could not work that out.');
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      ollama.refresh();
      throw new Error(`My local language core failed: ${e.message}`);
    }
    return 'end_turn';
  }
  throw new Error('No language core online');
}
