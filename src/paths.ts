import { resolve } from 'node:path';

/** Project root, valid both for `src/` (tsx) and `dist/` (compiled). */
export const APP_ROOT = resolve(import.meta.dirname, '..');
export const MIGRATIONS_DIR = resolve(APP_ROOT, 'migrations');
export const CONFIG_DIR = resolve(APP_ROOT, 'config');
export const PUBLIC_DIR = resolve(APP_ROOT, 'public');
