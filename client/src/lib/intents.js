// Deterministic intent router: natural phrasing → categorised tool steps, with no model call.
// Handles multi-step requests ("open Chrome and search for Python tutorials") by splitting
// on "and"/"then" when every part is understood. Returns null when unsure, so the caller can
// fall back to the existing conversation flow or the Ollama planner.
import { parseConversion } from './calc';
import { dateCalc } from './calc';

// Apps the server can launch (names/aliases mirror server/src/tools/apps.js).
const APP_WORDS = {
  chrome: 'chrome', 'google chrome': 'chrome', browser: 'chrome', 'my browser': 'chrome', 'web browser': 'chrome', 'the browser': 'chrome', 'the internet': 'chrome',
  edge: 'edge', 'microsoft edge': 'edge', firefox: 'firefox', 'vs code': 'vscode', vscode: 'vscode', 'visual studio code': 'vscode', 'code editor': 'vscode',
  notepad: 'notepad', calculator: 'calculator', calc: 'calculator', paint: 'paint', 'ms paint': 'paint', 'file explorer': 'explorer', explorer: 'explorer',
  'file manager': 'explorer', 'my files': 'explorer', word: 'word', 'ms word': 'word', 'microsoft word': 'word', excel: 'excel', 'ms excel': 'excel', 'microsoft excel': 'excel',
  powerpoint: 'powerpoint', 'power point': 'powerpoint', spotify: 'spotify', 'windows settings': 'settings', 'system settings': 'settings', 'pc settings': 'settings',
  'control panel': 'settings', 'task manager': 'taskmanager', terminal: 'terminal', 'command prompt': 'terminal', cmd: 'terminal', powershell: 'terminal',
  whatsapp: 'whatsapp', 'microsoft store': 'store', 'windows store': 'store', photos: 'photos', clock: 'clock', 'snipping tool': 'snippingtool',
};
const SITES = {
  youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com', github: 'https://github.com',
  facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com', 'whatsapp web': 'https://web.whatsapp.com', chatgpt: 'https://chatgpt.com',
  wikipedia: 'https://www.wikipedia.org', amazon: 'https://www.amazon.in', flipkart: 'https://www.flipkart.com', netflix: 'https://www.netflix.com',
  linkedin: 'https://www.linkedin.com', 'stack overflow': 'https://stackoverflow.com', stackoverflow: 'https://stackoverflow.com', 'google maps': 'https://maps.google.com',
  maps: 'https://maps.google.com', twitter: 'https://x.com', x: 'https://x.com', reddit: 'https://www.reddit.com', 'google drive': 'https://drive.google.com',
  drive: 'https://drive.google.com', outlook: 'https://outlook.live.com', 'google classroom': 'https://classroom.google.com', classroom: 'https://classroom.google.com',
};
const FOLDERS = ['downloads', 'download', 'documents', 'my documents', 'desktop', 'pictures', 'photos folder', 'music', 'videos', 'home folder', 'project', 'project folder', 'my project', 'onedrive', 'screenshots'];
const FILE_TYPES = 'pdf|pdfs|document|documents|doc|docx|word file|word document|spreadsheet|excel file|presentation|ppt|powerpoint file|image|images|photo|photos|picture|video|videos|audio|song|songs|music file|zip|file';

const clean = (s) => s.toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim();
const strip = (s) => s.replace(/^(please |can you |could you |would you |will you |i want (you )?to |i'd like (you )?to |i need (you )?to |kindly |just |go ahead and |help me )+/, '').replace(/ (please|for me|now|right now|quickly)$/, '').trim();
const typeOf = (w) => {
  if (!w) return undefined;
  const t = w.replace(/s$/, '');
  return { photo: 'image', picture: 'image', song: 'audio', 'music file': 'audio', 'word file': 'doc', 'word document': 'doc', 'excel file': 'spreadsheet', ppt: 'presentation', 'powerpoint file': 'presentation', file: undefined }[t] ?? t;
};
const step = (tool, args = {}, category) => ({ tool, args, category });

// ---------- single-intent matchers ----------

const RULES = [
  // ── MEMORY (session only) ──
  [/^(?:remember|note|keep in mind)(?: this| that)? for (?:this|the) session[:,]?\s*(.+)$|^for this session,? remember (?:that )?(.+)$/, (m) => [step('remember_session', { note: m[1] || m[2] }, 'MEMORY')]],
  [/^(forget|clear|cancel) (the |my )?(current )?(task|session)( notes)?$/, () => [step('forget_task', {}, 'MEMORY')]],

  // ── SCREEN ──
  [/^(?:analy[sz]e|check|scan|look at|describe|read|inspect) (?:my |the )?(?:screen|display|desktop|monitor)(?: (?:in|after) (\d+) seconds?)?$/, (m) => [step('analyze_screen', { delay: m[1] ? Number(m[1]) : 0 }, 'SCREEN')]],
  [/^what(?:'s| is) on (?:my |the )?screen$|^what am i (?:looking at|working on|doing on (?:my |the )?(?:computer|pc|laptop))$|^what (?:app|application|program) am i using$|^is there (?:an |any )?error on (?:my |the )?screen$/, () => [step('analyze_screen', {}, 'SCREEN')]],
  [/^read (?:the )?text on (?:my |the )?screen$|^read (?:my |the )?screen(?: text)?$/, () => [step('read_screen_text', {}, 'SCREEN')]],
  [/^(?:which|what) (?:window|windows|apps|applications|programs) (?:is|are) (?:open|active|running)$|^list (?:open |my )?windows$/, () => [step('list_windows', {}, 'SCREEN')]],
  [/^(?:take|capture|grab) (?:a )?screen ?shot$|^screen ?shot$/, () => [step('take_screenshot', {}, 'SCREEN')]],

  // ── SYSTEM ──
  [/^(?:system|computer|pc|laptop) (?:status|health|info|information|report)$|^how(?:'s| is) my (?:computer|pc|laptop|system)(?: doing)?$/, () => [step('system_status', {}, 'SYSTEM')]],
  [/(?:how much|what(?:'s| is)) (?:ram|memory)|(?:ram|memory) (?:usage|used|am i using)|what(?:'s| is) (?:using|eating|taking) (?:up )?(?:my |all my )?(?:ram|memory)/, () => [step('memory_usage', {}, 'SYSTEM')]],
  [/(?:cpu|processor) (?:usage|load)|what(?:'s| is) using (?:my |the )?cpu|(?:top|heavy|running) (?:processes|apps|programs)/, () => [step('top_processes', { by: 'cpu' }, 'SYSTEM')]],
  [/(?:how much|what(?:'s| is)(?: my)?) (?:storage|disk space|free space|space)|(?:disk|storage|drive) (?:usage|space|full)|is my (?:disk|drive|storage) (?:almost )?full/, () => [step('disk_usage', {}, 'SYSTEM')]],
  [/why is my (?:computer|pc|laptop|system) (?:so )?(?:slow|lagging|hanging)|(?:computer|pc|laptop) is (?:slow|lagging|hanging)/, () => [step('diagnose_slowness', {}, 'SYSTEM')]],
  [/^(?:am i (?:online|connected)|(?:internet|network|wi-?fi|wifi) (?:status|connection|signal)|(?:what(?:'s| is) )?my (?:ip|ip address|wi-?fi|wifi network)|is (?:the )?internet (?:working|on))$/, () => [step('network_status', {}, 'SYSTEM')]],
  [/bluetooth/, () => [step('bluetooth_status', {}, 'SYSTEM')]],
  [/^(?:turn |increase |raise )?(?:the )?volume up$|^(?:increase|raise) (?:the )?volume$|^louder$/, () => [step('volume', { action: 'up' }, 'SYSTEM')]],
  [/^(?:turn |decrease |lower )?(?:the )?volume down$|^(?:decrease|lower|reduce) (?:the )?volume$|^quieter$/, () => [step('volume', { action: 'down' }, 'SYSTEM')]],
  [/^(?:mute|unmute) (?:the )?(?:volume|sound|audio|computer|pc|speakers)$/, () => [step('volume', { action: 'mute' }, 'SYSTEM')]],
  [/^set (?:the )?volume (?:to )?(\d{1,3})(?: ?%| percent)?$|^volume (\d{1,3})(?: ?%| percent)?$/, (m) => [step('volume', { action: 'set', level: Number(m[1] || m[2]) }, 'SYSTEM')]],
  [/^set (?:the )?brightness (?:to )?(\d{1,3})(?: ?%| percent)?$|^brightness (\d{1,3})(?: ?%| percent)?$/, (m) => [step('brightness', { level: Number(m[1] || m[2]) }, 'SYSTEM')]],
  [/^(?:what(?:'s| is) (?:the |my )?)?(?:screen )?brightness(?: level)?$/, () => [step('brightness', {}, 'SYSTEM')]],
  [/^lock (?:my |the )?(?:computer|pc|laptop|screen|system)$/, () => [step('lock_screen', {}, 'SYSTEM')]],
  [/^(?:shut ?down|turn off|power off|switch off) (?:my |the )?(?:computer|pc|laptop|system)$|^shut ?down$/, () => [step('power', { action: 'shutdown' }, 'SYSTEM')]],
  [/^(?:restart|reboot) (?:my |the )?(?:computer|pc|laptop|system)$|^(?:restart|reboot)$/, () => [step('power', { action: 'restart' }, 'SYSTEM')]],
  [/^(?:put (?:my |the )?(?:computer|pc|laptop) to sleep|sleep (?:my |the )?(?:computer|pc|laptop))$/, () => [step('power', { action: 'sleep' }, 'SYSTEM')]],
  [/^(?:cancel|abort|stop) (?:the )?(?:shutdown|restart|reboot)$/, () => [step('cancel_shutdown', {}, 'SYSTEM')]],
  [/^what(?:'s| is) (?:on|in) my clipboard$|^read (?:my |the )?clipboard$/, () => [step('clipboard_read', {}, 'SYSTEM')]],
  [/^copy ["“]?(.+?)["”]? to (?:the |my )?clipboard$/, (m) => [step('clipboard_write', { text: m[1] }, 'SYSTEM')]],
  [/^(?:notify me|send (?:me )?a notification|show (?:a |me a )?notification)(?: that| saying| to)?[:,]? (.+)$/, (m) => [step('notify', { message: m[1] }, 'SETTINGS')]],

  // ── LOCATION & MAPS ──
  [/^(?:where am i|what(?:'s| is) my (?:current )?location|find my (?:current )?location|(?:get|show|tell me) my (?:current )?location|my (?:current )?location)$/, () => [step('current_location', {}, 'LOCATION')]],
  [/^(?:i am|i'm|im) (?:in|at|near) (.+)$|^(?:my location is|set my location to|use) (.+?)(?: as my location)?$/, (m) => (m[2] && !/as my location|^my location is|location to/.test(m.input) ? null : [step('set_location', { place: m[1] || m[2] }, 'LOCATION')])],
  [/^(?:take me to|navigate to|navigate (?:me )?from (?:my current location|here) to|directions to|get me to|drive me to|show (?:me )?(?:the )?(?:route|way|directions) to|guide me to|start navigation to) (.+?)(?: by (car|walking|foot|bike|cycling|bus|train|transit))?$/, (m) => [step('navigate_to', { destination: m[1], mode: modeOf(m[2]) }, 'MAPS'), step('route_info', { from: 'CURRENT_LOCATION', to: m[1], mode: modeOf(m[2]) === 'transit' ? 'driving' : modeOf(m[2]) }, 'MAPS')]],
  [/^(?:how far is|what(?:'s| is) the distance (?:from here )?to|distance (?:from here )?to|how far (?:away )?is it to) (.+?)(?: from here| from me)?$/, (m) => (/ from /.test(m[1]) ? null : [step('route_info', { from: 'CURRENT_LOCATION', to: m[1] }, 'MAPS')])],
  [/^how long (?:will it|would it|does it) take (?:me )?to (reach|get to|go to|drive to|walk to|cycle to) (.+?)(?: from here)?$/, (m) => [step('route_info', { from: 'CURRENT_LOCATION', to: m[2], mode: /walk/.test(m[1]) ? 'walking' : /cycle/.test(m[1]) ? 'cycling' : 'driving' }, 'MAPS')]],
  [/^(?:what(?:'s| is) the )?(?:distance|route) (?:between|from) (.+?) (?:and|to) (.+?)(?: by (car|walking|foot|bike|cycling))?$|^(?:calculate|find|show|get) (?:the |a )?(?:distance|route) (?:between|from) (.+?) (?:and|to) (.+)$|^how far is (.+?) from (.+)$/, (m) => {
    const a = m[1] || m[4] || m[7];
    const b = m[2] || m[5] || m[6];
    const [from, to] = m[6] ? [b, a] : [a, b];
    return [step('route_info', { from, to, mode: modeOf(m[3]) === 'transit' ? 'driving' : modeOf(m[3]) }, 'MAPS')];
  }],
  [/^(?:find |show |where is |where's |search for |locate )?(?:me )?(?:the )?(?:nearest|closest|nearby) (.+?)(?: near me| around me| nearby)?$|^(?:find |show |search for )?(?:me )?(.+?) (?:near me|nearby|around me|around here|close to me)$/, (m) => {
    const kind = (m[1] || m[2]).replace(/^(a|an|some|any)\s+/, '');
    return /^(me|you|here)$/.test(kind) ? null : [step('nearby_places', { kind, near: 'CURRENT_LOCATION' }, 'MAPS')];
  }],

  // ── WEB / MEDIA ──
  [/^search (?:my )?(?:computer|pc|laptop|files|documents|drive) for (?:a |any )?(?:files? |documents? )?(?:containing|with|that (?:contains?|mentions?)|mentioning) ["“']?(.+?)["”']?$|^which files? (?:contains?|mentions?) ["“']?(.+?)["”']?$/, (m) => [step('search_file_contents', { text: m[1] || m[2] }, 'FILES')]],
  [/^(?:search|look up|find) (?:on )?youtube (?:for )?(.+)$|^(?:search|find|play|show me) (.+?) on youtube$|^youtube (.+)$/, (m) => [step('youtube_search', { query: m[1] || m[2] || m[3] }, 'MEDIA')]],
  [/^(?:find |open |show |what(?:'s| is) )?(?:me )?the official (?:web ?site|site|page) (?:of|for) (.+)$|^(.+?)(?:'s)? official (?:web ?site|site)$/, (m) => [step('official_website', { name: m[1] || m[2] }, 'WEB_SEARCH')]],
  [/^(?:search|google|bing) (?!(?:my |the )?(?:computer|pc|laptop|files|documents|drive|folder)\b)(?:the web |the internet |online |google )?(?:for |about )?(.+)$|^(?:search (?:the web|online|the internet) for|look up online|find online) (.+)$|^(?:find|get|tell me) (?:the )?(?:latest|recent|current|today's) (.+)$|^(?:find information|find info|get information|search information) (?:about|on) (.+)$|^what(?:'s| is| are) the (?:latest|current|today's) (.+)$/, (m) => [step('web_search', { query: [m[1], m[2], m[3] && `latest ${m[3]}`, m[4], m[5] && `latest ${m[5]}`].find(Boolean) }, 'WEB_SEARCH')]],

  // ── FILES & FOLDERS ──
  [new RegExp(`^(?:open|show|launch|go to|take me to) (?:my |the )?(${FOLDERS.join('|')})(?: folder)?$`), (m) => [step('open_folder', { folder: m[1].replace(/ folder$/, '') }, 'FILES')]],
  [new RegExp(`^(?:open|show me|show) (?:the |my )?(?:latest|newest|most recent|last|recent) (?:downloaded )?(${FILE_TYPES})(?: file)?(?: (?:in|from) (?:my )?(downloads|documents|desktop))?$`), (m) => [step('open_best_file', { type: typeOf(m[1]), latest: true, folder: m[2] }, 'FILES')]],
  [new RegExp(`^(?:show|list|what are) (?:my |the )?(?:recent|latest|newest) (?:files|${FILE_TYPES})(?: (?:in|from) (?:my )?(downloads|documents|desktop))?$|^what did i (?:download|save) recently$`), (m) => [step('recent_files', { folder: m[1] || (/download/.test(m.input) ? 'downloads' : undefined), type: typeOf((m.input.match(new RegExp(`(${FILE_TYPES})`)) || [])[1]) }, 'FILES')]],
  [new RegExp(`^(?:find|search for|search|locate|where is|where's|look for) (?:my |the |a )?(.+?)(?: (${FILE_TYPES}))?(?: (?:in|on) (?:my )?(downloads|documents|desktop|computer|pc|laptop))?$`), (m) => {
    const q = m[1].replace(new RegExp(`\\b(${FILE_TYPES})\\b`, 'g'), '').trim();
    // Only when it clearly concerns files, to avoid stealing "find the nearest…" or "where is my phone" (camera memory).
    if (!m[2] && !/\b(file|files|resume|cv|report|document|assignment|notes|certificate|invoice|pdf|project|presentation|marksheet|photo)\b/.test(m[1])) return null;
    return [step('search_files', { query: q, type: typeOf(m[2]) || (/\bpdf\b/.test(m[1]) ? 'pdf' : undefined), folder: /computer|pc|laptop/.test(m[3] || '') ? undefined : m[3] }, 'FILES')];
  }],
  [/^create (?:a )?(?:new )?folder (?:called |named )?["“']?(.+?)["”']?(?: (?:on|in) (?:my |the )?(desktop|documents|downloads|pictures))?$/, (m) => [step('create_folder', { name: m[1], parent: m[2] || 'desktop' }, 'FILES')]],
  [/^(?:find|show|are there) (?:any )?duplicate(?:s| files)(?: in (?:my )?(downloads|documents|desktop|pictures))?$/, (m) => [step('find_duplicates', { folder: m[1] }, 'FILES')]],
  [/^(?:summari[sz]e|read) (?:the |my )?(?:file|document|pdf) (?:called |named )?["“']?(.+?)["”']?$/, (m) => [step('read_file_by_name', { name: m[1], summarize: /summar/.test(m.input) }, 'FILES')]],
  [/^(?:delete|remove|trash) (?:the |my )?(?:file|folder|document) (?:called |named )?["“']?(.+?)["”']?$/, (m) => [step('delete_by_name', { name: m[1] }, 'FILES')]],

  // ── APPLICATIONS / BROWSER (after files so "open my resume" is not treated as an app) ──
  [/^(?:open|launch|start|run|fire up|bring up|load|show me|show) (?:up )?(?:the |my |a )?(.+?)(?: app| application| program| website| site| page)?$/, (m) => openTarget(m[1])],
  [/^(?:close|quit|exit|kill|shut) (?:down )?(?:the |my )?(.+?)(?: app| application| program| window)?$/, (m) => (APP_WORDS[m[1]] ? [step('close_app', { app: APP_WORDS[m[1]] }, 'APPLICATION')] : null)],
  [/^(?:switch to|focus(?: on)?|go (?:back )?to|bring (?:up |back )?)(?: the| my)? (.+?)(?: window| app)?$/, (m) => (APP_WORDS[m[1]] ? [step('focus_app', { app: APP_WORDS[m[1]] }, 'APPLICATION')] : null)],
  [/^(?:go to|visit|browse to|open (?:the )?(?:website|site)) ((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)$/, (m) => [step('open_url', { url: m[1] }, 'BROWSER')]],

  // ── CALCULATION & LOGIC ──
  [/^(?:convert )?-?\d+(?:\.\d+)?\s*[a-z°/²^ ]+?\s+(?:to|into|in)\s+[a-z°/²^ ]+$/, (m) => {
    const c = parseConversion(m.input);
    return c ? [step('convert_units', c, 'CALCULATION')] : null;
  }],
  [/^(?:solve|find x|find the value of [a-z])\b.*=|^[\dx()+\-*/^ .a-z]*[a-z][\dx()+\-*/^ .]*=\s*-?[\d.x+\-*/^ ()]+$/, (m) => (/[a-z]/.test(m.input.replace(/^(solve|find the value of|find)/, '')) ? [step('solve_equation', { equation: m.input }, 'LOGIC')] : null)],
  [/(\d+(?:\.\d+)?)\s*(%|percent)\s*of\s*\d|what (?:percent|percentage) is|is what (?:percent|percentage) of|(?:increase|decrease) \d+(?:\.\d+)? by \d/, (m) => [step('calculate', { expression: m.input }, 'CALCULATION')]],
  [/^(?:what(?:'s| is)|calculate|compute|evaluate|how much is)?\s*(?:the )?(?:square root|cube root|sqrt)\b.*\d|^(?:what(?:'s| is)|calculate|compute|evaluate|how much is)\s+[-\d(][\d\s.+\-*/^×÷x()%]*(?:plus|minus|times|multiplied by|divided by|to the power of|squared|cubed|[+\-*/^×÷x])[\d\s.+\-*/^×÷x()%a-z]*$|^[-\d(][\d\s.+\-*/^×÷()%]*[+\-*/^×÷][\d\s.+\-*/^×÷()%]*=?$/, (m) => [step('calculate', { expression: m.input.replace(/=$/, '') }, 'CALCULATION')]],
  [/\b(days? (?:between|from|until|till|left|to go)|days? from (?:today|now)|(?:weeks?|months?|years?) from (?:today|now)|\d+ (?:days?|weeks?) ago|what day (?:is|was|will be) \d|what day (?:is|was|will be) [a-z]+ \d|how old am i|born (?:on|in) \d|what time will it be in)\b/, (m) => (dateCalc(m.input) ? [step('date_calc', { question: m.input }, 'CALCULATION')] : null)],
];

const modeOf = (w) => (!w ? 'driving' : /walk|foot/.test(w) ? 'walking' : /bike|cycl/.test(w) ? 'cycling' : /bus|train|transit/.test(w) ? 'transit' : 'driving');

function openTarget(raw) {
  const t = raw.replace(/^(?:up |the |my |a )/, '').trim();
  if (APP_WORDS[t]) return [step('open_app', { app: APP_WORDS[t] }, 'APPLICATION')];
  if (SITES[t]) return [step('open_url', { url: SITES[t] }, 'BROWSER')];
  if (/^(?:https?:\/\/)?[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?$/.test(t)) return [step('open_url', { url: t }, 'BROWSER')];
  if (FOLDERS.includes(t) || FOLDERS.includes(t.replace(/ folder$/, ''))) return [step('open_folder', { folder: t.replace(/ folder$/, '') }, 'FILES')];
  // "open my resume", "open the project report pdf"
  const tm = t.match(new RegExp(`^(.*?)\\s*\\b(${FILE_TYPES})$`));
  if (/\b(resume|cv|report|assignment|notes|certificate|invoice|marksheet|presentation|document|file|pdf|photo)\b/.test(t) || tm) {
    return [step('open_best_file', { query: (tm ? tm[1] : t).replace(/\b(file|document)\b/g, '').trim() || undefined, type: typeOf(tm?.[2]) }, 'FILES')];
  }
  return null;
}

function routeOne(text) {
  const t = strip(clean(text));
  if (!t) return null;
  for (const [re, make] of RULES) {
    const m = t.match(re);
    if (!m) continue;
    m.input = t;
    const steps = make(m);
    if (steps) return steps;
  }
  return null;
}

// ---------- multi-step ----------

const PRONOUN_OPEN = /^(?:and )?(?:open|show|launch) (?:it|that|them|this|the file|the result|the first one)$/;
const SHOW_RESULT = /^(?:and )?(?:show|open|display) (?:me )?(?:the )?(?:result|results|page|answer|it)$/;

export function route(text) {
  const t = strip(clean(text));
  if (!t) return null;
  const whole = routeOne(t);
  const parts = t.split(/\s*(?:,\s*and then|,\s*then|\band then\b|\bthen\b|,\s*and\b|;|,(?=\s*(?:open|search|find|show|take|close|navigate|play|check|analy[sz]e)\b)|\band\b(?=\s*(?:open|search|find|show|take|close|navigate|play|check|analy[sz]e|launch|start|go|tell|lock|mute|set|turn|copy)\b))\s*/).filter(Boolean);
  if (parts.length < 2) return whole ? { steps: whole, category: whole[0].category } : null;

  const steps = [];
  for (const part of parts) {
    const prev = steps.at(-1);
    if (prev && PRONOUN_OPEN.test(part)) {
      if (prev.tool === 'search_files' || prev.tool === 'recent_files') { steps[steps.length - 1] = step('open_best_file', { ...prev.args, latest: prev.tool === 'recent_files' || undefined }, 'FILES'); continue; }
      if (prev.tool === 'web_search') { prev.args.open = true; continue; }
      if (prev.tool === 'official_website') { prev.args.open = true; continue; }
    }
    if (prev && SHOW_RESULT.test(part) && ['web_search', 'official_website', 'youtube_search'].includes(prev.tool)) { prev.args.open = true; continue; }
    const s = routeOne(part);
    if (!s) return whole ? { steps: whole, category: whole[0].category } : null; // one part not understood → not safe to split
    steps.push(...s);
  }
  return { steps, category: steps.length > 1 ? 'AUTOMATION' : steps[0].category };
}

// Does this look like a request for an action (worth asking the planner), not conversation?
export const looksActionable = (t) => /\b(open|launch|start|close|quit|switch|find|search|locate|show|list|take|navigate|directions|distance|route|how far|nearest|near me|screenshot|screen|volume|brightness|mute|lock|shut ?down|restart|file|folder|document|pdf|ram|memory|cpu|disk|storage|battery|wifi|wi-fi|network|bluetooth|clipboard|copy|notify|download|delete|rename|move|install|website|youtube|google|chrome|browser)\b/i.test(t);
