import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Static-fixes convention: `bun test` is the adopted runner. It discovers
 * `*.test.ts` files and executes BOTH `bun:test` and `vitest` imports
 * (runner-scoped compat — plain `bun run` cannot resolve `vitest`).
 * New tests must stay inside that envelope: `*.test.ts` naming and imports
 * from `bun:test` (canonical) or `vitest` (legacy, still executed). Any
 * other runner import would silently not run.
 */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const TESTS_DIR = join(import.meta.dir);

describe('test discovery conventions (bun test)', () => {
  it('every test file uses the *.test.ts naming bun test discovers', () => {
    const files = collectTestFiles(TESTS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith('.test.ts')).toBe(true);
    }
  });

  it('every test file imports only from runners bun test executes', () => {
    const files = collectTestFiles(TESTS_DIR);
    const bad: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        if (spec === 'bun:test' || spec === 'vitest') continue;
        if (['node:test', 'jest', '@jest/globals'].includes(spec)) {
          bad.push(`${file}: ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
