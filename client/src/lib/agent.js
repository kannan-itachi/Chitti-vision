// The agent executes tool steps from the intent router or the Ollama planner:
// status in the HUD → confirmation for sensitive actions → run → follow-up (summaries,
// links, cards) → one concise spoken report. It never claims success for a failed step.
import { store, nid } from '../store';
import { runTool, serverTool, confirmTool, planWithModel, isHere } from './tools';
import { speech } from './speech';
import { sfx } from './sfx';

const LABELS = {
  open_app: (a) => `Open ${a.app}`, close_app: (a) => `Close ${a.app}`, focus_app: (a) => `Switch to ${a.app}`, open_url: (a) => `Open ${short(a.url)}`,
  open_folder: (a) => `Open ${a.folder}`, open_file: () => 'Open file', open_best_file: (a) => `Open ${a.latest ? 'latest ' : ''}${a.query || a.type || 'file'}`,
  search_files: (a) => `Search files: ${a.query || a.type}`, recent_files: (a) => `Recent ${a.type || 'files'}`, search_file_contents: (a) => `Search inside files: "${a.text}"`,
  read_file_by_name: (a) => `Read ${a.name}`, delete_by_name: (a) => `Delete ${a.name}`, web_search: (a) => `Web search: ${a.query}`, official_website: (a) => `Find ${a.name} website`,
  youtube_search: (a) => `YouTube: ${a.query}`, route_info: (a) => `Route ${isHere(a.from) ? 'from here' : a.from} → ${a.to}`, navigate_to: (a) => `Navigate to ${a.destination}`,
  nearby_places: (a) => `Nearest ${a.kind}`, current_location: () => 'Get location', set_location: (a) => `Set location: ${a.place}`, analyze_screen: () => 'Analyse screen',
  calculate: () => 'Calculate', convert_units: () => 'Convert units', solve_equation: () => 'Solve equation', date_calc: () => 'Date calculation', power: (a) => a.action,
};
const short = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 30);
const label = (s) => (LABELS[s.tool] ? LABELS[s.tool](s.args || {}) : s.tool.replace(/_/g, ' '));

let hooks = { reply: null, askBrain: null, showCard: null };
export const setAgentHooks = (h) => { hooks = { ...hooks, ...h }; };

function setStep(i, patch) {
  store().set((s) => (s.task ? { task: { ...s.task, steps: s.task.steps.map((x, j) => (j === i ? { ...x, ...patch } : x)) } } : {}));
}

// ---------- confirmation & choices (answered by voice, typing or buttons) ----------

let pendingConfirm = null;
export function askConfirmation(prompt) {
  return new Promise((resolve) => {
    pendingConfirm = resolve;
    store().set({ confirm: { prompt } });
    sfx.alert();
    hooks.reply(prompt);
    setTimeout(() => { if (pendingConfirm === resolve) answerConfirmation(false, true); }, 60e3);
  });
}

export function answerConfirmation(yes, timedOut = false) {
  const r = pendingConfirm;
  pendingConfirm = null;
  store().set({ confirm: null });
  if (timedOut) hooks.reply('No answer, so I cancelled that.');
  r?.(yes);
}

export const hasPendingConfirmation = () => !!pendingConfirm;
export const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|confirm|confirmed|do it|go ahead|proceed|continue|please do|affirmative|y)\b/i;
export const NO = /^(no|nope|nah|cancel|stop|don'?t|do not|abort|never ?mind|negative|n)\b/i;

const ORDINAL = { first: 0, '1': 0, one: 0, '1st': 0, second: 1, '2': 1, two: 1, '2nd': 1, third: 2, '3': 2, three: 2, '3rd': 2, fourth: 3, '4': 3, fifth: 4, '5': 4, last: -1 };
export function pickChoice(text) {
  const choices = store().session.pendingChoice;
  if (!choices?.length) return null;
  const m = text.toLowerCase().match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|[1-5]|one|two|three)\b/);
  if (!m) return null;
  const idx = ORDINAL[m[1]];
  return idx === -1 ? choices.at(-1) : choices[idx] || null;
}

// ---------- composite HUD steps ----------

async function resolveFileByName(name) {
  const r = await serverTool('search_files', { query: name });
  if (!r.success) return { error: r.error };
  const files = r.result.data.files || [];
  const exact = files.filter((f) => f.name.toLowerCase().replace(/\.[^.]+$/, '') === name.toLowerCase() || f.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { file: exact[0] };
  if (files.length === 1) return { file: files[0] };
  if (!files.length) return { error: `I could not find anything called "${name}".` };
  return { choices: files.slice(0, 5) };
}

async function runComposite(step) {
  if (step.tool === 'delete_by_name' || step.tool === 'read_file_by_name') {
    const found = await resolveFileByName(step.args.name);
    if (found.error) return { success: false, error: found.error };
    if (found.choices) {
      store().merge('session', { pendingChoice: found.choices.map((f) => f.path), pendingAction: step.tool === 'delete_by_name' ? 'delete' : 'read' });
      return { success: true, result: { say: `I found several matches: ${found.choices.slice(0, 3).map((f, i) => `${i + 1}, ${f.name} in ${f.folder.split(/[\\/]/).pop()}`).join('; ')}. Which one?`, data: { choices: found.choices } } };
    }
    if (step.tool === 'delete_by_name') return serverTool('delete_path', { path: found.file.path });
    const read = await serverTool('read_file', { path: found.file.path });
    if (read.success) read.result.data.summarize = step.args.summarize;
    return read;
  }
  return null;
}

// ---------- follow-ups that turn raw results into a good answer ----------

async function followUp(step, res, ctx) {
  const data = res.result?.data;
  if (!data) return null;
  switch (step.tool) {
    case 'web_search': {
      const links = (data.results || []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, site: r.site }));
      if (step.args.open && data.results?.[0]) await serverTool('open_url', { url: data.results[0].url });
      if (store().backend.ai && (data.page?.text || data.results?.length)) {
        const text = [data.page && `From ${data.page.site} (${data.page.title}):\n${data.page.text}`, 'Search results:', ...data.results.map((r) => `- ${r.title} (${r.site}): ${r.snippet}`)].filter(Boolean).join('\n');
        await hooks.askBrain(ctx.question || step.args.query, { reference: { title: `web search for "${step.args.query}"`, text }, links });
        return { handled: true };
      }
      hooks.reply(`Here is what I found for ${step.args.query}: ${data.results.slice(0, 3).map((r) => `${r.title}, from ${r.site}. ${r.snippet.slice(0, 140)}`).join(' ')}`, { links });
      return { handled: true };
    }
    case 'youtube_search':
    case 'navigation_link': {
      const opened = await serverTool('open_url', { url: data.url });
      if (!opened.success) return { extra: ` But I could not open it: ${opened.error}` };
      return null;
    }
    case 'official_website':
      if (step.args.open || /\bopen\b/.test(ctx.text || '')) await serverTool('open_url', { url: data.url });
      return { links: [{ title: data.title, url: data.url, site: data.site }] };
    case 'route_info':
      hooks.showCard?.({ kind: 'map', term: `${data.from.short} → ${data.to.short}`, source: 'OPENSTREETMAP', text: res.result.say, url: data.url, description: data.via?.length ? `via ${data.via.join(', ')}` : '' });
      return { links: [{ title: 'Open route in Google Maps', url: data.url, site: 'maps.google.com' }] };
    case 'nearby_places':
      hooks.showCard?.({ kind: 'map', term: `Nearest ${data.kind}`, source: 'OPENSTREETMAP', text: data.places.map((p, i) => `${i + 1}. ${p.name || data.kind} — ${p.km < 1 ? `${Math.round(p.km * 1000)} m` : `${p.km.toFixed(1)} km`}`).join('\n'), url: data.searchUrl });
      return { links: data.places.slice(0, 3).map((p) => ({ title: p.name || data.kind, url: p.url, site: 'maps.google.com' })) };
    case 'search_files':
    case 'recent_files':
    case 'search_file_contents':
      if (data.files?.length > 1) store().merge('session', { pendingChoice: data.files.slice(0, 5).map((f) => f.path), pendingAction: 'open' });
      return { files: data.files?.slice(0, 5) };
    case 'open_best_file':
      if (data.needsChoice) store().merge('session', { pendingChoice: data.choices.map((f) => f.path), pendingAction: 'open' });
      return { files: data.needsChoice ? data.choices : null };
    case 'read_file':
    case 'read_file_by_name':
      if (data.summarize !== false && store().backend.ai) {
        await hooks.askBrain(`Summarise the document "${data.name}" in four or five spoken sentences.`, { reference: { title: data.name, text: data.text } });
        return { handled: true };
      }
      return null;
    case 'analyze_screen':
      hooks.showCard?.({
        kind: 'screen', term: data.app || 'Screen', source: 'SCREEN ANALYSIS',
        text: [data.page && `Page: ${data.page}`, data.activity && `Activity: ${data.activity}`, data.errors?.length && `Errors: ${data.errors.join(' | ')}`,
          data.dialogs?.length && `Dialogs: ${data.dialogs.join(', ')}`, data.buttons?.length && `Buttons (inferred): ${data.buttons.join(', ')}`,
          data.importantText?.length && `Visible text:\n${data.importantText.join('\n')}`].filter(Boolean).join('\n'),
      });
      return null;
    default:
      return null;
  }
}

// ---------- the executor ----------

export async function runSteps(steps, { text, channel, source = 'router' } = {}) {
  const task = { id: nid(), text, source, status: 'running', steps: steps.map((s) => ({ ...s, label: label(s), status: 'pending' })) };
  store().set({ task });
  store().merge('session', { task: steps.length > 1 ? text : store().session.task, pendingChoice: null });
  const says = [];
  const links = [];
  const files = [];
  let failed = null;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    setStep(i, { status: 'running' });
    let res = await runComposite(s);
    if (!res) res = await runTool(s.tool, s.args);

    if (res.needsConfirmation) {
      setStep(i, { status: 'confirm' });
      const yes = await askConfirmation(res.prompt);
      res = await confirmTool(res.confirmId, yes);
      if (res.success && res.result?.cancelled) {
        setStep(i, { status: 'cancelled' });
        says.push('Okay, I did not do it.');
        failed = 'cancelled';
        break;
      }
    }
    if (!res.success) {
      setStep(i, { status: 'failed', error: res.error });
      failed = res.error;
      break;
    }
    setStep(i, { status: 'done', say: res.result?.say });
    store().merge('session', { last: res.result?.say });
    const f = await followUp(s, res, { text, question: steps.length === 1 ? text : null });
    if (f?.handled) continue;
    if (res.result?.say) says.push(res.result.say + (f?.extra || ''));
    if (f?.links) links.push(...f.links);
    if (f?.files) files.push(...f.files);
  }

  const doneCount = store().task?.steps.filter((x) => x.status === 'done').length || 0;
  if (failed && failed !== 'cancelled') {
    sfx.alert();
    says.push(doneCount ? `Then I hit a problem: ${failed}` : failed);
  } else if (!failed && steps.length > 1) {
    sfx.done();
  }
  if (says.length) hooks.reply(says.join(' '), { links, files });
  store().set((st) => ({ task: st.task && { ...st.task, status: failed ? (failed === 'cancelled' ? 'cancelled' : 'failed') : 'done' } }));
  setTimeout(() => { if (store().task?.id === task.id) store().set({ task: null }); }, 6000);
  return !failed;
}

// ---------- planner fallback (Ollama tool calling) ----------

const PLACEHOLDER = /^(none|null|undefined|n\/a|na|unknown|string|\[.*\]|<.*>|your .*|example.*)$/i;
const FAKE_PATH = /\\users\\(user|username|\[|<|your|name)|\[username\]|<user>|c:\\path\\to|example/i;

// Clean what a small local model proposes: drop placeholder values, invented paths and
// mismatched tools, so only well-formed, plausible steps can run.
export function sanitizePlan(steps, text) {
  const t = text.toLowerCase();
  const out = [];
  for (const s of steps || []) {
    const args = {};
    for (const [k, v] of Object.entries(s.args || {})) {
      if (v == null || (typeof v === 'string' && (PLACEHOLDER.test(v.trim()) || !v.trim()))) continue;
      if (typeof v === 'string' && FAKE_PATH.test(v)) continue;
      args[k] = v === 'true' ? true : v === 'false' ? false : v;
    }
    let tool = s.tool;
    if (tool === 'open_best_file' && /application|app|program/.test(String(s.args?.type || '')) && args.query) { tool = 'open_app'; args.app = args.query; }
    if (['open_file', 'read_file', 'delete_path', 'move_path', 'rename_path', 'file_info', 'copy_path'].includes(tool) && !args.path && !args.from) continue; // needs a real path
    if (['delete_path', 'move_path', 'rename_path', 'power', 'close_app'].includes(tool) && !/\b(delete|remove|trash|move|rename|shut|restart|reboot|sleep|close|quit|exit)\b/.test(t)) continue;
    if (tool === 'file_info' && /storage|space|disk/.test(t)) tool = 'disk_usage';
    if (['open_best_file', 'search_files'].includes(tool) && !args.query && !args.type && !args.latest) continue; // nothing to look for
    for (const k of ['from', 'to', 'near']) if (typeof args[k] === 'string' && /^(here|current.?location|my location|me)$/i.test(args[k])) args[k] = 'CURRENT_LOCATION';
    if (tool === 'nearby_places' && !args.near) args.near = 'CURRENT_LOCATION';
    out.push({ tool, args, category: 'AUTOMATION' });
  }
  return out;
}

export async function planAndRun(text, { channel } = {}) {
  const s = store();
  store().set({ task: { id: nid(), text, source: 'planner', status: 'planning', steps: [] } });
  let planned;
  try {
    planned = await planWithModel(text, { location: !!s.session.location, task: s.session.task, last: s.session.last });
  } catch {
    planned = { steps: [] };
  }
  const steps = sanitizePlan(planned.steps, text);
  if (!steps.length) {
    store().set({ task: null });
    return false; // nothing actionable: let the conversation flow answer
  }
  await runSteps(steps, { text, channel, source: 'planner' });
  return true; // handled (runSteps reports success or failure itself)
}
