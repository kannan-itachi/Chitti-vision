// Path guard for every file tool: names like "downloads" resolve to real folders, and any
// path must stay inside the user's home folder (no system folders, no other users).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from './registry.js';

const HOME = os.homedir();
const ONEDRIVE = process.env.OneDrive || path.join(HOME, 'OneDrive');
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// OneDrive often redirects Documents/Desktop/Pictures; prefer whichever exists.
const pick = (...c) => c.find((p) => fs.existsSync(p)) || c[0];

export const KNOWN_FOLDERS = {
  home: HOME,
  downloads: path.join(HOME, 'Downloads'),
  documents: pick(path.join(ONEDRIVE, 'Documents'), path.join(HOME, 'Documents')),
  desktop: pick(path.join(ONEDRIVE, 'Desktop'), path.join(HOME, 'Desktop')),
  pictures: pick(path.join(ONEDRIVE, 'Pictures'), path.join(HOME, 'Pictures')),
  music: path.join(HOME, 'Music'),
  videos: path.join(HOME, 'Videos'),
  onedrive: ONEDRIVE,
  project: PROJECT,
  screenshots: path.join(HOME, 'Pictures', 'Chitti Screenshots'),
};

const FOLDER_ALIASES = { download: 'downloads', document: 'documents', 'my documents': 'documents', picture: 'pictures', photos: 'pictures', video: 'videos', 'home folder': 'home', 'user folder': 'home', 'project folder': 'project', 'my project': 'project', 'chitti project': 'project' };

export const SEARCH_ROOTS = [...new Set([KNOWN_FOLDERS.desktop, KNOWN_FOLDERS.documents, KNOWN_FOLDERS.downloads, KNOWN_FOLDERS.pictures, KNOWN_FOLDERS.music, KNOWN_FOLDERS.videos, ONEDRIVE])].filter((p) => fs.existsSync(p));

export function knownFolder(name) {
  const n = String(name || '').toLowerCase().replace(/\bfolder\b/, '').trim();
  const key = KNOWN_FOLDERS[n] ? n : FOLDER_ALIASES[n] || FOLDER_ALIASES[`${n} folder`];
  return key ? KNOWN_FOLDERS[key] : null;
}

export function isInsideHome(p) {
  const rel = path.relative(HOME, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveUserPath(input, { mustExist = true, dir } = {}) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new ToolError('No path given.');
  let p = knownFolder(raw);
  if (!p) {
    const expanded = raw.replace(/^~(?=$|[\\/])/, HOME);
    p = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(HOME, expanded);
  }
  if (!isInsideHome(p)) throw new ToolError('For safety I only work with files inside your user folder.');
  if (mustExist) {
    if (!fs.existsSync(p)) throw new ToolError(`I could not find "${raw}".`);
    const isDir = fs.statSync(p).isDirectory();
    if (dir === true && !isDir) throw new ToolError(`"${path.basename(p)}" is a file, not a folder.`);
    if (dir === false && isDir) throw new ToolError(`"${path.basename(p)}" is a folder, not a file.`);
  }
  return p;
}
