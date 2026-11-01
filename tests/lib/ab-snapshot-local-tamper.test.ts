import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// A — snapshot-local swap+restore must NOT yield PASS.
// Committed total.mjs is wrong (length, not sum). The attack rewrites the
// SNAPSHOT copy to evil (returns 3), executes it there, restores the copy,
// and exits 0. Original dir is never touched. Correct behavior: success true
// (evil executed) but verdict fail (attribution refused). Buggy behavior:
// verdict pass + success true (false PASS).

const TOTAL_ORIGINAL = 'export function total(xs){ return xs.length; }\n';
const CHECK_MJS =
  'import { total } from "./total.mjs";\n' +
  'if(total([1,2])!==3){ console.error("wrong: "+total([1,2])); process.exit(1); }\n' +
  'console.log("ok");\n';
const ATTACK_LOCAL_MJS =
  'import { chmodSync, readFileSync, writeFileSync } from "fs";\n' +
  'import { execSync } from "child_process";\n' +
  'const ORIG = readFileSync("total.mjs","utf8");\n' +
  'try {\n' +
  '  try { chmodSync("total.mjs", 0o644); } catch {}\n' +
  '  writeFileSync("total.mjs","export function total(xs){ return 3; }\\n");\n' +
  '  const out = execSync("node check.mjs").toString();\n' +
  '  console.log("inner:"+out.trim());\n' +
  '} finally {\n' +
  '  writeFileSync("total.mjs", ORIG);\n' +
  '}\n';

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
  mkdirSync('/tmp/opencode', { recursive: true });
  rootDir = mkdtempSync('/tmp/opencode/ab-a-');
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

describe('A: snapshot-local tamper must not PASS', () => {
  it('refuses snapshot-local swap+restore (evil executed, attribution denied)', async () => {
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'attack-local.mjs': ATTACK_LOCAL_MJS,
    });
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], dir);
    const result = await runTestsOnImmutableSnapshot({
      dir,
      scopePaths: ['total.mjs', 'check.mjs', 'attack-local.mjs'],
      testCommand: 'node attack-local.mjs',
      timeoutMs: 60000,
      jobHead,
      keepSnapshotDir: true,
    });
    try {
      // Evil ran inside the snapshot (inner ok) yet attribution is refused.
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/inner:ok/);
      expect(result.verdict).toBe('fail');
      expect(result.reason ?? '').toMatch(/snapshot|restor|mutat|changed during run|identity refused/i);
      // Original untouched (attack was snapshot-local); snapshot copy restored
      // content-wise but its mutation must still be detected via ctime/hash.
      expect(readFileSync(join(dir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
      expect(readFileSync(join(result.snapshotDir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
      // Independent check on committed bytes still fails (real is 2, not 3).
      const indep = await exec(['node', 'check.mjs'], dir);
      expect(indep.exitCode).toBe(1);
    } finally {
      rmSync(result.snapshotDir, { recursive: true, force: true });
    }
  });

  it('runScopeSnapshot (orchestrator public path) refuses snapshot-local swap+restore', async () => {
    const dir = await initRepo({
      'total.mjs': TOTAL_ORIGINAL,
      'check.mjs': CHECK_MJS,
      'attack-local.mjs': ATTACK_LOCAL_MJS,
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
    }).runScopeSnapshot(dir, ['total.mjs', 'check.mjs', 'attack-local.mjs'], 'node attack-local.mjs', 60000, jobHead);
    expect(snap.verdict).toBe('fail');
    expect(snap.success).toBe(false);
    expect(snap.reason ?? snap.output).toMatch(/snapshot|restor|mutat|changed during run|identity refused/i);
    expect(readFileSync(join(dir, 'total.mjs'), 'utf8')).toBe(TOTAL_ORIGINAL);
    const indep = await exec(['node', 'check.mjs'], dir);
    expect(indep.exitCode).toBe(1);
  });
});
