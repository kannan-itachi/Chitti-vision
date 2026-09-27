// Typed tool interface shared by every capability.
//
//   define({ name, category, description, params, risk, run })
//     params: { argName: { type: 'string'|'number'|'boolean', description, required?, enum? } }
//     risk:   'safe'    → runs immediately
//             'confirm' → the server refuses to run it until the user confirms (never bypassed)
//     run(args) returns anything (the result) or throws ToolError(message) for a clean failure.
//
// Every call resolves to { success, result, error } — tools never fail silently.
import crypto from 'node:crypto';

const tools = new Map();
const pending = new Map(); // confirmId → { name, args, prompt, expires }

export class ToolError extends Error {}

export function define(tool) {
  tools.set(tool.name, { risk: 'safe', params: {}, ...tool });
}

export const get = (name) => tools.get(name);

// Validates and coerces arguments against the tool's declared params.
function validate(tool, args = {}) {
  const clean = {};
  for (const [key, spec] of Object.entries(tool.params)) {
    let v = args[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) throw new ToolError(`Missing "${key}".`);
      continue;
    }
    if (spec.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new ToolError(`"${key}" must be a number.`);
    } else if (spec.type === 'boolean') {
      v = v === true || v === 'true';
    } else {
      v = String(v).slice(0, spec.max || 500);
    }
    if (spec.enum && !spec.enum.includes(v)) throw new ToolError(`"${key}" must be one of: ${spec.enum.join(', ')}.`);
    clean[key] = v;
  }
  return clean;
}

async function execute(tool, args) {
  try {
    const result = await tool.run(args);
    return { success: true, result, error: null };
  } catch (e) {
    return { success: false, result: null, error: e instanceof ToolError ? e.message : `${tool.name} failed: ${e.message}` };
  }
}

export async function call(name, rawArgs) {
  const tool = tools.get(name);
  if (!tool) return { success: false, result: null, error: `Unknown tool "${name}".` };
  let args;
  try {
    args = validate(tool, rawArgs);
  } catch (e) {
    return { success: false, result: null, error: e.message };
  }
  if (tool.risk === 'confirm') {
    const prompt = typeof tool.confirm === 'function' ? await tool.confirm(args) : `Run ${name}?`;
    if (prompt && typeof prompt === 'object' && prompt.error) return { success: false, result: null, error: prompt.error };
    const confirmId = crypto.randomUUID();
    pending.set(confirmId, { name, args, prompt, expires: Date.now() + 90e3 });
    return { success: false, result: null, error: null, needsConfirmation: true, confirmId, prompt };
  }
  return execute(tool, args);
}

// Runs a previously requested sensitive action — only with the exact id the server issued.
export async function confirm(confirmId, approved) {
  const p = pending.get(confirmId);
  pending.delete(confirmId);
  if (!p || p.expires < Date.now()) return { success: false, result: null, error: 'That confirmation expired. Please ask again.' };
  if (!approved) return { success: true, result: { cancelled: true, message: 'Cancelled.' }, error: null };
  return execute(tools.get(p.name), p.args);
}

// Catalogue for the HUD and for Ollama tool calling.
export function catalog({ serverOnly = true } = {}) {
  return [...tools.values()].map((t) => ({
    name: t.name, category: t.category, description: t.description, risk: t.risk,
    params: t.params, server: serverOnly,
  }));
}

export function ollamaSchema(names) {
  return [...tools.values()]
    .filter((t) => !names || names.includes(t.name))
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.params).map(([k, s]) => [k, { type: s.type, description: s.description, ...(s.enum ? { enum: s.enum } : {}) }])),
          required: Object.entries(t.params).filter(([, s]) => s.required).map(([k]) => k),
        },
      },
    }));
}
