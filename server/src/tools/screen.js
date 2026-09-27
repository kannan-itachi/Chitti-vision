// Screen understanding (Windows): which app/window you're using, what text is visible (offline
// OCR with tesseract.js), likely buttons/menus, visible errors, system dialogs, lock state.
// The HUD itself usually covers the screen, so by default we look at the window *behind* it,
// captured with PrintWindow (works even when it's covered).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { define, ToolError } from './registry.js';
import { powershell, isWindows } from './exec.js';
import { MODELS_DIR } from '../paths.js';
import { resolveApp } from './apps.js';

const SCREEN_CS = String.raw`
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Drawing; using System.Drawing.Imaging;
public class ChittiScreen {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> List() {
    var result = new List<string>(); var fg = GetForegroundWindow();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512); if (t.Length == 0) return true;
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid); RECT r; GetWindowRect(h, out r);
      result.Add(h.ToInt64() + "\t" + pid + "\t" + (IsIconic(h) ? 1 : 0) + "\t" + (h == fg ? 1 : 0) + "\t" + c + "\t" + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + "\t" + t.ToString().Replace("\t", " "));
      return true; }, IntPtr.Zero);
    return result;
  }
  public static string Capture(long hwnd, string file) {
    var h = new IntPtr(hwnd); RECT r; GetWindowRect(h, out r); int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w < 80 || ht < 60) return "small";
    using (var bmp = new Bitmap(w, ht)) {
      using (var g = Graphics.FromImage(bmp)) { var hdc = g.GetHdc(); bool ok = PrintWindow(h, hdc, 2); g.ReleaseHdc(hdc); if (!ok) return "fail"; }
      int same = 0; var first = bmp.GetPixel(w / 2, ht / 2);
      for (int i = 1; i <= 25; i++) { if (bmp.GetPixel(w * (i % 5 + 1) / 7, ht * (i / 5 + 1) / 7) == first) same++; }
      if (same >= 24) return "blank";
      bmp.Save(file, ImageFormat.Png);
    }
    return "ok";
  }
  // Fallback for GPU-drawn windows: copy the window's area from the visible screen.
  public static string CaptureRect(long hwnd, string file) {
    var h = new IntPtr(hwnd); RECT r; GetWindowRect(h, out r); int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w < 80 || ht < 60) return "small";
    using (var bmp = new Bitmap(w, ht)) { using (var g = Graphics.FromImage(bmp)) { g.CopyFromScreen(r.Left, r.Top, 0, 0, bmp.Size); } bmp.Save(file, ImageFormat.Png); }
    return "ok";
  }
}`;

const SCRIPT = `
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')
Add-Type -TypeDefinition $env:CHITTI_CS -ReferencedAssemblies System.Drawing -ErrorAction Stop
[void][ChittiScreen]::SetProcessDPIAware()
$procs = @{}; Get-Process | ForEach-Object { $procs[[uint32]$_.Id] = $_.ProcessName }
$wins = @([ChittiScreen]::List() | ForEach-Object { $f = $_ -split "\`t", 7; [pscustomobject]@{ hwnd=[int64]$f[0]; pid=[uint32]$f[1]; min=($f[2] -eq '1'); fg=($f[3] -eq '1'); cls=$f[4]; size=$f[5]; title=$f[6]; app=$procs[[uint32]$f[1]] } })
$skip = $env:CHITTI_SKIP; $want = $env:CHITTI_APP
$cands = $wins | Where-Object { (-not $_.min) -and ($_.cls -ne 'Progman') -and ($_.cls -ne 'Shell_TrayWnd') -and ($_.title -notmatch $skip) }
if ($want) { $w = [regex]::Escape($want); $cands = $cands | Where-Object { ($_.app -match $w) -or ($_.title -match $w) } }
if ($env:CHITTI_DELAYED -eq '1') { $fgw = $cands | Where-Object { $_.fg } | Select-Object -First 1; if ($fgw) { $target = $fgw } }
if (-not $target) { $target = $cands | Select-Object -First 1 }
$cap = 'none'; if ($target) { $cap = [ChittiScreen]::Capture($target.hwnd, $env:CHITTI_FILE); if ($cap -eq 'blank' -and ($target.fg -or $env:CHITTI_DELAYED -eq '1')) { $cap = [ChittiScreen]::CaptureRect($target.hwnd, $env:CHITTI_FILE) } }
[pscustomobject]@{
  windows = @($wins | Select-Object -First 25 app, title, cls, min, fg, size)
  target = $target; capture = $cap
  locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
  uac = [bool](Get-Process -Name consent -ErrorAction SilentlyContinue)
} | ConvertTo-Json -Depth 4 -Compress`;

// ---------- OCR (tesseract.js, cached language data → offline after first use) ----------

let workerPromise = null;
function ocrWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const cachePath = path.join(MODELS_DIR, 'tesseract');
    fs.mkdirSync(cachePath, { recursive: true });
    // Without errorHandler, tesseract.js re-throws worker errors on process.nextTick and kills the server.
    return createWorker('eng', 1, { cachePath, errorHandler: (e) => console.warn(`  OCR: ${e?.message || e}`) });
  })().catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

export async function ocr(file) {
  const worker = await ocrWorker();
  const { data } = await Promise.race([
    worker.recognize(file, {}, { text: true, blocks: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('text recognition took too long')), 60000)),
  ]);
  const lines = (data.blocks || []).flatMap((b) => b.paragraphs || []).flatMap((p) => p.lines || [])
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), conf: l.confidence }))
    .filter((l) => l.text.length > 1 && l.conf > 55 && /[a-z0-9]{2}/i.test(l.text));
  return { text: data.text || '', lines };
}

// ---------- interpretation ----------

const FRIENDLY = {
  chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', Code: 'VS Code', WINWORD: 'Microsoft Word', EXCEL: 'Microsoft Excel',
  POWERPNT: 'PowerPoint', notepad: 'Notepad', explorer: 'File Explorer', Spotify: 'Spotify', Teams: 'Microsoft Teams', ms_teams: 'Microsoft Teams',
  WhatsApp: 'WhatsApp', Taskmgr: 'Task Manager', SystemSettings: 'Settings', mspaint: 'Paint', devenv: 'Visual Studio', idea64: 'IntelliJ IDEA',
  pycharm64: 'PyCharm', WindowsTerminal: 'Windows Terminal', cmd: 'Command Prompt', powershell: 'PowerShell', Acrobat: 'Adobe Acrobat', AcroRd32: 'Adobe Reader',
};
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera']);
const BUTTONS = /^(ok|cancel|save|save as|submit|sign in|sign up|log ?in|log ?out|next|back|close|yes|no|apply|continue|search|download|install|send|delete|open|allow|deny|retry|accept|reject|agree|done|finish|skip|upload|share|reply|edit|new|create|add|remove|update|restart|confirm|got it|learn more|try again)$/i;
const MENUS = ['file', 'edit', 'view', 'insert', 'format', 'tools', 'help', 'window', 'selection', 'terminal', 'run', 'go', 'history', 'bookmarks', 'design', 'layout', 'review', 'home'];
const ERRORS = /\b(error|failed|failure|exception|warning|denied|not found|cannot|can't|unable to|not responding|crash(ed)?|fatal|invalid|timed? ?out|404|500|access is denied|problem|stopped working)\b/i;

function pageFromTitle(title, app) {
  return title.replace(/\s[-–—]\s(Google Chrome|Microsoft​? Edge|Mozilla Firefox|Brave|Opera)$/i, '').replace(/ and \d+ more pages?/i, '').trim();
}

function activity(app, title, text) {
  const t = `${title} ${text}`.toLowerCase();
  if (BROWSERS.has(app)) {
    if (/youtube/.test(t)) return 'watching or browsing YouTube';
    if (/gmail|outlook|inbox/.test(t)) return 'reading email';
    if (/github/.test(t)) return 'browsing code on GitHub';
    if (/stack ?overflow/.test(t)) return 'looking up a programming answer';
    if (/google search|- google search| - search/.test(t)) return 'searching the web';
    if (/chatgpt|claude|gemini/.test(t)) return 'using an AI assistant';
    return `browsing "${pageFromTitle(title)}"`;
  }
  if (app === 'Code' || app === 'devenv' || /idea|pycharm/i.test(app)) {
    const file = title.split(/\s[-–—●]\s/)[0].replace(/^●\s*/, '');
    return `writing code${file ? ` in ${file}` : ''}`;
  }
  if (app === 'WINWORD') return 'writing a Word document';
  if (app === 'EXCEL') return 'working on a spreadsheet';
  if (app === 'POWERPNT') return 'working on a presentation';
  if (app === 'explorer') return 'browsing files';
  if (/Teams|Zoom|WhatsApp|Telegram|Discord/i.test(app)) return 'chatting or in a meeting';
  if (/Spotify|vlc|wmplayer/i.test(app)) return 'listening to or watching media';
  if (/cmd|powershell|WindowsTerminal/i.test(app)) return 'using the command line';
  return null;
}

export async function analyzeScreen({ app, delay = 0 } = {}) {
  if (!isWindows) throw new ToolError('Screen analysis is only available on Windows.');
  if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(10, delay) * 1000));
  const file = path.join(os.tmpdir(), `chitti-screen-${Date.now()}.png`);
  const r = await powershell(SCRIPT, { env: { CS: SCREEN_CS, FILE: file, SKIP: 'CHITTI VISION', APP: app ? resolveApp(app)?.proc || app : '', DELAYED: delay > 0 ? '1' : '0' }, timeout: 45000 });
  let info;
  try {
    info = JSON.parse(r.stdout.trim());
  } catch {
    throw new ToolError(`I could not inspect the screen${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : '.'}`);
  }
  const windows = [].concat(info.windows || []);
  if (info.locked) return { say: 'The screen appears to be locked; the Windows sign-in screen is active.', data: { locked: true, windows } };
  const target = info.target?.hwnd ? info.target : null; // PowerShell serialises "no window" as {}
  if (!target) return { say: app ? `I could not find an open window for ${app}.` : 'I could not find an open application window to analyse.', data: { windows } };

  let text = '';
  let lines = [];
  let ocrNote = null;
  if (info.capture === 'ok') {
    try {
      ({ text, lines } = await ocr(file));
    } catch (e) {
      ocrNote = `Text recognition is unavailable (${/fetch|network|ENOTFOUND/i.test(e.message) ? 'its language data has not been downloaded yet; run "npm run models" once with internet' : e.message}).`;
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  } else {
    ocrNote = info.capture === 'blank' ? 'That window is hidden behind me and cannot be captured directly. Say "analyze my screen in 5 seconds" and switch to it, so I can read it.' : 'I could not capture that window.';
  }

  const appName = target.app;
  const friendly = FRIENDLY[appName] || appName;
  const page = BROWSERS.has(appName) ? pageFromTitle(target.title) : null;
  const words = lines.flatMap((l) => l.text.split(/\s{2,}|\s\|\s/)).map((w) => w.trim());
  const buttons = [...new Set(words.filter((w) => BUTTONS.test(w)))].slice(0, 10);
  const menuHits = MENUS.filter((m) => words.some((w) => w.toLowerCase() === m) || lines.slice(0, 6).some((l) => new RegExp(`\\b${m}\\b`, 'i').test(l.text)));
  const errors = [...new Set(lines.filter((l) => ERRORS.test(l.text)).map((l) => l.text))].slice(0, 4);
  const dialogs = windows.filter((w) => w.cls === '#32770' && !w.min).map((w) => w.title);
  const important = lines.filter((l) => l.text.length > 18).sort((a, b) => b.conf - a.conf).slice(0, 6).sort((a, b) => lines.indexOf(a) - lines.indexOf(b)).map((l) => l.text);
  const doing = activity(appName, target.title, text);

  const say = [
    `You are in ${friendly}${page ? `, on the page "${page}"` : target.title && target.title !== friendly ? `: "${target.title.slice(0, 80)}"` : ''}.`,
    doing && `It looks like you are ${doing}.`,
    errors.length ? `I can see a possible error or warning: "${errors[0].slice(0, 120)}".` : lines.length ? 'I do not see any error messages.' : null,
    info.uac ? 'A Windows permission prompt (User Account Control) is open.' : null,
    dialogs.length ? `A dialog box is open: "${dialogs[0]}".` : null,
    buttons.length ? `Visible buttons or labels include: ${buttons.slice(0, 5).join(', ')}.` : null,
    ocrNote,
  ].filter(Boolean).join(' ');

  return {
    say,
    data: {
      app: friendly, process: appName, title: target.title, page, activity: doing,
      text: text.slice(0, 4000), importantText: important, buttons, menus: menuHits.length >= 2 ? menuHits : [], errors, dialogs,
      uacPrompt: info.uac, locked: false, windows: windows.map((w) => ({ app: FRIENDLY[w.app] || w.app, title: w.title, minimized: w.min })),
      notes: 'Buttons and menus are inferred from visible text and may not be exact.',
    },
  };
}

define({
  name: 'analyze_screen',
  category: 'SCREEN',
  description: 'Analyse what is on screen: current app and page, important visible text, buttons, errors, dialogs. Looks at the window behind CHITTI.',
  params: {
    app: { type: 'string', description: 'optional app/window to look at, e.g. chrome or word' },
    delay: { type: 'number', description: 'seconds to wait before capturing (0-10), so the user can switch windows' },
  },
  run: (args) => analyzeScreen(args),
});

define({
  name: 'read_screen_text',
  category: 'SCREEN',
  description: 'Read (OCR) the text visible in the window behind CHITTI, or a named app.',
  params: { app: { type: 'string', description: 'optional app/window name' } },
  async run({ app }) {
    const r = await analyzeScreen({ app });
    const t = r.data?.text?.trim();
    return { say: t ? `Here is the text I can read in ${r.data.app}: ${t.replace(/\s+/g, ' ').slice(0, 500)}` : r.say, data: r.data };
  },
});

define({
  name: 'active_window',
  category: 'SCREEN',
  description: 'Which application windows are open and which one is in front (fast, no OCR). Also reports if the screen is locked.',
  async run() {
    if (!isWindows) throw new ToolError('Only available on Windows.');
    const r = await powershell(SCRIPT, { env: { CS: SCREEN_CS, FILE: path.join(os.tmpdir(), 'chitti-unused.png'), SKIP: 'CHITTI VISION', APP: '__none__' }, timeout: 30000 });
    let info;
    try { info = JSON.parse(r.stdout.trim()); } catch { throw new ToolError('I could not read the open windows.'); }
    const wins = [].concat(info.windows || []).filter((w) => !/CHITTI VISION/.test(w.title));
    if (info.locked) return { say: 'The screen is locked.', data: { locked: true } };
    const top = wins.find((w) => !w.min);
    return {
      say: top ? `Behind me, the front window is ${FRIENDLY[top.app] || top.app}: "${top.title.slice(0, 80)}". ${wins.length} windows are open.` : 'No other application windows are open.',
      data: { locked: false, windows: wins.map((w) => ({ app: FRIENDLY[w.app] || w.app, title: w.title, minimized: w.min })) },
    };
  },
});

export const ensureOcr = () => ocrWorker();
