import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * R4: inconclusive preparation (exception, failed, timeout, missing dep with
 * no install path) = explicit env-failure; the test NEVER runs, success false,
 * never pass/skip. Bun real + Git real, disposable fixtures.
 */

let rootDir = '';
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'mc-r34-env-'));
});
afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(files: Record<string, string>): { dir: string; head: string } {
  const dir = join(rootDir, 'repo');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git init -q');
  sh(dir, 'git config user.email t@t.t');
  sh(dir, 'git config user.name t');
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  sh(dir, 'git add .');
  sh(dir, 'git commit -qm fixture');
  return { dir, head: sh(dir, 'git rev-parse HEAD') };
}

// Marker proves whether the test command executed: it writes RAN_MARKER into
// its cwd (the snapshot). Absent marker in a kept snapshot = never ran.
const MARKER_CMD = `node -e "require('fs').writeFileSync('RAN_MARKER','x')"`;

describe('R4: inconclusive prep is env-failure, test never runs (Bun+Git real)', () => {
  it('prepare that throws => env-failure, test NOT executed, success false, never pass', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { dir, head } = initRepo({ 'a.txt': 'hello\n' });
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['a.txt'], testCommand: MARKER_CMD, timeoutMs: 30000, jobHead: head, keepSnapshotDir: true,
      // Test seam for the untestable-natural path: mirrors the report sonda
      // (prepare replaced by a throwing function) without module mocking.
      envPrepOverride: async () => {
        throw new Error('synthetic prepare boom');
      },
    });
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.timedOut).toBe(false);
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(existsSync(join(r.snapshotDir, 'RAN_MARKER'))).toBe(false);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('failed setup command => env-failure, test NOT executed', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { dir, head } = initRepo({ 'a.txt': 'hello\n' });
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['a.txt'], testCommand: MARKER_CMD, timeoutMs: 30000, jobHead: head,
      setupCommands: ['node -e "process.exit(3)"'], keepSnapshotDir: true,
    });
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(existsSync(join(r.snapshotDir, 'RAN_MARKER'))).toBe(false);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('setup timeout => env-failure, test NOT executed', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { dir, head } = initRepo({ 'a.txt': 'hello\n' });
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['a.txt'], testCommand: MARKER_CMD, timeoutMs: 800, jobHead: head,
      setupCommands: ['node -e "setTimeout(()=>{},5000)"'], keepSnapshotDir: true,
    });
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.timedOut).toBe(false);
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(existsSync(join(r.snapshotDir, 'RAN_MARKER'))).toBe(false);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('missing dep with no install path => env-failure, test NOT executed', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { dir, head } = initRepo({
      'package.json': JSON.stringify({ name: 'r4', dependencies: { 'no-such-dep-xyz': '*' } }),
      't.js': `require('no-such-dep-xyz');\n`,
    });
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 't.js'], testCommand: MARKER_CMD, timeoutMs: 30000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      expect(r.success).toBe(false);
      expect(r.verdict).toBe('fail');
      expect(r.output).toMatch(/ENV-UNPREPARED/);
      expect(existsSync(join(r.snapshotDir, 'RAN_MARKER'))).toBe(false);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('valid case without manifest/deps still runs and passes', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { dir, head } = initRepo({ 'a.txt': 'hello\n' });
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['a.txt'], testCommand: MARKER_CMD, timeoutMs: 30000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      expect(r.success).toBe(true);
      expect(r.verdict).toBe('pass');
      expect(existsSync(join(r.snapshotDir, 'RAN_MARKER'))).toBe(true);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });

  it('valid case with manifest but no declared deps still runs and passes', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { dir, head } = initRepo({ 'package.json': JSON.stringify({ name: 'r4plain' }), 'a.txt': 'hello\n' });
    const r = await runTestsOnImmutableSnapshot({
      dir, scopePaths: ['package.json', 'a.txt'], testCommand: MARKER_CMD, timeoutMs: 30000, jobHead: head, keepSnapshotDir: true,
    });
    try {
      expect(r.success).toBe(true);
      expect(r.verdict).toBe('pass');
      expect(existsSync(join(r.snapshotDir, 'RAN_MARKER'))).toBe(true);
    } finally {
      rmSync(r.snapshotDir, { recursive: true, force: true });
    }
  });
});
