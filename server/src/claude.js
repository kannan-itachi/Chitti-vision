// Cloud language + vision core, backed by Claude. Used when ANTHROPIC_API_KEY is set.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, sanitizeHistory, buildTurn } from './prompt.js';

const MODEL = process.env.CHITTI_MODEL || 'claude-opus-5';

let client = null;
let disabledReason = 'Checking credentials…';
try {
  client = new Anthropic();
} catch {
  disabledReason = 'No ANTHROPIC_API_KEY configured';
}

// Verify credentials once at startup (free call) so the HUD's AI light is honest.
export const ready = (async () => {
  if (!client) return;
  try {
    await new Anthropic({ timeout: 6000, maxRetries: 0 }).models.retrieve(MODEL);
    disabledReason = null;
  } catch (e) {
    disabledReason = e instanceof Anthropic.AuthenticationError ? 'API key rejected'
      : e instanceof Anthropic.NotFoundError ? `Model ${MODEL} not available to this key`
      : e instanceof Anthropic.APIConnectionError ? 'Cannot reach the Anthropic API (offline?)'
      : /api.?key|credential|auth/i.test(e.message) ? 'No ANTHROPIC_API_KEY configured'
      : e.message;
  }
})();

export const status = () => ({ enabled: !!client && !disabledReason, model: MODEL, reason: disabledReason });

export async function streamReply({ message, history, context, excerpts, image, signal }, onText) {
  if (!client) throw new Error(disabledReason || 'Language core offline');

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  content.push({ type: 'text', text: buildTurn(message, context, excerpts) });

  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: context?.reasoning ? 'high' : context?.mode === 'research' ? 'medium' : 'low' },
      system: SYSTEM,
      messages: [...sanitizeHistory(history), { role: 'user', content }],
    },
    { signal },
  );
  stream.on('text', onText);

  try {
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') onText(' I cannot help with that one.');
    return final.stop_reason;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      disabledReason = 'API key rejected';
      throw new Error('My language core rejected the API key. Check ANTHROPIC_API_KEY in server/.env.');
    }
    if (err instanceof Anthropic.RateLimitError) throw new Error('My language core is rate limited. Give me a moment and try again.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('I cannot reach my cloud language core. Check the internet connection.');
    if (err instanceof Anthropic.APIStatusError) throw new Error(`Language core error ${err.status}: ${err.message}`);
    throw err;
  }
}
