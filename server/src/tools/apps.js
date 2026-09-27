// Applications, URLs, folders, windows, volume, brightness, power — Windows, allowlist only.
// Values are handed to fixed PowerShell scripts through environment variables, so nothing the
// user says is ever parsed as a command.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { define, ToolError } from './registry.js';
import { powershell, powershellJson, run, isWindows } from './exec.js';
import { resolveUserPath, KNOWN_FOLDERS } from './paths.js';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

// name → { label, launch: [candidates], proc: process name for focus/close }
export const APPS = {
  chrome: { label: 'Google Chrome', launch: ['chrome', `${PF}\\Google\\Chrome\\Application\\chrome.exe`, `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`], proc: 'chrome' },
  edge: { label: 'Microsoft Edge', launch: ['msedge', `${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`], proc: 'msedge' },
  firefox: { label: 'Firefox', launch: ['firefox', `${PF}\\Mozilla Firefox\\firefox.exe`], proc: 'firefox' },
  vscode: { label: 'VS Code', launch: [`${LOCAL}\\Programs\\Microsoft VS Code\\Code.exe`, `${PF}\\Microsoft VS Code\\Code.exe`, 'code'], proc: 'Code' },
  notepad: { label: 'Notepad', launch: ['notepad'], proc: 'notepad' },
  calculator: { label: 'Calculator', launch: ['calc'], proc: 'CalculatorApp' },
  paint: { label: 'Paint', launch: ['mspaint'], proc: 'mspaint' },
  explorer: { label: 'File Explorer', launch: ['explorer'], proc: 'explorer', noClose: true },
  word: { label: 'Microsoft Word', launch: ['winword'], proc: 'WINWORD' },
  excel: { label: 'Microsoft Excel', launch: ['excel'], proc: 'EXCEL' },
  powerpoint: { label: 'PowerPoint', launch: ['powerpnt'], proc: 'POWERPNT' },
  spotify: { label: 'Spotify', launch: ['spotify:'], proc: 'Spotify' },
  settings: { label: 'Windows Settings', launch: ['ms-settings:'], proc: 'SystemSettings' },
  taskmanager: { label: 'Task Manager', launch: ['taskmgr'], proc: 'Taskmgr' },
  camera: { label: 'Camera', launch: ['microsoft.windows.camera:'], proc: 'WindowsCamera' },
  terminal: { label: 'Terminal', launch: ['wt', 'cmd'], proc: 'WindowsTerminal' },
  whatsapp: { label: 'WhatsApp', launch: ['whatsapp:'], proc: 'WhatsApp' },
  store: { label: 'Microsoft Store', launch: ['ms-windows-store:'], proc: 'WinStore.App' },
  photos: { label: 'Photos', launch: ['ms-photos:'], proc: 'Microsoft.Photos' },
  clock: { label: 'Clock', launch: ['ms-clock:'], proc: 'Time' },
  snippingtool: { label: 'Snipping Tool', launch: ['ms-screenclip:'], proc: 'SnippingTool' },
};

const ALIASES = {
  'google chrome': 'chrome', browser: 'chrome', 'web browser': 'chrome', 'microsoft edge': 'edge', 'visual studio code': 'vscode',
  'vs code': 'vscode', code: 'vscode', calc: 'calculator', 'file explorer': 'explorer', 'file manager': 'explorer', files: 'explorer',
  'task manager': 'taskmanager', 'command prompt': 'terminal', cmd: 'terminal', powershell: 'terminal', 'windows settings': 'settings',
  'control panel': 'settings', 'ms word': 'word', 'microsoft word': 'word', 'ms excel': 'excel', 'microsoft excel': 'excel',
  'ms paint': 'paint', 'snipping tool': 'snippingtool', 'microsoft store': 'store', 'play store': 'store',
};

export function resolveApp(name) {
  const n = String(name || '').toLowerCase().replace(/\b(app|application|the|my)\b/g, '').replace(/\s+/g, ' ').trim();
  const key = APPS[n] ? n : ALIASES[n] || Object.keys(APPS).find((k) => n.replace(/\s/g, '') === k);
  return key ? { key, ...APPS[key] } : null;
}

const needWindows = () => { if (!isWindows) throw new ToolError('Computer control is only available on Windows.'); };

// Start-Process with the target in an env var (no shell parsing of user text).
async function startProcess(target, args) {
  const r = await powershell(
    `try { if ($env:CHITTI_ARGS) { Start-Process -FilePath $env:CHITTI_TARGET -ArgumentList $env:CHITTI_ARGS -ErrorAction Stop } else { Start-Process -FilePath $env:CHITTI_TARGET -ErrorAction Stop }; 'ok' } catch { 'ERR:' + $_.Exception.Message }`,
    { env: { TARGET: target, ARGS: args || '' } },
  );
  const out = r.stdout.trim();
  return out === 'ok' ? { ok: true } : { ok: false, error: out.replace(/^ERR:/, '') || r.error };
}

define({
  name: 'open_app',
  category: 'APPLICATION',
  description: `Open an installed application. Known apps: ${Object.keys(APPS).join(', ')}.`,
  params: { app: { type: 'string', required: true, description: 'application name, e.g. chrome, vscode, notepad' } },
  async run({ app }) {
    needWindows();
    const a = resolveApp(app);
    if (!a) throw new ToolError(`I don't have "${app}" in my list of apps I can open. I can open: ${Object.values(APPS).map((x) => x.label).join(', ')}.`);
    let last = '';
    for (const cand of a.launch) {
      if (/^[A-Z]:\\/i.test(cand) && !fs.existsSync(cand)) continue;
      const r = await startProcess(cand);
      if (r.ok) return { say: `Opening ${a.label}.`, data: { app: a.key } };
      last = r.error;
    }
    throw new ToolError(`${a.label} does not seem to be installed${last ? ` (${last.split('.')[0]})` : ''}.`);
  },
});

define({
  name: 'close_app',
  category: 'APPLICATION',
  description: 'Close an open application gracefully (it can still ask to save your work).',
  params: { app: { type: 'string', required: true, description: 'application name' } },
  async run({ app }) {
    needWindows();
    const a = resolveApp(app);
    if (!a) throw new ToolError(`I don't know an app called "${app}".`);
    if (a.noClose) throw new ToolError(`For safety I won't close ${a.label}; it runs the Windows desktop.`);
    const r = await powershell(
      `$p = Get-Process -Name $env:CHITTI_PROC -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }; if (-not $p) { 'none' } else { $p | ForEach-Object { [void]$_.CloseMainWindow() }; 'closed' }`,
      { env: { PROC: a.proc } },
    );
    const out = r.stdout.trim();
    if (out === 'none') throw new ToolError(`${a.label} is not open.`);
    if (out !== 'closed') throw new ToolError(`I could not close ${a.label}.`);
    return { say: `Closing ${a.label}.`, data: { app: a.key } };
  },
});

const WIN32 = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class ChittiWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }
"@;`;

define({
  name: 'focus_app',
  category: 'APPLICATION',
  description: 'Bring an already-open application to the front.',
  params: { app: { type: 'string', required: true, description: 'application name' } },
  async run({ app }) {
    needWindows();
    const a = resolveApp(app);
    if (!a) throw new ToolError(`I don't know an app called "${app}".`);
    const r = await powershell(
      `${WIN32} $p = Get-Process -Name $env:CHITTI_PROC -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if (-not $p) { 'none' } else { if ([ChittiWin]::IsIconic($p.MainWindowHandle)) { [void][ChittiWin]::ShowWindow($p.MainWindowHandle, 9) }; [void][ChittiWin]::SetForegroundWindow($p.MainWindowHandle); 'ok' }`,
      { env: { PROC: a.proc } },
    );
    if (r.stdout.trim() === 'none') throw new ToolError(`${a.label} is not open. Say "open ${a.key}" to start it.`);
    return { say: `Switched to ${a.label}.`, data: { app: a.key } };
  },
});

define({
  name: 'list_windows',
  category: 'APPLICATION',
  description: 'List the application windows that are currently open.',
  async run() {
    needWindows();
    const r = await powershellJson(`@(Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object @{n='app';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}}) | ConvertTo-Json -Compress`);
    if (!r.ok) throw new ToolError('I could not read the open windows.');
    const list = [].concat(r.data || []);
    return { say: list.length ? `Open windows: ${list.map((w) => w.app).filter((v, i, x) => x.indexOf(v) === i).join(', ')}.` : 'No application windows are open.', data: list };
  },
});

define({
  name: 'open_url',
  category: 'BROWSER',
  description: 'Open a web address (http/https) in the default browser.',
  params: { url: { type: 'string', required: true, max: 2000, description: 'full URL starting with https://' } },
  async run({ url }) {
    needWindows();
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    } catch {
      throw new ToolError('That does not look like a valid web address.');
    }
    if (!/^https?:$/.test(u.protocol)) throw new ToolError('I only open http and https links.');
    const r = await startProcess(u.href);
    if (!r.ok) throw new ToolError(`I could not open the browser: ${r.error}`);
    return { say: `Opening ${u.hostname}.`, data: { url: u.href } };
  },
});

define({
  name: 'open_folder',
  category: 'FILES',
  description: `Open a folder in File Explorer. Known folders: ${Object.keys(KNOWN_FOLDERS).join(', ')}; or a path inside the user's home folder.`,
  params: { folder: { type: 'string', required: true, description: 'e.g. downloads, documents, desktop, project, or a path' } },
  async run({ folder }) {
    needWindows();
    const p = resolveUserPath(folder, { mustExist: true, dir: true });
    const r = await startProcess('explorer.exe', `"${p}"`);
    if (!r.ok) throw new ToolError(`I could not open that folder: ${r.error}`);
    return { say: `Opening ${path.basename(p) || p}.`, data: { path: p } };
  },
});

const EXECUTABLE = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|lnk|reg|jar|hta|cpl|dll|sys)$/i;

define({
  name: 'open_file',
  category: 'FILES',
  description: 'Open a document or file with its default application (not programs or scripts).',
  params: { path: { type: 'string', required: true, max: 1000, description: 'full path of the file' } },
  async run({ path: p }) {
    needWindows();
    const file = resolveUserPath(p, { mustExist: true, dir: false });
    if (EXECUTABLE.test(file)) throw new ToolError('For safety I do not run programs or scripts from files.');
    const r = await startProcess(file);
    if (!r.ok) throw new ToolError(`I could not open that file: ${r.error}`);
    return { say: `Opening ${path.basename(file)}.`, data: { path: file } };
  },
});

// ---------- screenshot ----------

const DPI = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class ChittiDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [void][ChittiDpi]::SetProcessDPIAware();`;

export async function captureScreen(file) {
  const r = await powershell(
    `${DPI} Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save($env:CHITTI_FILE, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); 'ok'`,
    { env: { FILE: file } },
  );
  if (r.stdout.trim() !== 'ok') throw new ToolError(`Screenshot failed: ${r.stderr.trim() || r.error}`);
  return file;
}

define({
  name: 'take_screenshot',
  category: 'SCREEN',
  description: 'Take a screenshot of the whole screen and save it to Pictures\\Chitti Screenshots.',
  async run() {
    needWindows();
    const dir = path.join(os.homedir(), 'Pictures', 'Chitti Screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `chitti-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
    await captureScreen(file);
    return { say: `Screenshot saved in Pictures, Chitti Screenshots.`, data: { path: file } };
  },
});

// ---------- volume & brightness ----------

define({
  name: 'volume',
  category: 'SYSTEM',
  description: 'Change the system volume: up, down, mute (toggle), or set to a level 0-100.',
  params: {
    action: { type: 'string', required: true, enum: ['up', 'down', 'mute', 'set'], description: 'up, down, mute or set' },
    level: { type: 'number', description: 'target level 0-100 when action is set' },
  },
  async run({ action, level }) {
    needWindows();
    // Media keys via SendKeys: each press moves the volume by 2%.
    const presses = { up: 5, down: 5, mute: 1 }[action];
    let script;
    if (action === 'set') {
      const lvl = Math.max(0, Math.min(100, Math.round(level ?? 50)));
      script = `$w = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $w.SendKeys([char]174) }; 1..${Math.round(lvl / 2)} | ForEach-Object { $w.SendKeys([char]175) }; 'ok'`;
    } else {
      const key = { up: 175, down: 174, mute: 173 }[action];
      script = `$w = New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $w.SendKeys([char]${key}) }; 'ok'`;
    }
    const r = await powershell(script);
    if (r.stdout.trim() !== 'ok') throw new ToolError('I could not change the volume.');
    const say = action === 'set' ? `Volume set to about ${Math.round((level ?? 50) / 2) * 2} percent.` : action === 'mute' ? 'Toggled mute.' : `Volume ${action}.`;
    return { say, data: { action, level } };
  },
});

define({
  name: 'brightness',
  category: 'SYSTEM',
  description: 'Get or set screen brightness 0-100 (laptop/built-in screens only).',
  params: { level: { type: 'number', description: 'new brightness 0-100; omit to read the current value' } },
  async run({ level }) {
    needWindows();
    if (level == null) {
      const r = await powershell(`(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness`);
      const v = parseInt(r.stdout.trim(), 10);
      if (!Number.isFinite(v)) throw new ToolError('Brightness control is not supported on this screen (usually only laptop displays support it).');
      return { say: `Brightness is ${v} percent.`, data: { level: v } };
    }
    const lvl = Math.max(0, Math.min(100, Math.round(level)));
    const r = await powershell(`try { $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1; Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=[byte]$env:CHITTI_LEVEL} | Out-Null; 'ok' } catch { 'ERR' }`, { env: { LEVEL: lvl } });
    if (r.stdout.trim() !== 'ok') throw new ToolError('Brightness control is not supported on this screen (usually only laptop displays support it).');
    return { say: `Brightness set to ${lvl} percent.`, data: { level: lvl } };
  },
});

// ---------- clipboard ----------

define({
  name: 'clipboard_read',
  category: 'SYSTEM',
  description: 'Read the text currently on the clipboard.',
  async run() {
    needWindows();
    const r = await powershell('Get-Clipboard -Raw');
    const text = r.stdout.replace(/\r\n$/, '');
    return { say: text.trim() ? `Your clipboard says: ${text.slice(0, 300)}` : 'Your clipboard is empty.', data: { text: text.slice(0, 5000) } };
  },
});

define({
  name: 'clipboard_write',
  category: 'SYSTEM',
  description: 'Copy text to the clipboard.',
  params: { text: { type: 'string', required: true, max: 5000, description: 'text to copy' } },
  async run({ text }) {
    needWindows();
    const r = await powershell('Set-Clipboard -Value $env:CHITTI_TEXT; "ok"', { env: { TEXT: text } });
    if (r.stdout.trim() !== 'ok') throw new ToolError('I could not write to the clipboard.');
    return { say: 'Copied to the clipboard.', data: { length: text.length } };
  },
});

// ---------- power (sensitive → confirmation required) ----------

define({
  name: 'lock_screen',
  category: 'SYSTEM',
  description: 'Lock the computer (returns to the Windows sign-in screen).',
  async run() {
    needWindows();
    const r = await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    if (!r.ok) throw new ToolError('I could not lock the computer.');
    return { say: 'Locking the computer.', data: null };
  },
});

define({
  name: 'power',
  category: 'SYSTEM',
  description: 'Shut down, restart or put the computer to sleep. Always asks for confirmation.',
  risk: 'confirm',
  params: { action: { type: 'string', required: true, enum: ['shutdown', 'restart', 'sleep'], description: 'shutdown, restart or sleep' } },
  confirm: ({ action }) => ({
    shutdown: 'This will shut down the computer in 30 seconds. Unsaved work may be lost. Do you want me to continue?',
    restart: 'This will restart the computer in 30 seconds. Unsaved work may be lost. Do you want me to continue?',
    sleep: 'This will put the computer to sleep now. Do you want me to continue?',
  }[action]),
  async run({ action }) {
    needWindows();
    const r = action === 'sleep'
      ? await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
      : await run('shutdown.exe', [action === 'restart' ? '/r' : '/s', '/t', '30', '/c', 'Requested through CHITTI. Run "shutdown /a" to cancel.']);
    if (!r.ok) throw new ToolError(`I could not ${action} the computer: ${r.stderr.trim() || r.error}`);
    return { say: action === 'sleep' ? 'Going to sleep.' : `${action === 'restart' ? 'Restarting' : 'Shutting down'} in 30 seconds. Say "cancel shutdown" to stop it.`, data: { action } };
  },
});

define({
  name: 'cancel_shutdown',
  category: 'SYSTEM',
  description: 'Cancel a pending shutdown or restart.',
  async run() {
    needWindows();
    const r = await run('shutdown.exe', ['/a']);
    if (!r.ok) throw new ToolError('There is no shutdown to cancel.');
    return { say: 'Shutdown cancelled.', data: null };
  },
});
