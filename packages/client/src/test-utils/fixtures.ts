import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../../fixtures');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')) as T;
}

export function fixtureNames(): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

export const fixturesDir = dir;
