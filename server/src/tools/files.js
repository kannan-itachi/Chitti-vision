// File intelligence inside the user's home folder: search, recent files, content search,
// reading, and careful file operations. Destructive operations need confirmation, and
// deletion goes to the Recycle Bin rather than being permanent.
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { define, ToolError } from './registry.js';
import { resolveUserPath, SEARCH_ROOTS, knownFolder, isInsideHome } from './paths.js';
import { powershell, isWindows } from './exec.js';
import { extractText } from '../knowledge.js';

const TYPES = {
  pdf: ['.pdf'], document: ['.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.pdf'], doc: ['.doc', '.docx'], word: ['.doc', '.docx'],
  text: ['.txt', '.md', '.log'], spreadsheet: ['.xls', '.xlsx', '.csv', '.ods'], excel: ['.xls', '.xlsx', '.csv'],
  presentation: ['.ppt', '.pptx', '.odp'], powerpoint: ['.ppt', '.pptx'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic'], photo: ['.jpg', '.jpeg', '.png', '.heic', '.webp'],
  video: ['.mp4', '.mkv', '.avi', '.mov', '.webm'], audio: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'], music: ['.mp3', '.wav', '.m4a', '.flac'],
  code: ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.html', '.css', '.php', '.go', '.rs'],
  zip: ['.zip', '.rar', '.7z'], archive: ['.zip', '.rar', '.7z', '.tar', '.gz'],
};
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml', '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.php', '.sql', '.ini']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', '__pycache__', '.cache', '.vscode', '.idea', 'venv', '.venv', 'dist', 'models']);

const kind = (file) => {
  const e = path.extname(file).toLowerCase();
  return Object.entries(TYPES).find(([k, v]) => ['pdf', 'document', 'spreadsheet', 'presentation', 'image', 'video', 'audio', 'code', 'archive'].includes(k) && v.includes(e))?.[0] || (e ? e.slice(1) : 'file');
};
const extsFor = (type) => {
  if (!type) return null;
  const t = type.toLowerCase().replace(/^\./, '').replace(/s$/, '');
  return TYPES[t] || TYPES[`${t}s`] || [`.${t}`];
};
const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (ms) => {
  const d = (Date.now() - ms) / 86400e3;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.round(d)} days ago` : new Date(ms).toLocaleDateString();
};

// Breadth-first walk with limits so a search never hangs the assistant.
async function walk(roots, visit, { maxDepth = 7, maxEntries = 80000, timeMs = 9000 } = {}) {
  const start = Date.now();
  let seen = 0;
  const queue = roots.map((r) => ({ dir: r, depth: 0 }));
  const done = new Set();
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (done.has(dir)) continue;
    done.add(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries || Date.now() - start > timeMs) return { truncated: true };
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        if (visit(full, e, true) === false) return {};
      } else if (e.isFile()) {
        if (visit(full, e, false) === false) return {};
      }
    }
  }
  return {};
}

async function statAll(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const s = await fs.stat(p);
      out.push({ path: p, name: path.basename(p), size: s.size, modified: s.mtimeMs, type: kind(p), folder: path.dirname(p) });
    } catch { /* vanished */ }
  }
  return out;
}

// Main user folders (and anything that contains them) can never be deleted.
const isProtected = (target) => ['home', 'downloads', 'documents', 'desktop', 'pictures', 'music', 'videos', 'onedrive', 'project']
  .some((k) => { const f = knownFolder(k); return f && (f === target || !path.relative(target, f).startsWith('..')); });

const rootsFor = (folder) => (folder ? [resolveUserPath(folder, { mustExist: true, dir: true })] : SEARCH_ROOTS);
const describeList = (files, n = 3) => files.slice(0, n).map((f) => `${f.name} (${when(f.modified)}, in ${path.basename(f.folder)})`).join('; ');

define({
  name: 'search_files',
  category: 'FILES',
  description: 'Find files by name keywords and/or type (pdf, document, image, video, code…) in Desktop, Documents, Downloads, Pictures, OneDrive.',
  params: {
    query: { type: 'string', description: 'words in the file name, e.g. "resume"' },
    type: { type: 'string', description: 'file type, e.g. pdf, document, image, video, spreadsheet' },
    folder: { type: 'string', description: 'optional folder to search, e.g. downloads' },
  },
  async run({ query = '', type, folder }) {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['file', 'files', 'my', 'the', 'a', 'find'].includes(w));
    const exts = extsFor(type);
    if (!words.length && !exts) throw new ToolError('Tell me part of the file name or a file type to search for.');
    const hits = [];
    const { truncated } = await walk(rootsFor(folder), (full, e, isDir) => {
      if (isDir) return;
      const name = e.name.toLowerCase();
      if (exts && !exts.includes(path.extname(name))) return;
      const score = words.filter((w) => name.includes(w)).length;
      if (words.length && score === 0) return;
      hits.push({ full, score });
    });
    const files = await statAll(hits.sort((a, b) => b.score - a.score).slice(0, 200).map((h) => h.full));
    const scoreOf = new Map(hits.map((h) => [h.full, h.score]));
    files.sort((a, b) => scoreOf.get(b.path) - scoreOf.get(a.path) || b.modified - a.modified);
    const top = files.slice(0, 10);
    const label = [query && `"${query}"`, type].filter(Boolean).join(' ');
    const say = top.length
      ? `I found ${files.length} match${files.length === 1 ? '' : 'es'} for ${label}. ${files.length === 1 ? 'It is' : 'Best matches:'} ${describeList(top)}.`
      : `I could not find any ${label} files${truncated ? ' in the time allowed' : ''}.`;
    return { say, data: { files: top, total: files.length, truncated: !!truncated } };
  },
});

define({
  name: 'recent_files',
  category: 'FILES',
  description: 'List the most recently modified files, optionally of one type (e.g. the latest PDF).',
  params: {
    type: { type: 'string', description: 'optional file type, e.g. pdf, image, document' },
    folder: { type: 'string', description: 'optional folder, e.g. downloads' },
    limit: { type: 'number', description: 'how many (default 5)' },
  },
  async run({ type, folder, limit = 5 }) {
    const exts = extsFor(type);
    const cand = [];
    await walk(rootsFor(folder), (full, e, isDir) => {
      if (!isDir && (!exts || exts.includes(path.extname(e.name).toLowerCase()))) cand.push(full);
    });
    const files = (await statAll(cand)).sort((a, b) => b.modified - a.modified).slice(0, Math.min(20, Math.max(1, limit)));
    if (!files.length) return { say: `No ${type || ''} files found.`.replace('  ', ' '), data: { files: [] } };
    return { say: `Most recent ${type || 'file'}${files.length > 1 ? 's' : ''}: ${describeList(files, Math.min(3, files.length))}.`, data: { files } };
  },
});

define({
  name: 'search_file_contents',
  category: 'FILES',
  description: 'Search inside text, PDF and Word files for a word or phrase.',
  params: {
    text: { type: 'string', required: true, description: 'word or phrase to look for inside files' },
    folder: { type: 'string', description: 'optional folder, e.g. documents' },
  },
  async run({ text, folder }) {
    const needle = text.toLowerCase();
    const cand = [];
    await walk(rootsFor(folder), (full, e, isDir) => {
      if (isDir) return;
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXT.has(ext) || ext === '.pdf' || ext === '.docx') cand.push(full);
    }, { timeMs: 5000 });
    const files = (await statAll(cand)).filter((f) => f.size < 15 * 1048576).sort((a, b) => b.modified - a.modified);
    const found = [];
    const start = Date.now();
    let heavy = 0;
    for (const f of files) {
      if (Date.now() - start > 15000 || found.length >= 10) break;
      const ext = path.extname(f.path).toLowerCase();
      if (!TEXT_EXT.has(ext) && ++heavy > 60) continue; // cap slow PDF/DOCX parsing
      try {
        const body = TEXT_EXT.has(ext) ? (f.size < 2 * 1048576 ? await fs.readFile(f.path, 'utf8') : '') : await extractText(await fs.readFile(f.path), f.name);
        const i = body.toLowerCase().indexOf(needle);
        if (i >= 0) found.push({ ...f, snippet: body.slice(Math.max(0, i - 80), i + needle.length + 120).replace(/\s+/g, ' ').trim() });
      } catch { /* unreadable */ }
    }
    return {
      say: found.length ? `"${text}" appears in ${found.length} file${found.length > 1 ? 's' : ''}: ${describeList(found)}.` : `I did not find "${text}" inside any readable files.`,
      data: { files: found },
    };
  },
});

define({
  name: 'read_file',
  category: 'FILES',
  description: 'Read the text of a document (txt, md, csv, json, code, pdf, docx) so it can be summarised or questioned.',
  params: { path: { type: 'string', required: true, max: 1000, description: 'full path of the file' } },
  async run({ path: p }) {
    const file = resolveUserPath(p, { mustExist: true, dir: false });
    const s = statSync(file);
    if (s.size > 25 * 1048576) throw new ToolError('That file is too large to read (over 25 MB).');
    let text;
    try {
      text = await extractText(await fs.readFile(file), path.basename(file));
    } catch (e) {
      throw new ToolError(`I can't read ${path.basename(file)}: ${e.message}`);
    }
    return { say: `I have read ${path.basename(file)}, ${text.split(/\s+/).length} words.`, data: { path: file, name: path.basename(file), text: text.slice(0, 20000), truncated: text.length > 20000 } };
  },
});

define({
  name: 'create_folder',
  category: 'FILES',
  description: 'Create a new folder (inside the user folder).',
  params: {
    name: { type: 'string', required: true, description: 'new folder name' },
    parent: { type: 'string', description: 'where to create it, e.g. desktop or documents (default desktop)' },
  },
  async run({ name, parent = 'desktop' }) {
    if (/[<>:"/\\|?*]/.test(name)) throw new ToolError('Folder names cannot contain < > : " / \\ | ? *');
    const dir = path.join(resolveUserPath(parent, { mustExist: true, dir: true }), name);
    if (existsSync(dir)) throw new ToolError(`A folder called "${name}" already exists there.`);
    await fs.mkdir(dir);
    return { say: `Created the folder "${name}" in ${path.basename(path.dirname(dir))}.`, data: { path: dir } };
  },
});

define({
  name: 'copy_path',
  category: 'FILES',
  description: 'Copy a file or folder to another folder.',
  params: { from: { type: 'string', required: true, max: 1000, description: 'source path' }, to: { type: 'string', required: true, max: 1000, description: 'destination folder' } },
  async run({ from, to }) {
    const src = resolveUserPath(from);
    const dest = path.join(resolveUserPath(to, { dir: true }), path.basename(src));
    if (existsSync(dest)) throw new ToolError(`"${path.basename(src)}" already exists in the destination.`);
    await fs.cp(src, dest, { recursive: true, errorOnExist: true });
    return { say: `Copied ${path.basename(src)} to ${path.basename(path.dirname(dest))}.`, data: { path: dest } };
  },
});

define({
  name: 'move_path',
  category: 'FILES',
  description: 'Move a file or folder to another folder. Asks for confirmation.',
  risk: 'confirm',
  params: { from: { type: 'string', required: true, max: 1000, description: 'source path' }, to: { type: 'string', required: true, max: 1000, description: 'destination folder' } },
  confirm: ({ from, to }) => {
    try {
      const src = resolveUserPath(from);
      const dest = resolveUserPath(to, { dir: true });
      return `Move "${path.basename(src)}" to ${dest}? Do you want me to continue?`;
    } catch (e) { return { error: e.message }; }
  },
  async run({ from, to }) {
    const src = resolveUserPath(from);
    const dest = path.join(resolveUserPath(to, { dir: true }), path.basename(src));
    if (existsSync(dest)) throw new ToolError(`"${path.basename(src)}" already exists in the destination.`);
    await fs.rename(src, dest);
    return { say: `Moved ${path.basename(src)}.`, data: { path: dest } };
  },
});

define({
  name: 'rename_path',
  category: 'FILES',
  description: 'Rename a file or folder (keeps it in the same folder). Asks for confirmation.',
  risk: 'confirm',
  params: { path: { type: 'string', required: true, max: 1000, description: 'current path' }, name: { type: 'string', required: true, description: 'new name' } },
  confirm: ({ path: p, name }) => {
    try { return `Rename "${path.basename(resolveUserPath(p))}" to "${name}"? Do you want me to continue?`; } catch (e) { return { error: e.message }; }
  },
  async run({ path: p, name }) {
    if (/[<>:"/\\|?*]/.test(name)) throw new ToolError('Names cannot contain < > : " / \\ | ? *');
    const src = resolveUserPath(p);
    const dest = path.join(path.dirname(src), name);
    if (existsSync(dest)) throw new ToolError(`Something called "${name}" already exists there.`);
    await fs.rename(src, dest);
    return { say: `Renamed to ${name}.`, data: { path: dest } };
  },
});

define({
  name: 'delete_path',
  category: 'FILES',
  description: 'Delete a file or folder by sending it to the Recycle Bin. Always asks for confirmation.',
  risk: 'confirm',
  params: { path: { type: 'string', required: true, max: 1000, description: 'path to delete' } },
  confirm: ({ path: p }) => {
    try {
      const target = resolveUserPath(p);
      if (isProtected(target)) return { error: 'I will not delete a main user folder.' };
      const isDir = statSync(target).isDirectory();
      return `This will move the ${isDir ? 'folder' : 'file'} "${path.basename(target)}" to the Recycle Bin. Do you want me to continue?`;
    } catch (e) { return { error: e.message }; }
  },
  async run({ path: p }) {
    if (!isWindows) throw new ToolError('Deleting is only supported on Windows (Recycle Bin).');
    const target = resolveUserPath(p);
    if (isProtected(target)) throw new ToolError('I will not delete a main user folder.');
    const isDir = statSync(target).isDirectory();
    const r = await powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; try { if ($env:CHITTI_DIR -eq '1') { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CHITTI_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:CHITTI_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin') }; 'ok' } catch { 'ERR:' + $_.Exception.Message }`,
      { env: { PATH: target, DIR: isDir ? '1' : '0' } },
    );
    if (r.stdout.trim() !== 'ok') throw new ToolError(`I could not delete it: ${r.stdout.replace(/^ERR:/, '').trim() || r.error}`);
    return { say: `Moved ${path.basename(target)} to the Recycle Bin. You can restore it from there.`, data: { path: target } };
  },
});

define({
  name: 'find_duplicates',
  category: 'FILES',
  description: 'Find files that share the same name and size (likely duplicates).',
  params: { folder: { type: 'string', description: 'optional folder, e.g. downloads' } },
  async run({ folder }) {
    const cand = [];
    await walk(rootsFor(folder), (full, e, isDir) => { if (!isDir) cand.push(full); }, { timeMs: 7000 });
    const groups = new Map();
    for (const f of await statAll(cand.slice(0, 20000))) {
      const key = `${f.name.toLowerCase()}|${f.size}`;
      groups.set(key, [...(groups.get(key) || []), f]);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1 && g[0].size > 0).sort((a, b) => b[0].size * b.length - a[0].size * a.length);
    const wasted = dups.reduce((s, g) => s + g[0].size * (g.length - 1), 0);
    return {
      say: dups.length ? `I found ${dups.length} sets of duplicate files, using about ${size(wasted)} extra. For example, ${dups[0][0].name} appears ${dups[0].length} times.` : 'I did not find any duplicate files.',
      data: { groups: dups.slice(0, 20).map((g) => g.map((f) => f.path)), wasted },
    };
  },
});

define({
  name: 'file_info',
  category: 'FILES',
  description: 'Details about a file: type, size, location, dates.',
  params: { path: { type: 'string', required: true, max: 1000, description: 'full path' } },
  async run({ path: p }) {
    const file = resolveUserPath(p);
    const s = statSync(file);
    if (!isInsideHome(file)) throw new ToolError('Outside your user folder.');
    return { say: `${path.basename(file)} is a ${s.isDirectory() ? 'folder' : `${kind(file)} file of ${size(s.size)}`}, in ${path.dirname(file)}, last changed ${when(s.mtimeMs)}.`, data: { path: file, size: s.size, modified: s.mtimeMs, created: s.birthtimeMs, type: kind(file) } };
  },
});
