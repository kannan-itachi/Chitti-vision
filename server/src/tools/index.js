// Loads every server tool module and adds composite tools built from them.
import path from 'node:path';
import { define, call, ToolError } from './registry.js';
import './system.js';
import './apps.js';
import './files.js';
import './screen.js';
import './maps.js';
import './web.js';

export * from './registry.js';

// "Find my resume and open it" / "open the latest PDF": search, pick, open — or ask when unsure.
define({
  name: 'open_best_file',
  category: 'FILES',
  description: 'Find a file by name/type and open it. Use latest=true for "the latest/newest/most recent" file. Asks for clarification when several files match equally well.',
  params: {
    query: { type: 'string', description: 'words from the file name, e.g. resume' },
    type: { type: 'string', description: 'file type, e.g. pdf, document, image' },
    latest: { type: 'boolean', description: 'open the most recently modified match' },
    folder: { type: 'string', description: 'optional folder, e.g. downloads' },
  },
  async run({ query, type, latest, folder }) {
    const found = latest && !query
      ? await call('recent_files', { type, folder, limit: 5 })
      : await call('search_files', { query, type, folder });
    if (!found.success) throw new ToolError(found.error);
    let files = found.result.data.files || [];
    if (!files.length) throw new ToolError(`I could not find ${[query && `"${query}"`, type].filter(Boolean).join(' ') || 'that file'}.`);
    if (latest) files = [...files].sort((a, b) => b.modified - a.modified);
    const words = String(query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    const score = (f) => words.filter((w) => f.name.toLowerCase().includes(w)).length;
    const best = files[0];
    const tied = !latest && files.filter((f) => score(f) === score(best)).length > 1
      && files.slice(1, 3).some((f) => score(f) === score(best) && Math.abs(f.modified - best.modified) < 7 * 86400e3);
    if (tied) {
      return {
        say: `I found several possible files: ${files.slice(0, 3).map((f, i) => `${i + 1}, ${f.name} in ${path.basename(f.folder)}`).join('; ')}. Which one should I open?`,
        data: { choices: files.slice(0, 5), needsChoice: true },
      };
    }
    const opened = await call('open_file', { path: best.path });
    if (!opened.success) throw new ToolError(opened.error);
    return { say: `Opening ${best.name} from ${path.basename(best.folder)}.`, data: { path: best.path, file: best } };
  },
});
