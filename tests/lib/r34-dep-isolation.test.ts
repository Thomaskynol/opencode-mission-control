import { afterEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * R3: snapshot must PHYSICALLY copy dependencies (no symlink snapshot→origin).
 * A test that tampers deps at test time must never yield a pass attributed to
 * the commit, and the original must never be written through.
 * Bun real + Git real, disposable fixtures.
 */

let rootDir = '';
afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(files: Record<string, string>, withDemoDep: boolean): string {
  rootDir = mkdtempSync(join(tmpdir(), 'mc-r34-dep-'));
  const dir = join(rootDir, 'repo');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git init -q');
  sh(dir, 'git config user.email t@t.t');
  sh(dir, 'git config user.name t');
  if (withDemoDep) {
    mkdirSync(join(dir, 'node_modules/demo'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/demo/package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    writeFileSync(join(dir, 'node_modules/demo/index.js'), 'module.exports = () => 2;\n');
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const tracked = Object.keys(files).concat(['.gitignore']);
  sh(dir, `git add ${tracked.map((f) => `"${f}"`).join(' ')}`);
  sh(dir, 'git commit -qm fixture');
  return dir;
}

const LIB_JS = `const d = require('demo');\nmodule.exports.sum = (xs) => d();\n`;
// Legit check: fails on the committed dep (returns 2, not the sum 3).
const CHECK_JS =
  `const { sum } = require('./lib.js');\n` +
  `const r = sum([1,2]);\n` +
  `if (r !== 3) { console.error('WRONG got '+r); process.exit(1); }\nconsole.log('ok '+r);\n`;
// Attack: rewrite the SNAPSHOT dep to return 3, execute, restore, assert 3.
const ATTACK_JS =
  `const fs = require('fs');\n` +
  `const dep = 'node_modules/demo/index.js';\n` +
  `const orig = fs.readFileSync(dep, 'utf8');\n` +
  `try {\n` +
  `  fs.writeFileSync(dep, 'module.exports = () => 3;\\n');\n` +
  `  delete require.cache[require.resolve('./lib.js')];\n` +
  `  const { sum } = require('./lib.js');\n` +
  `  const r = sum([1,2]);\n` +
  `  if (r !== 3) { console.error('attack failed got '+r); process.exit(1); }\n` +
  `  console.log('attack-ok '+r);\n` +
  `} finally { fs.writeFileSync(dep, orig); }\n`;
// Escape: symlink inside the snapshot pointing at the ORIGINAL dep, write evil
// through it, execute, restore. argv[2] = original dir. Exits AFTER the
// restore (a process.exit inside try would skip finally).
const ESCAPE_JS =
  `const fs = require('fs');\n` +
  `const path = require('path');\n` +
  `const origDir = process.argv[2];\n` +
  `const target = path.join(origDir, 'node_modules/demo/index.js');\n` +
  `const ORIG = fs.readFileSync(target, 'utf8');\n` +
  `fs.symlinkSync(target, 'evil-link');\n` +
  `let code = 0;\n` +
  `try {\n` +
  `  fs.writeFileSync('evil-link', 'module.exports = () => 3;\\n');\n` +
  `  delete require.cache[require.resolve('demo')];\n` +
  `  const d = require('demo');\n` +
  `  if (d() !== 3) { console.error('escape failed (snapshot copy unaffected)'); code = 1; }\n` +
  `  else { console.log('escape-ok'); }\n` +
  `} finally { fs.writeFileSync(target, ORIG); }\n` +
  `process.exit(code);\n`;

function origDepState(dir: string): { bytes: string; mtimeMs: number } {
  const f = join(dir, 'node_modules/demo/index.js');
  return { bytes: readFileSync(f, 'utf8'), mtimeMs: lstatSync(f).mtimeMs };
}

describe('R3: physical dep copy, no symlink snapshot→origin (Bun+Git real)', () => {
  it('temp dep tamper at test time never passes and never touches the original', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const dir = initRepo({ 'package.json': JSON.stringify({ name: 'r3' }), 'lib.js': LIB_JS, 'check.js': CHECK_JS, 'attack.js': ATTACK_JS }, true);
    const head = sh(dir, 'git rev-parse HEAD');
    const before = origDepState(dir);
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 'lib.js', 'check.js', 'attack.js'],
      testCommand: 'node attack.js', timeoutMs: 60000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      // Evil executed inside the snapshot, yet attribution is refused.
      expect(r.success).toBe(true);
      expect(r.output).toMatch(/attack-ok 3/);
      expect(r.verdict).toBe('fail');
      expect(r.reason ?? '').toMatch(/dependenc|dep/i);
      expect(typeof (r as unknown as { depFingerprint?: unknown }).depFingerprint).toBe('string');
      // Original dep bytes AND mtime untouched (no write leaked through).
      const after = origDepState(dir);
      expect(after.bytes).toBe(before.bytes);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      // Independent check on the real bytes still fails (real impl returns 2).
      expect(() => execSync('node check.js', { cwd: dir, stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('persistent dep overwrite stays out of the original and never passes', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const persist = `const fs = require('fs');\nfs.writeFileSync('node_modules/demo/index.js', 'module.exports = () => 3;\\n');\nconsole.log('persisted-evil');\n`;
    const dir = initRepo({ 'package.json': JSON.stringify({ name: 'r3' }), 'lib.js': LIB_JS, 'persist.js': persist }, true);
    const head = sh(dir, 'git rev-parse HEAD');
    const before = origDepState(dir);
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 'lib.js', 'persist.js'],
      testCommand: 'node persist.js', timeoutMs: 60000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      expect(r.verdict).toBe('fail');
      const after = origDepState(dir);
      expect(after.bytes).toBe(before.bytes);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('symlink escape that writes the original dep is detected (verdict fail)', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const dir = initRepo({ 'package.json': JSON.stringify({ name: 'r3' }), 'lib.js': LIB_JS, 'escape.js': ESCAPE_JS }, true);
    const head = sh(dir, 'git rev-parse HEAD');
    const before = origDepState(dir);
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 'lib.js', 'escape.js'],
      testCommand: `node escape.js "${dir}"`, timeoutMs: 60000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      // The evil write through the escape link cannot even reach the executed
      // tree (a physical copy), so the attack fails on its own terms; the
      // leaked write into the ORIGINAL deps is still detected and refuses
      // attribution.
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.reason ?? '').toMatch(/original dependencies/i);
      // Content restored by the attacker, still detected (ctime/identity).
      expect(readFileSync(join(dir, 'node_modules/demo/index.js'), 'utf8')).toBe(before.bytes);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('snapshot node_modules is a physical copy, never a symlink to the origin', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const dir = initRepo({ 'package.json': JSON.stringify({ name: 'r3' }), 'lib.js': LIB_JS, 'check.js': CHECK_JS }, true);
    const head = sh(dir, 'git rev-parse HEAD');
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 'lib.js', 'check.js'],
      testCommand: 'node -e "console.log(1)"', timeoutMs: 60000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      const st = lstatSync(join(r.snapshotDir, 'node_modules'));
      expect(st.isSymbolicLink()).toBe(false);
      expect(realpathSync(join(r.snapshotDir, 'node_modules'))).not.toBe(realpathSync(join(dir, 'node_modules')));
      expect(readFileSync(join(r.snapshotDir, 'node_modules/demo/index.js'), 'utf8')).toBe('module.exports = () => 2;\n');
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('legit execution with deps still passes (copy is runnable)', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const dir = initRepo(
      {
        'package.json': JSON.stringify({ name: 'r3ok' }),
        'lib.js': LIB_JS,
        // Dep returns 2 and the check expects 2: legit green on real bytes.
        'check2.js': `const { sum } = require('./lib.js');\nif (sum([9]) !== 2) { process.exit(1); }\nconsole.log('legit-ok');\n`,
      },
      true,
    );
    const head = sh(dir, 'git rev-parse HEAD');
    const before = origDepState(dir);
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 'lib.js', 'check2.js'],
      testCommand: 'node check2.js', timeoutMs: 60000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      expect(r.success).toBe(true);
      expect(r.verdict).toBe('pass');
      expect(r.output).toMatch(/legit-ok/);
      const after = origDepState(dir);
      expect(after.bytes).toBe(before.bytes);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });
});
