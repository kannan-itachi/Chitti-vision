// Intent parser. Order matters: specific phrases first, so "stop talking" never
// stops the camera and "scan file" never triggers an area scan (both were bugs
// in the original if/else chain). Anything unmatched goes to the AI brain.
const R = [
  [/^(help|commands|what can you do|what are your (commands|features))\b/, () => ({ intent: 'help' })],

  [/\b(stop talking|be quiet|silence|shut up|stop speaking)\b/, () => ({ intent: 'hush' })],
  [/^(mute|voice off|mute voice)\b/, () => ({ intent: 'mute', on: true })],
  [/^(unmute|voice on|unmute voice|speak again)\b/, () => ({ intent: 'mute', on: false })],
  [/\bwake ?word (on|off)\b/, (m) => ({ intent: 'wake', on: m[1] === 'on' })],

  [/\b(open|upload|scan|load|retrieve|read)\s+(a\s+|the\s+|new\s+)?(file|document|doc|pdf)\b/, () => ({ intent: 'upload' })],
  [/^(question|ask)\s*[:\-]?\s+(.+)/, (m) => ({ intent: 'docQuestion', q: m[2] })],
  [/^(wiki|wikipedia)\s*[:\-]?\s+(.+)/, (m) => ({ intent: 'wiki', q: m[2] })],
  [/^(search wikipedia for|look up|lookup)\s+(.+)/, (m) => ({ intent: 'wiki', q: m[2] })],

  [/^(start|activate|enable|open|turn on)\s+(the\s+)?(vision|camera|eyes|scanner|optics)\b|^(start|activate|vision on)$/, () => ({ intent: 'visionOn' })],
  [/^(stop|deactivate|disable|close|turn off)\s+(the\s+)?(vision|camera|eyes|scanner|optics)\b|^(stop|vision off)$/, () => ({ intent: 'visionOff' })],

  [/^(?:please\s+)?(?:learn|remember|memori[sz]e|save|register)\s+(?:this|that|it|him|her|me)\s+(?:as|is)\s+(?:a |an |the )?(.+)$|^this is my (.+)$/,
    (m) => ({ intent: 'learn', label: (m[1] || `my ${m[2]}`).trim() })],
  [/^forget (?:the |this )?(?:object |thing )?(?!everything|all\b|about|me\b|my name|(?:the )?(?:current )?(?:task|session)\b)(.+)$/, (m) => ({ intent: 'forgetObject', label: m[1].trim() })],
  [/\b(what (have you|did you) learn(ed)?|what objects do you (know|recogni[sz]e)|learned objects)\b/, () => ({ intent: 'learnedList' })],
  [/\b(what colou?r is (this|that|it)|which colou?r|what colou?r am i (holding|wearing))\b/, () => ({ intent: 'color' })],
  [/^(what(?:'s| is) (this|that|it)|identify( this| that| it)?|what am i (holding|showing you)|what is in my hand|recogni[sz]e (this|that|it)|do you know what this is)$/, () => ({ intent: 'identify' })],
  [/\b(what (do|can) you see|what'?s (in front of|around) (me|you)|describe (the |this |my )?(scene|view|room|surroundings|frame|picture|image)|analy[sz]e (the |this )?(scene|view|frame|image|surroundings)|look at (this|me)|what am i wearing)\b/,
    (m, raw) => ({ intent: 'analyze', q: raw })],
  [/^(open |show )?settings$|^(open|show) (the )?(settings|preferences|config)/, () => ({ intent: 'settings' })],
  [/\b(thinking|thoughts|self[- ]thinking|autonomy) (on|off)\b|\b(stop|start) thinking\b/, (m) => ({ intent: 'thinking', on: m[2] ? m[2] === 'on' : m[3] === 'start' })],
  [/^scan$|\bscan (the )?(area|room|surroundings|environment)\b|^(run|start) (a )?scan\b/, () => ({ intent: 'scan' })],

  [/\b(release|unlock|drop|clear)\s+(the\s+)?(target|lock)\b|^unlock$/, () => ({ intent: 'release' })],
  [/^(please\s+)?lock(?!\s+(?:my\s+|the\s+)?(?:computer|pc|laptop|screen|system|workstation)\b)(\s+on)?(\s+to)?(\s+the)?(\s+target)?\s*([a-z ]*)$/, (m) => ({ intent: 'lock', cls: m[6].trim() || null })],

  [/\bauto(matic)?[ -]?(mode|switch(ing)?|protocol) (on|off)\b|\b(enable|disable) auto(matic)? ?mode\b/, (m) => ({ intent: 'autoMode', on: m[4] ? m[4] === 'on' : m[5] === 'enable' })],
  [/\b((combat|attack|evil|war)\s*(mode|protocol)|red ?chip( mode)?)\b/, () => ({ intent: 'mode', mode: 'combat' })],
  [/\b(calm|good|friendly|normal|green ?chip|peace)\s*(mode|protocol)\b/, () => ({ intent: 'mode', mode: 'calm' })],
  [/\b(research|analysis|science)\s*(mode|protocol)\b/, () => ({ intent: 'mode', mode: 'research' })],

  [/\brecord mode (on|off)\b/, (m) => ({ intent: 'record', on: m[1] === 'on' })],
  [/\b(show|recall|read) (the )?(memory|records|scan log|scans)\b/, () => ({ intent: 'recall' })],
  [/\bclear (the )?(memory|records|scan log)\b/, () => ({ intent: 'clearRecords' })],

  [/^set (the )?mission\s*(to|:)?\s*(.*)$/, (m) => ({ intent: 'missionSet', text: m[3] })],
  [/\b(mission status|what is (my|the) mission|current mission)\b/, () => ({ intent: 'missionStatus' })],
  [/\b(clear|cancel|abort) (the )?missions?\b/, () => ({ intent: 'missionClear' })],

  [/\b(threat|danger) (level|status|report)\b/, () => ({ intent: 'threat' })],
  [/\b(battery|power level|charge level)\b/, () => ({ intent: 'battery' })],
  [/\b(system check|diagnostics|status report|self test)\b/, () => ({ intent: 'diagnostics' })],
  [/\b(announcements?|callouts?) (on|off)\b/, (m) => ({ intent: 'announce', on: m[2] === 'on' })],

  [/\bclear (the )?(chat|conversation|comms|log)\b/, () => ({ intent: 'clearChat' })],
  [/\b(what did i say|conversation history|repeat that)\b/, () => ({ intent: 'history' })],
];

export function parse(raw) {
  const text = raw.toLowerCase().replace(/[?!.]+$/, '').trim();
  for (const [re, make] of R) {
    const m = text.match(re);
    if (m) return make(m, raw.trim());
  }
  return null;
}

export const HELP = [
  ['start vision / stop vision', 'camera + object detection'],
  ['what do you see?', 'describe the whole scene'],
  ['what is this?', 'identify what you hold up (offline)'],
  ['learn this as my fan', 'teach Chitti a new object · forget fan'],
  ['what color is this?', 'colour of the object in front'],
  ['where is my bottle?', 'last place Chitti saw something'],
  ['my name is … · remember that …', 'personal memory'],
  ['set a timer for 5 minutes', 'timers and reminders · 12 times 7'],
  ['scan', 'quick summary of detected targets'],
  ['lock target [person]', 'lock onto a target · release target'],
  ['upload file', 'scan TXT, MD, JSON, CSV, PDF or DOCX'],
  ['question: …', 'answer from your documents'],
  ['wiki <topic>', 'Wikipedia briefing'],
  ['red chip / calm mode / research mode', 'switch protocol'],
  ['set mission …', 'mission status · clear mission'],
  ['record mode on · show records', 'persistent scan memory'],
  ['battery · threat level · system check', 'telemetry reports'],
  ['stop talking · mute · wake word on', 'voice control'],
  ['thinking on · thinking off', 'self-thinking thought stream'],
  ['auto mode on · auto mode off', 'automatic protocol switching'],
  ['what is India · explain more', 'research anything, then follow up'],
  ['settings', 'voice, volume, detection quality'],
  ['anything else', 'open conversation with Chitti'],
];

export const QUICK = ['what is this?', 'what do you see?', 'where is my phone?', 'scan', 'lock target', 'system check', 'tell me a joke', 'red chip mode'];
