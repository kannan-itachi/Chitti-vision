// Safe process helpers. Tools never pass user text to a shell: programs and script bodies
// are fixed in code, and user-supplied values travel as arguments or environment variables.
import { execFile } from 'node:child_process';

export const isWindows = process.platform === 'win32';

export function run(file, args = [], { timeout = 15000, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? (err.killed ? 'Timed out' : err.message) : null });
    });
    if (input != null) {
      child.stdin.end(input);
    }
  });
}

// Runs a fixed PowerShell script. Values reach the script only through $env:CHITTI_* variables.
export async function powershell(script, { env = {}, timeout = 20000 } = {}) {
  if (!isWindows) return { ok: false, error: 'This action is only available on Windows.' };
  const vars = Object.fromEntries(Object.entries(env).map(([k, v]) => [`CHITTI_${k}`, String(v)]));
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ProgressPreference='SilentlyContinue'; ${script}`], { env: vars, timeout });
}

export async function powershellJson(script, opts) {
  const r = await powershell(script, opts);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || r.error };
  try {
    return { ok: true, data: JSON.parse(r.stdout.trim() || 'null') };
  } catch {
    return { ok: false, error: 'Unexpected output from the system.' };
  }
}
