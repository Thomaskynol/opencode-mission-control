import { afterEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const TOTAL_ORIGINAL = 'export function total(xs){ return xs.length; }\n';
const TOTAL_EVIL = 'export function total(xs){ return 3; }\n';
// Sync swap+restore attack against the ORIGINAL, executed from inside the
// test run: swaps evil bytes in, executes them in the original dir, then
// restores content + forges mtime/mode back. Runs with cwd=snapshot,
// argv[2]=original dir. A poll on the original never fires mid-sync-run.
const ATTACK_MJS =
  'import { readFileSync, writeFileSync, copyFileSync, chmodSync } from "fs";\n' +
  'import { execSync } from "child_process";\n' +
  'import { join } from "path";\n' +
  'const origDir = process.argv[2];\n' +
  'const target = join(origDir, "total.mjs");\n' +
  'const bak = join(process.cwd(), "total.mjs.bak");\n' +
  'const ORIG = readFileSync(target, "utf8");\n' +
  'copyFileSync(target, bak);\n' +
  'try {\n' +
  '  chmodSync(target, 0o644);\n' +
  '  writeFileSync(target, "export function total(xs){ return 3; }\\n");\n' +
  '  const out = execSync("node check.mjs", { cwd: origDir }).toString();\n' +
  '  console.log("inner:" + out.trim());\n' +
  '} finally {\n' +
  '  writeFileSync(target, ORIG);\n' +
  '  execSync("touch -r \\"" + bak + "\\" \\"" + target + "\\"");\n' +
  '  chmodSync(target, 0o444);\n' +
  '}\n';
const CHECK_MJS =
  'import { total } from "./total.mjs";\n' +
  'if (total([1,2])!==3) { console.error("wrong: "+total([1,2])); process.exit(1); }\n' +
  'console.log("ok");\n';

async function exec(args: string[], cwd: string) {
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
  rootDir = mkdtempSync(join(tmpdir(), 'mc-scope-snap-'));
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

async function makeOrchestrator() {
  const { Orchestrator } = await import('../../src/lib/orchestrator');
  const { JobMonitor } = await import('../../src/lib/monitor');
  return new Orchestrator(new JobMonitor() as never, {
    defaultPlacement: 'session',
    pollInterval: 10000,
    idleThreshold: 300000,
    worktreeBasePath: '/tmp',
    omo: { enabled: false, defaultMode: 'vanilla' },
  } as never);
}

describe('scope execution on immutable snapshot (orchestrator runScopeSnapshot)', () => {
  it('documents the poll hole: protectInputsDuringRun misses the sync swap+restore', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'package.json': JSON.stringify({ scripts: { test: 'node check.mjs' } }),
    });
    const total = join(dir, 'total.mjs');
    const ref = join(rootDir, 'ref-total.mjs');
    execSync(`cp -a "${total}" "${ref}"`);
    let childOut = '';
    const result = await protectInputsDuringRun({
      dir,
      scopePaths: ['total.mjs', 'check.mjs'],
      pollIntervalMs: 5,
      runFn: () => {
        chmodSync(total, 0o644);
        writeFileSync(total, TOTAL_EVIL);
        childOut = execSync('node check.mjs', { cwd: dir }).toString().trim();
        writeFileSync(total, TOTAL_ORIGINAL);
        execSync(`touch -r "${ref}" "${total}"`);
        chmodSync(total, 0o444);
      },
    });
    expect(childOut).toBe('ok'); // evil bytes executed and passed
    expect(result.verdict).toBe('pass'); // HOLE: poll never fired mid-sync-run
  });

  it('runScopeSnapshot refuses the same sync attack from inside the snapshot run', async () => {
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'attack.mjs': ATTACK_MJS,
    });
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const orch = await makeOrchestrator();
    const snap = await (orch as unknown as {
      runScopeSnapshot: (
        dir: string,
        scopePaths: string[],
        command: string,
        timeoutMs: number,
        jobHead?: string,
      ) => Promise<{ success: boolean; output: string; timedOut: boolean; verdict: 'pass' | 'fail'; reason?: string }>;
    }).runScopeSnapshot(dir, ['total.mjs', 'check.mjs', 'attack.mjs'], `node attack.mjs "${dir}"`, 60000, jobHead);
    // The attack executed evil bytes (inner check passed) yet attribution is refused.
    expect(snap.success).toBe(false);
    expect(snap.verdict).toBe('fail');
    expect(snap.reason ?? snap.output).toMatch(/ctime|restor|mutat|changed during run|identity refused/i);
    expect(readFileSync(join(dir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
  });

  it('runScopeSnapshot lets legit builds writing untracked dist/coverage pass', async () => {
    const dir = await initRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const orch = await makeOrchestrator();
    const snap = await (orch as unknown as {
      runScopeSnapshot: (
        dir: string,
        scopePaths: string[],
        command: string,
        timeoutMs: number,
        jobHead?: string,
      ) => Promise<{ success: boolean; output: string; timedOut: boolean; verdict: 'pass' | 'fail'; reason?: string }>;
    }).runScopeSnapshot(
      dir,
      ['src/a.ts', 'dist/out.js'],
      'mkdir -p dist coverage && printf \'"use strict";\\n\' > dist/out.js && printf \'"TN:\\n\' > coverage/lcov.info && node -e "console.log(\'build ok\')"',
      60000,
      jobHead,
    );
    expect(snap.verdict).toBe('pass');
    expect(snap.success).toBe(true);
    expect(snap.output).toMatch(/build ok/);
    // Outputs landed in the snapshot copy, never in the original.
    expect(existsSync(join(dir, 'dist', 'out.js'))).toBe(false);
    expect(existsSync(join(dir, 'coverage'))).toBe(false);
  });
});
