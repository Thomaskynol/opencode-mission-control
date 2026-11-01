import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const TOTAL_ORIGINAL = 'export function total(xs){ return xs.length; }\n';
const TOTAL_EVIL = 'export function total(xs){ return 3; }\n';
const CHECK_MJS =
  'import { total } from "./total.mjs";\n' +
  'if (total([1,2])!==3) { console.error("wrong: "+total([1,2])); process.exit(1); }\n' +
  'console.log("ok");\n';

async function exec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function mustExec(args: string[], cwd: string): Promise<string> {
  const r = await exec(args, cwd);
  if (r.exitCode !== 0) throw new Error(`cmd failed: ${args.join(' ')} :: ${r.stderr}`);
  return r.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulates the current before/after identity logic (content + HEAD + dirty only). */
function oldBeforeAfterVerdict(
  before: string,
  after: string,
  headBefore: string | null,
  headAfter: string | null,
  dirty: boolean,
): 'pass' | 'fail' {
  const mutated = before !== after;
  const diverged = headBefore !== headAfter;
  return mutated || diverged || dirty ? 'fail' : 'pass';
}

let rootDir = '';
afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

async function initRepo(files: Record<string, string>): Promise<string> {
  rootDir = mkdtempSync(join(tmpdir(), 'mc-cand-id-'));
  const dir = join(rootDir, 'repo');
  mkdirSync(dir, { recursive: true });
  await mustExec(['git', 'init'], dir);
  await mustExec(['git', 'config', 'user.email', 't@t.com'], dir);
  await mustExec(['git', 'config', 'user.name', 'T'], dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  await mustExec(['git', 'add', '.'], dir);
  await mustExec(['git', 'commit', '-m', 'init'], dir);
  return dir;
}

describe('candidate-identity (A→B→A protection)', () => {
  it('old before/after identity misses an A→B→A restore (documents the hole)', async () => {
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'package.json': JSON.stringify({ scripts: { test: 'node check.mjs' } }),
    });
    const headBefore = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const before = readFileSync(join(dir, 'total.mjs'), 'utf8');

    // Attack: swap in a temp impl that returns 3, execute it, restore the original.
    writeFileSync(join(dir, 'total.mjs'), TOTAL_EVIL);
    await sleep(30);
    const run = await exec(['node', 'check.mjs'], dir);
    writeFileSync(join(dir, 'total.mjs'), before);

    const after = readFileSync(join(dir, 'total.mjs'), 'utf8');
    const headAfter = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const porcelain = await mustExec(['git', 'status', '--porcelain'], dir);

    expect(run.exitCode).toBe(0); // mutated bytes executed and passed
    expect(before).toContain('xs.length'); // ...while the commit holds xs.length (returns 2, not 3)
    expect(after).toBe(before);
    expect(headAfter).toBe(headBefore);
    expect(porcelain).toBe('');
    // The hole: old logic calls this a clean pass attributed to the commit.
    expect(oldBeforeAfterVerdict(before, after, headBefore, headAfter, porcelain !== '')).toBe('pass');
  });

  it('protectInputsDuringRun refuses an A→B→A restore (transient swap detected)', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'package.json': JSON.stringify({ scripts: { test: 'node check.mjs' } }),
    });
    let childExit = -1;
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['total.mjs', 'check.mjs'],
      pollIntervalMs: 5,
      runFn: async () => {
        const total = join(dir, 'total.mjs');
        chmodSync(total, 0o644); // adaptive attacker re-enables writes
        writeFileSync(total, TOTAL_EVIL);
        await sleep(40);
        const run = await exec(['node', 'check.mjs'], dir);
        childExit = run.exitCode;
        writeFileSync(total, TOTAL_ORIGINAL);
      },
    });
    expect(childExit).toBe(0); // the run executed mutated bytes, not the commit
    expect(result.verdict).toBe('fail');
    expect(result.reason ?? '').toMatch(/transient|changed during run|restor|mutation|mode|denied/i);
  });

  it('protectInputsDuringRun denies direct writes to protected inputs', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({ 'total.mjs': TOTAL_ORIGINAL });
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['total.mjs'],
      runFn: () => {
        writeFileSync(join(dir, 'total.mjs'), TOTAL_EVIL);
      },
    });
    expect(result.verdict).toBe('fail');
    expect(result.reason ?? '').toMatch(/denied|mutation|transient|restor/i);
  });

  it('legit builds writing untracked dist/ still pass', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['src/a.ts'],
      runFn: async () => {
        mkdirSync(join(dir, 'dist'), { recursive: true });
        writeFileSync(join(dir, 'dist', 'out.js'), '"use strict";\n');
        mkdirSync(join(dir, 'coverage'), { recursive: true });
        writeFileSync(join(dir, 'coverage', 'lcov.info'), 'TN:\n');
      },
    });
    expect(result.verdict).toBe('pass');
  });

  it('tracked dist/ modifications are refused', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({
      'src/a.ts': 'export const a = 1;\n',
      'dist/bundle.js': 'export const bundle = 1;\n',
    });
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['dist/bundle.js'],
      isTracked: () => true,
      runFn: () => {
        writeFileSync(join(dir, 'dist', 'bundle.js'), 'export const bundle = 2;\n');
      },
    });
    expect(result.verdict).toBe('fail');
  });

  it('untracked dist/ outputs listed in scope stay writable (allowlist)', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['src/a.ts', 'dist/gen.js'],
      isTracked: (p) => p === 'src/a.ts',
      runFn: () => {
        mkdirSync(join(dir, 'dist'), { recursive: true });
        writeFileSync(join(dir, 'dist', 'gen.js'), 'export const gen = 1;\n');
      },
    });
    expect(result.verdict).toBe('pass');
  });

  it('decideIdentityVerdict is pure: mtime-only drift fails, identical passes', async () => {
    const { decideIdentityVerdict } = await import('../../src/lib/candidate-identity');
    const base = { 'total.mjs': { hash: 'abc', mtimeMs: 1000, size: 10, exists: true } };
    expect(decideIdentityVerdict(base, base).verdict).toBe('pass');
    expect(
      decideIdentityVerdict(base, {
        'total.mjs': { hash: 'abc', mtimeMs: 2000, size: 10, exists: true },
      }).verdict,
    ).toBe('fail');
    expect(decideIdentityVerdict(base, base, ['total.mjs']).verdict).toBe('fail');
  });
});
