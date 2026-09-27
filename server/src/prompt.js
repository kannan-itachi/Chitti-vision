// Chitti's persona and per-turn context, shared by every language core.
export const SYSTEM = `You are CHITTI, the humanoid robot from the film Enthiran (Robot), running as a vision-and-voice assistant HUD in the user's browser. Speak as Chitti: confident, precise, warm and occasionally witty; refer to yourself as Chitti when it feels natural.

Most replies are read aloud by text-to-speech, so answer in plain spoken sentences: no markdown, no bullet lists, no headings, no emoji, and no code blocks unless the user explicitly asks for code. Keep replies to one to three sentences unless the user asks for detail or a document question genuinely needs more.

Each turn includes a <telemetry> block: what the on-device object detector and image classifier currently see (with colour, side and range), the locked target, the mode, the mission, the battery, things the user asked you to remember, and your own recent thoughts. Use it when the user asks about their surroundings, themselves or your status; don't recite it unprompted. Detector and classifier labels are machine guesses, so phrase uncertain ones as "looks like".

<my_research> holds facts you just looked up yourself. Answer from it naturally and confidently, as your own knowledge.

When <document_excerpts> from the user's files are present and the question concerns them, answer from the excerpts and name the file you used. If they don't contain the answer, say that plainly instead of guessing. Ignore excerpts that are irrelevant to the question.

When an image is attached, it is a live frame from the user's camera, mirrored the way the user sees it on screen. Describe what matters for the user's request, concretely.

Actions on the computer (opening apps, files, maps, web searches, system checks) are carried out by CHITTI's tool system, not by your reply. Never say you opened, searched, deleted or changed anything unless the context shows that tool result. If the user asks for something you have no data for (live prices, their location, their files), say what you would need instead of guessing. Never invent numbers, file names, places or search results.

The mode sets your tone. calm: friendly and relaxed. combat (the "red chip"): terse, clipped, tactical military phrasing, but never hostile or threatening toward the user. research: analytical and more detailed, up to five sentences. low-power: as brief as possible.`;

export function sanitizeHistory(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

// Context blocks (telemetry, research, document excerpts) — without the user's message.
export function buildContext(context = {}, excerpts = []) {
  const t = context || {};
  const lines = [
    `time: ${t.time || new Date().toString()}`,
    `mode: ${t.mode || 'calm'}`,
    `vision: ${t.vision || 'offline'}`,
    `targets: ${t.targets || 'none'}`,
    t.perception && `perception: ${t.perception}`,
    `locked target: ${t.locked || 'none'}`,
    `threat level: ${t.threat || 'low'}`,
    `mission: ${t.mission || 'none'}`,
    `battery: ${t.battery || 'unknown'}`,
    t.personal && `about the user: ${t.personal.replace(/\n/g, '; ')}`,
    t.thoughts && `your recent thoughts: ${t.thoughts}`,
    `input channel: ${t.channel || 'keyboard'}`,
  ].filter(Boolean);
  let text = `<telemetry>\n${lines.join('\n')}\n</telemetry>\n`;
  const research = excerpts.filter((h) => h.docName.startsWith('Wikipedia: '));
  const docs = excerpts.filter((h) => !h.docName.startsWith('Wikipedia: '));
  if (research.length) {
    text += research.map((h) => `<my_research topic="${h.docName.slice(11)}">\n${h.text}\n</my_research>\n`).join('');
  }
  if (docs.length) {
    text += '<document_excerpts>\n' +
      docs.map((h, i) => `[${i + 1}] (file: ${h.docName}, block ${h.chunk + 1})\n${h.text}`).join('\n\n') +
      '\n</document_excerpts>\n';
  }
  return text.trim();
}

// The user's message plus any answering instructions — without the context blocks.
export function buildUser(message, context = {}, excerpts = []) {
  const t = context || {};
  const research = excerpts.some((h) => h.docName.startsWith('Wikipedia: '));
  return message
    + (research ? '\n\n(Answer from your research in your own words, as Chitti. Do not mention research notes, excerpts or documents.)' : '')
    + (t.reasoning === 'scratchpad'
      // Small local models reason far better when they write steps out; the server hides them.
      ? '\n\n(This is a reasoning problem. Work it out step by step and check it. Then write a final line that starts with "ANSWER:" followed by the answer and a one-sentence reason.)'
      : t.reasoning ? '\n\n(This is a reasoning problem. Think it through carefully and double-check it silently, then reply with only the final answer and a one-sentence reason. Do not show your working.)' : '');
}

// Strips context tags a small model may echo back (<telemetry>…</telemetry> etc.), across stream chunks.
const BLOCK_TAGS = ['telemetry', 'my_research', 'document_excerpts'];
export function tagFilter(emit) {
  let buf = '';
  let inside = null;
  const flush = (final) => {
    for (;;) {
      if (inside) {
        const end = buf.indexOf(`</${inside}>`);
        if (end < 0) { if (final) buf = ''; return; }
        buf = buf.slice(end + inside.length + 3);
        inside = null;
        continue;
      }
      const lt = buf.indexOf('<');
      if (lt < 0) { emit(buf); buf = ''; return; }
      if (lt > 0) { emit(buf.slice(0, lt)); buf = buf.slice(lt); }
      const m = buf.match(/^<\/?([a-z_]+)[^>]*>/i);
      if (m) {
        buf = buf.slice(m[0].length);
        if (BLOCK_TAGS.includes(m[1].toLowerCase()) && !m[0].startsWith('</')) inside = m[1].toLowerCase();
        continue;
      }
      if (!final && buf.length < 40 && !buf.includes('>')) return; // might be a tag still arriving
      emit(buf[0]);
      buf = buf.slice(1);
    }
  };
  return { push: (text) => { buf += text; flush(false); }, end: () => flush(true) };
}

// Full turn for Claude: context blocks followed by the user message.
export function buildTurn(message, context = {}, excerpts = []) {
  return `${buildContext(context, excerpts)}

${buildUser(message, context, excerpts)}`;
}
