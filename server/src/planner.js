// Turns a natural-language request into ordered tool steps using Ollama's native tool calling.
// The model only proposes steps; the HUD validates them, asks for confirmation where needed,
// and executes them. No step ever runs from here.
import * as ollama from './ollama.js';
import { ollamaSchema, get } from './tools/index.js';

// Tools that run inside the HUD (browser): calculator, location, camera, notifications, memory.
export const CLIENT_TOOLS = [
  ['calculate', 'CALCULATION', 'Evaluate maths exactly: arithmetic, percentages, fractions, powers, roots, e.g. "15% of 800", "sqrt(144)".', { expression: ['string', 'the maths expression', true] }],
  ['convert_units', 'CALCULATION', 'Convert units, e.g. 5 km to m, 30 celsius to fahrenheit, 2 hours to minutes.', { value: ['number', 'amount', true], from: ['string', 'from unit', true], to: ['string', 'to unit', true] }],
  ['solve_equation', 'LOGIC', 'Solve an equation for x, e.g. "x + 25 = 70" or "2x^2 - 8 = 0".', { equation: ['string', 'the equation', true] }],
  ['date_calc', 'CALCULATION', 'Date and time maths: days between dates, a date N days from today, time after N hours, age.', { question: ['string', 'the date/time question', true] }],
  ['current_location', 'LOCATION', "Get the user's current location (asks the browser for permission) and its address.", {}],
  ['set_location', 'LOCATION', 'Remember where the user is for this session, e.g. "I am in Erode".', { place: ['string', 'place name', true] }],
  ['navigate_to', 'MAPS', 'Open turn-by-turn directions in Google Maps from the current location to a destination.', { destination: ['string', 'destination', true], mode: ['string', 'driving, walking, cycling or transit', false] }],
  ['describe_camera', 'VISION', 'Describe what the webcam sees right now.', {}],
  ['identify_object', 'VISION', 'Identify the object held up to the webcam.', {}],
  ['notify', 'SETTINGS', 'Show a desktop notification.', { message: ['string', 'notification text', true] }],
  ['remember_session', 'MEMORY', 'Remember a note for this session only.', { note: ['string', 'what to remember', true] }],
  ['forget_task', 'MEMORY', 'Forget the current task and session notes.', {}],
];

const clientSchema = () => CLIENT_TOOLS.map(([name, , description, params]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(params).map(([k, [type, d]]) => [k, { type, description: d }])),
      required: Object.entries(params).filter(([, p]) => p[2]).map(([k]) => k),
    },
  },
}));

const SYSTEM = `You are the action planner for CHITTI, a desktop assistant running on the user's Windows PC.
Decide whether the user's request needs tools. If it does, call the tools in the order they must run (you may call several).
If it is conversation, an opinion, general knowledge or a joke, call NO tools.

Rules:
- Use the user's words for arguments; never invent file paths, URLs or coordinates.
- When the user means their own position ("here", "my location", "near me", "from here"), pass the exact text CURRENT_LOCATION.
- To open a file the user describes, use open_best_file (it searches first). For "latest/newest" files set latest=true.
- For web questions about current events, prices or anything recent, use web_search. To show a web page, use open_url.
- "Search YouTube for X" → youtube_search then open_url with its link is handled automatically; just call youtube_search.
- For maths use calculate / convert_units / solve_equation / date_calc instead of answering yourself.
- Only use power, delete_path, move_path, rename_path, close_app when the user clearly asked for exactly that.`;

export async function plan(text, context = {}) {
  const st = ollama.status();
  if (!st.model) return { steps: [], reason: 'No local model available for planning.' };
  const ctx = [
    context.location ? 'The user location is available (use CURRENT_LOCATION).' : 'The user location is not known yet.',
    context.task ? `Current task: ${context.task}` : '',
    context.last ? `Previous result: ${String(context.last).slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');
  const res = await fetch(`${ollama.HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: st.model,
      stream: false,
      keep_alive: '30m',
      options: { temperature: 0, num_predict: 300 },
      messages: [{ role: 'system', content: `${SYSTEM}\n\n${ctx}` }, { role: 'user', content: text }],
      tools: [...ollamaSchema(), ...clientSchema()],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Planner error ${res.status}`);
  const data = await res.json();
  const known = new Set([...CLIENT_TOOLS.map((t) => t[0])]);
  const steps = (data.message?.tool_calls || [])
    .map((c) => ({ tool: c.function?.name, args: typeof c.function?.arguments === 'string' ? safeJson(c.function.arguments) : c.function?.arguments || {} }))
    .filter((s) => s.tool && (get(s.tool) || known.has(s.tool)))
    .slice(0, 6);
  return { steps };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
