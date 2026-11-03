import { afterEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * P3: pre-existing nested symlink inside node_modules + write-through attack.
 * Origin: node_modules/demo is a symlink (absolute outside, escaping
 * relative, internal, workspace). The test writes evil THROUGH the link,
 * executes it, restores bytes + forges mtime. Before the fix the snapshot
 * preserved the link (`cp -a`), the dep fingerprint hashed only the link
 * target STRING, and the run passed success:true/verdict:pass on
 * adulterated bytes. Bun + Git + node --test reais, fixtures descartáveis.
 */

let rootDir = '';
afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

type LinkKind = 'absolute-outside' | 'relative-outside' | 'internal' | 'absolute-inside' | 'workspace' | 'pnpm';

function initRepo(kind: LinkKind): { dir: string; head: string; extFile: string; extBefore: string } {
  rootDir = mkdtempSync(join(tmpdir(), 'mc-p3-r34s-'));
  const dir = join(rootDir, 'repo');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git init -q');
  sh(dir, 'git config user.email t@t.t');
  sh(dir, 'git config user.name t');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });

  // Attack payload: write evil through the resolved link, run, restore + forge mtime.
  const attack = (leaveEvil: boolean) =>
    `const fs = require('fs');\n` +
    `const extFile = require.resolve('demo');\n` +
    `const ORIG = fs.readFileSync(extFile, 'utf8');\n` +
    `const stBefore = fs.statSync(extFile);\n` +
    `console.log('resolved:' + extFile);\n` +
    `fs.writeFileSync(extFile, 'module.exports = () => 3;\\n');\n` +
    `Object.keys(require.cache).forEach((k) => { if (k.includes('lib.js') || k.includes('demo')) delete require.cache[k]; });\n` +
    `const { sum } = require('./lib.js');\n` +
    `const r = sum();\n` +
    `if (r !== 3) { console.error('attack failed got ' + r); process.exit(1); }\n` +
    `console.log('attack-ok ' + r);\n` +
    (leaveEvil
      ? ``
      : `fs.writeFileSync(extFile, ORIG);\n` +
        `try { fs.utimesSync(extFile, stBefore.atime, stBefore.mtime); } catch {}\n`);

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'p3' }),
    'lib.js': `const d = require('demo');\nmodule.exports.sum = () => d();\n`,
    'attack.js': attack(false),
    'persist.js': attack(true),
    'check.js': `const { sum } = require('./lib.js');\nif (sum() !== 2) { console.error('WRONG got ' + sum()); process.exit(1); }\nconsole.log('legit-ok');\n`,
  };

  let extFile = '';
  if (kind === 'absolute-outside') {
    const outside = join(rootDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync(outside, join(dir, 'node_modules/demo'));
    extFile = join(outside, 'index.js');
  } else if (kind === 'relative-outside') {
    const outside = join(rootDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync('../../outside', join(dir, 'node_modules/demo'));
    extFile = join(outside, 'index.js');
  } else if (kind === 'internal') {
    mkdirSync(join(dir, 'node_modules/real-demo'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/real-demo/index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(dir, 'node_modules/real-demo/package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync('./real-demo', join(dir, 'node_modules/demo'));
    extFile = join(dir, 'node_modules/real-demo/index.js');
  } else if (kind === 'absolute-inside') {
    mkdirSync(join(dir, 'packs/foo'), { recursive: true });
    writeFileSync(join(dir, 'packs/foo/index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(dir, 'packs/foo/package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync(join(dir, 'packs/foo'), join(dir, 'node_modules/demo'));
    extFile = join(dir, 'packs/foo/index.js');
  } else if (kind === 'workspace') {
    mkdirSync(join(dir, 'packs/foo'), { recursive: true });
    writeFileSync(join(dir, 'packs/foo/index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(dir, 'packs/foo/package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync('../packs/foo', join(dir, 'node_modules/demo'));
    extFile = join(dir, 'packs/foo/index.js');
  } else {
    // pnpm-style: real bytes under .pnpm, top link relative-inside.
    const real = join(dir, 'node_modules/.pnpm/demo@1.0.0/node_modules/demo');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync('./.pnpm/demo@1.0.0/node_modules/demo', join(dir, 'node_modules/demo'));
    extFile = join(real, 'index.js');
  }

  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const tracked = Object.keys(files).concat(['.gitignore']);
  if (kind === 'workspace' || kind === 'absolute-inside') tracked.push('packs/foo/index.js', 'packs/foo/package.json');
  sh(dir, `git add ${tracked.map((f) => `"${f}"`).join(' ')}`);
  sh(dir, 'git commit -qm fixture');
  const extBefore = readFileSync(extFile, 'utf8');
  return { dir, head: sh(dir, 'git rev-parse HEAD'), extFile, extBefore };
}

async function run(dir: string, head: string, cmd: string) {
  const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
  return await runTestsOnImmutableSnapshot({
    dir, scopePaths: ['package.json', 'lib.js', 'attack.js', 'persist.js', 'check.js'],
    testCommand: cmd, timeoutMs: 60000, jobHead: head, keepSnapshotDir: true,
  });
}

describe('P3 nested dep symlink: write-through + restore (Bun+Git real)', () => {
  it('absolute-outside temp tamper + restore never executes: explicit env-failure', async () => {
    const { dir, head, extFile, extBefore } = initRepo('absolute-outside');
    const r = await run(dir, head, 'node attack.js');
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(r.output).toMatch(/symlink/i);
      expect(r.output).not.toMatch(/attack-ok/);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('absolute-outside persistent tamper never passes and never leaks', async () => {
    const { dir, head, extFile, extBefore } = initRepo('absolute-outside');
    const r = await run(dir, head, 'node persist.js');
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('escaping relative link (../../outside) → explicit env-failure', async () => {
    const { dir, head, extFile, extBefore } = initRepo('relative-outside');
    const r = await run(dir, head, 'node attack.js');
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(r.output).toMatch(/symlink/i);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('absolute link pinning inside-origin (not the copy) → explicit env-failure', async () => {
    const { dir, head, extFile, extBefore } = initRepo('absolute-inside');
    const r = await run(dir, head, 'node attack.js');
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('internal link persistent tamper is detected, origin untouched', async () => {
    const { dir, head, extFile, extBefore } = initRepo('internal');
    const r = await run(dir, head, 'node persist.js');
    try {
      expect(r.success).toBe(true); // evil ran inside the isolated copy
      expect(r.output).toMatch(/attack-ok 3/);
      expect(r.verdict).toBe('fail');
      expect(r.reason ?? '').toMatch(/dependenc/i);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('internal link temp tamper + restore + mtime forgery is detected (ctime)', async () => {
    const { dir, head, extFile, extBefore } = initRepo('internal');
    const r = await run(dir, head, 'node attack.js');
    try {
      expect(r.success).toBe(true);
      expect(r.output).toMatch(/attack-ok 3/);
      expect(r.verdict).toBe('fail');
      expect(r.reason ?? '').toMatch(/dependenc/i);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('legit workspace relative link still passes', async () => {
    const { dir, head, extFile, extBefore } = initRepo('workspace');
    const r = await run(dir, head, 'node check.js');
    try {
      expect(r.success).toBe(true);
      expect(r.verdict).toBe('pass');
      expect(r.output).toMatch(/legit-ok/);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('workspace link persistent tamper is detected, origin packs/ untouched', async () => {
    const { dir, head, extFile, extBefore } = initRepo('workspace');
    const r = await run(dir, head, 'node persist.js');
    try {
      expect(r.success).toBe(true);
      expect(r.verdict).toBe('fail');
      expect(r.reason ?? '').toMatch(/dependenc/i);
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('pnpm-style (.pnpm + relative link): legit passes, tamper fails', async () => {
    const { dir, head, extFile, extBefore } = initRepo('pnpm');
    const ok = await run(dir, head, 'node check.js');
    try {
      expect(ok.success).toBe(true);
      expect(ok.verdict).toBe('pass');
      expect(ok.output).toMatch(/legit-ok/);
    } finally {
      rmSync(ok.snapshotDir, { recursive: true, force: true });
    }
    const evil = await run(dir, head, 'node persist.js');
    try {
      expect(evil.success).toBe(true);
      expect(evil.verdict).toBe('fail');
      expect(readFileSync(extFile, 'utf8')).toBe(extBefore);
    } finally {
      rmSync(evil.snapshotDir, { recursive: true, force: true });
    }
  });
});
