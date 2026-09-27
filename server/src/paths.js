import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(here, '../data');
export const MODELS_DIR = path.resolve(here, '../models');
export const CLIENT_DIST = path.resolve(here, '../../client/dist');

fs.mkdirSync(DATA_DIR, { recursive: true });
