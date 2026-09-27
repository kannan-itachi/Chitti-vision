// Persistent memory: mission + scan log survive page reloads and restarts.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'memory.json');
const EMPTY = { mission: null, scans: [], recordMode: false };

let mem = (() => {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...EMPTY }; }
})();

export const get = () => mem;

export function patch(body = {}) {
  if ('mission' in body) mem.mission = body.mission ? String(body.mission).slice(0, 200) : null;
  if ('recordMode' in body) mem.recordMode = !!body.recordMode;
  if (typeof body.scan === 'string') mem.scans = [...mem.scans, { at: Date.now(), text: body.scan.slice(0, 300) }].slice(-50);
  if (body.clearScans) mem.scans = [];
  fs.writeFileSync(FILE, JSON.stringify(mem, null, 2));
  return mem;
}
