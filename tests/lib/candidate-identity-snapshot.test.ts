import { afterEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const TOTAL_ORIGINAL = 'export function total(xs){ return xs.length; }\n';
const TOTAL_EVIL = 'export function total(xs){ return 3; }\n';
const CHECK_MJS =
  'import { total } from "./total.mjs";\n' +
  'if (total([1,2])!==3) { console.error("wrong: "+total([1,2])); process.exit(1); }\n' +
  'console.log("ok");\n';
// Malicious test payload (committed): swaps the ORIGINAL total.mjs to evil,
// executes it there, then restores content + forges mtime/mode. Runs with
// cwd=snapshot, argv[2]=original dir. Snapshot-local scratch never verdicts.
const ATTACK_MJS =
  'import { readFileSync, writeFileSync, copyFileSync } from "fs";\n' +
  'import { execSync } from "child_process";\n' +
  'import { join } from "path";\n' +
  'const origDir = process.argv[2];\n' +
  'const target = join(origDir, "total.mjs");\n' +
  'const bak = join(process.cwd(), "total.mjs.bak");\n' +
  'const ORIG = readFileSync(target, "utf8");\n' +
  'copyFileSync(target, bak);\n' +
  'try {\n' +
  '  writeFileSync(target, "export function total(xs){ return 3; }\\n");\n' +
  '  const out = execSync("node check.mjs", { cwd: origDir }).toString();\n' +
  '  console.log("inner:" + out.trim());\n' +
  '} finally {\n' +
  '  writeFileSync(target, ORIG);\n' +
  '  execSync("touch -r \\"" + bak + "\\" \\"" + target + "\\"");\n' +
  '}\n';
const MUTATE_MJS =
  'import { writeFileSync } from "fs";\n' +
  'import { join } from "path";\n' +
  'writeFileSync(join(process.argv[2], "total.mjs"), "export function total(xs){ return 3; }\\n");\n' +
  'console.log("mutated");\n';

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

let rootDir = '';
afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

async function initRepo(files: Record<string, string>): Promise<string> {
  rootDir = mkdtempSync(join(tmpdir(), 'mc-cand-snap-'));
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

describe('candidate-identity snapshot (immutable execution)', () => {
  it('protectInputsDuringRun misses a sync swap+restore with mtime forgery (poll hole)', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'package.json': JSON.stringify({ scripts: { test: 'node check.mjs' } }),
    });
    const total = join(dir, 'total.mjs');
    const ref = join(rootDir, 'ref-total.mjs');
    execSync(`cp -a "${total}" "${ref}"`); // exact timestamp reference, outside scope
    let childOut = '';
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['total.mjs', 'check.mjs'],
      pollIntervalMs: 5,
      runFn: () => {
        // SYNC, no await: the event-loop poll never fires between these lines.
        chmodSync(total, 0o644); // same-uid bypass of the 444 hardening
        writeFileSync(total, TOTAL_EVIL);
        childOut = execSync('node check.mjs', { cwd: dir }).toString().trim();
        writeFileSync(total, TOTAL_ORIGINAL);
        execSync(`touch -r "${ref}" "${total}"`); // forge mtime back (bumps ctime only)
        chmodSync(total, 0o444); // restore enforced mode
      },
    });
    expect(childOut).toBe('ok'); // evil bytes executed and passed
    expect(readFileSync(total, 'utf8')).toBe(TOTAL_ORIGINAL);
    // HOLE: content+mtime+mode all look clean afterwards, poll never fired.
    expect(result.verdict).toBe('pass');
  });

  it('runTestsOnImmutableSnapshot refuses the same attack from inside the snapshot', async () => {
    const mod = await import('../../src/lib/candidate-identity');
    const runTestsOnImmutableSnapshot = (mod as Record<string, unknown>)
      .runTestsOnImmutableSnapshot as
      | ((o: Record<string, unknown>) => Promise<{
          verdict: 'pass' | 'fail';
          reason?: string;
          success: boolean;
          output: string;
          timedOut: boolean;
          snapshotDir: string;
          protectedPaths: string[];
        }>)
      | undefined;
    expect(typeof runTestsOnImmutableSnapshot).toBe('function'); // RED: missing before GREEN
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'attack.mjs': ATTACK_MJS,
    });
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const result = await runTestsOnImmutableSnapshot!({
      dir,
      scopePaths: ['total.mjs', 'check.mjs', 'attack.mjs'],
      testCommand: `node attack.mjs "${dir}"`,
      timeoutMs: 60000,
      jobHead,
      keepSnapshotDir: true,
    });
    try {
      // The attack executed evil bytes (inner check passed) yet attribution is refused.
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/inner:ok/);
      expect(result.verdict).toBe('fail');
      expect(result.reason ?? '').toMatch(/ctime|restor|mutat|changed during run/i);
      // Original content intact; snapshot copy untouched by the attack.
      expect(readFileSync(join(dir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
      expect(readFileSync(join(result.snapshotDir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
    } finally {
      rmSync(result.snapshotDir, { recursive: true, force: true });
    }
  });

  it('runTestsOnImmutableSnapshot lets legit builds writing untracked dist/coverage pass', async () => {
    const mod = await import('../../src/lib/candidate-identity');
    const runTestsOnImmutableSnapshot = (mod as Record<string, unknown>)
      .runTestsOnImmutableSnapshot as (o: Record<string, unknown>) => Promise<{
      verdict: 'pass' | 'fail';
      reason?: string;
      success: boolean;
      output: string;
      timedOut: boolean;
      snapshotDir: string;
      protectedPaths: string[];
    }>;
    const dir = await initRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const result = await runTestsOnImmutableSnapshot({
      dir,
      scopePaths: ['src/a.ts', 'dist/out.js'],
      isTracked: (p: string) => p === 'src/a.ts',
      testCommand:
        'mkdir -p dist coverage && printf \'"use strict";\\n\' > dist/out.js && printf \'"TN:\\n\' > coverage/lcov.info && node -e "console.log(\'build ok\')"',
      timeoutMs: 60000,
      jobHead,
      keepSnapshotDir: true,
    });
    try {
      expect(result.verdict).toBe('pass');
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/build ok/);
      // Outputs landed in the snapshot copy, never in the original.
      expect(existsSync(join(dir, 'dist', 'out.js'))).toBe(false);
      expect(existsSync(join(dir, 'coverage'))).toBe(false);
      expect(readFileSync(join(result.snapshotDir, 'dist', 'out.js'), 'utf8')).toContain('use strict');
      expect(existsSync(join(result.snapshotDir, 'coverage', 'lcov.info'))).toBe(true);
    } finally {
      rmSync(result.snapshotDir, { recursive: true, force: true });
    }
  });

  it('runTestsOnImmutableSnapshot fails a persistent mutation of the original during the run', async () => {
    const mod = await import('../../src/lib/candidate-identity');
    const runTestsOnImmutableSnapshot = (mod as Record<string, unknown>)
      .runTestsOnImmutableSnapshot as (o: Record<string, unknown>) => Promise<{
      verdict: 'pass' | 'fail';
      reason?: string;
      success: boolean;
      output: string;
      timedOut: boolean;
      snapshotDir: string;
      protectedPaths: string[];
    }>;
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'mutate.mjs': MUTATE_MJS,
    });
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const result = await runTestsOnImmutableSnapshot({
      dir,
      scopePaths: ['total.mjs', 'check.mjs', 'mutate.mjs'],
      testCommand: `node mutate.mjs "${dir}"`,
      timeoutMs: 60000,
      jobHead,
      keepSnapshotDir: true,
    });
    try {
      expect(result.verdict).toBe('fail');
      expect(result.reason ?? '').toMatch(/mutat|changed during run/i);
      // Damage is visible in the original (caught, not hidden) while the
      // snapshot kept the committed bytes the test actually executed.
      expect(readFileSync(join(dir, 'total.mjs'), 'utf8')).toBe(TOTAL_EVIL);
      expect(readFileSync(join(result.snapshotDir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
    } finally {
      rmSync(result.snapshotDir, { recursive: true, force: true });
    }
  });
});
