// R2/R5/R6 protocol tests: merge-train fencing at the point of effect,
// conservative glob-overlap, and real-entry test-env refusal.
//
// R2: a stale holder (lease now owned by B) calling processNext must be
// refused with NO git commit, rollback, dispatch or persisted-state effect.
// Effects are asserted on git + persisted state, never on summaries.
// R5: touchPatternsOverlap('src/a*.ts','src/*b.ts') overlaps (witness:
// 'src/ab.ts') — reproduced with real Bun.Glob, never minimatch.
// R6: real entries refuse fail-closed under NODE_ENV=test/VITEST=true
// unless MC_ALLOW_TEST_ENV=1; prod branches are proven by bun subprocesses
// spawned WITHOUT test env (clean env => isTestScope false, overlap true).
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join, dirname } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import type { JobSpec } from '../../src/lib/plan-types';
import type { PlanSpec } from '../../src/lib/plan-types';
import { MergeTrain, touchPatternsOverlap } from '../../src/lib/merge-train';
import { assertPlanCoherence } from '../../src/lib/auto-plan';

const SRC_LIB = new URL('../../src/lib/', import.meta.url).pathname;

type TestRepo = {
  rootDir: string;
  repoDir: string;
  integrationWorktree: string;
};

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
  if (r.exitCode !== 0) throw new Error(`Command failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

function makeJob(branch: string): JobSpec {
  return { id: `${branch}-id`, name: branch, prompt: `merge ${branch}`, status: 'ready_to_merge', branch };
}

async function setupRepo(): Promise<TestRepo> {
  const rootDir = mkdtempSync(join(tmpdir(), 'mc-merge-fencing-'));
  const repoDir = join(rootDir, 'repo');
  const integrationWorktree = join(rootDir, 'integration-worktree');
  mkdirSync(repoDir, { recursive: true });
  await mustExec(['git', 'init'], repoDir);
  await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
  await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }, null, 2));
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  await mustExec(['git', 'add', '.'], repoDir);
  await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
  await mustExec(['git', 'branch', '-M', 'main'], repoDir);
  await mustExec(['git', 'branch', 'integration'], repoDir);
  await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
  mkdirSync(join(integrationWorktree, 'node_modules'), { recursive: true });
  return { rootDir, repoDir, integrationWorktree };
}

async function createBranchCommit(repoDir: string, branch: string, file: string, content: string): Promise<void> {
  await mustExec(['git', 'checkout', '-b', branch, 'main'], repoDir);
  writeFileSync(join(repoDir, file), content);
  await mustExec(['git', 'add', file], repoDir);
  await mustExec(['git', 'commit', '-m', `add ${branch}`], repoDir);
  await mustExec(['git', 'checkout', 'main'], repoDir);
}

function makePlan(opts: { id: string; worktree: string; job: JobSpec; baseCommit: string }): PlanSpec {
  return {
    id: opts.id,
    name: `plan ${opts.id}`,
    mode: 'autopilot',
    status: 'running',
    jobs: [opts.job],
    integrationBranch: 'integration',
    integrationWorktree: opts.worktree,
    baseCommit: opts.baseCommit,
    createdAt: new Date().toISOString(),
  };
}

async function freshVerdict(jobBranch: string, worktree: string, repoDir: string) {
  const reviewedCommit = await mustExec(['git', 'rev-parse', jobBranch], repoDir);
  const reviewedBase = await mustExec(['git', 'rev-parse', 'HEAD'], worktree);
  return { verdict: 'pass' as const, blocking: false, reasons: [], jobName: jobBranch, reviewedCommit, reviewedBase };
}

let prevXdg: string | undefined;
let prevAllow: string | undefined;
let dirs: string[] = [];

beforeEach(() => {
  prevXdg = process.env.MC_XDG_DATA_DIR;
  prevAllow = process.env.MC_ALLOW_TEST_ENV;
  const xdg = mkdtempSync(join(tmpdir(), 'mc-fencing-xdg-'));
  process.env.MC_XDG_DATA_DIR = xdg;
  dirs.push(xdg);
  delete process.env.MC_ALLOW_TEST_ENV;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.MC_XDG_DATA_DIR;
  else process.env.MC_XDG_DATA_DIR = prevXdg;
  if (prevAllow === undefined) delete process.env.MC_ALLOW_TEST_ENV;
  else process.env.MC_ALLOW_TEST_ENV = prevAllow;
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  dirs = [];
});

function trackDir(d: string): string { dirs.push(d); return d; }

async function worktreeHead(wt: string): Promise<string> {
  return mustExec(['git', 'rev-parse', 'HEAD'], wt);
}

async function worktreeClean(wt: string): Promise<boolean> {
  const r = await exec(['git', 'status', '--porcelain'], wt);
  return r.exitCode === 0 && r.stdout === '';
}

describe('R2 — merge fencing at the point of effect', () => {
  it('stale holder is refused with no git/state effect (B claimed before the call)', async () => {
    const t = await setupRepo(); trackDir(t.rootDir);
    const { savePlan, loadPlan, claimConductorLease } = await import('../../src/lib/plan-state');
    const job = makeJob('feature-a');
    await createBranchCommit(t.repoDir, 'feature-a', 'a.txt', 'a\n');
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], t.repoDir);
    const plan = makePlan({ id: 'plan-r2-stale', worktree: t.integrationWorktree, job, baseCommit });
    await savePlan(plan, t.repoDir);

    const leaseA = await claimConductorLease(plan.id, process.pid, 'test-A', 'A', t.repoDir);
    const train = new MergeTrain(t.integrationWorktree);
    train.setFencing({ planId: plan.id, repoRoot: t.repoDir, token: leaseA.token, epoch: leaseA.epoch, pid: process.pid });
    train.enqueue(job);

    // B takes over with a live foreign pid (real takeover, epoch bump).
    const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const { claimConductorLease: claimB } = await import('../../src/lib/plan-state');
      await claimB(plan.id, sleeper.pid, 'test-B', 'B', t.repoDir);

      const headBefore = await worktreeHead(t.integrationWorktree);
      const planBefore = JSON.stringify(await loadPlan(t.repoDir));
      const verdict = await freshVerdict('feature-a', t.integrationWorktree, t.repoDir);

      const result = await train.processNext(verdict, { skipTest: true });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.type).toBe('review_blocked');
        expect(result.output ?? '').toMatch(/fencing|stale/i);
      }
      expect(await worktreeHead(t.integrationWorktree)).toBe(headBefore);
      expect(await worktreeClean(t.integrationWorktree)).toBe(true);
      expect(JSON.stringify(await loadPlan(t.repoDir))).toBe(planBefore);
    } finally {
      try { sleeper.kill(); } catch {}
    }
  });

  it('takeover DURING the integration-lock wait is refused on resume (real processes)', async () => {
    const t = await setupRepo(); trackDir(t.rootDir);
    const { savePlan, loadPlan, claimConductorLease } = await import('../../src/lib/plan-state');
    const job = makeJob('feature-b');
    await createBranchCommit(t.repoDir, 'feature-b', 'b.txt', 'b\n');
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], t.repoDir);
    const plan = makePlan({ id: 'plan-r2-wait', worktree: t.integrationWorktree, job, baseCommit });
    await savePlan(plan, t.repoDir);

    const leaseA = await claimConductorLease(plan.id, process.pid, 'test-A', 'A', t.repoDir);
    const train = new MergeTrain(t.integrationWorktree);
    train.setFencing({ planId: plan.id, repoRoot: t.repoDir, token: leaseA.token, epoch: leaseA.epoch, pid: process.pid });
    train.enqueue(job);

    // Child C1 holds the integration lock ~6s: A's processNext suspends on it.
    const holderSrc = join(trackDir(mkdtempSync(join(tmpdir(), 'mc-fencing-scripts-'))), 'holder.ts');
    writeFileSync(holderSrc, [
      `import { withIntegrationLock } from '${SRC_LIB}integration.ts';`,
      `const wt = Bun.argv[2]!; const ms = Number(Bun.argv[3]!);`,
      `await withIntegrationLock(wt, async () => { await new Promise((r) => setTimeout(r, ms)); });`,
    ].join('\n'));
    const holder = Bun.spawn([process.execPath, holderSrc, t.integrationWorktree, '6000'], {
      stdout: 'ignore', stderr: 'pipe',
    });
    try {
      // Wait until the holder really owns the lock (lockfile appears).
      const lockPath = `${t.integrationWorktree}.lock`;
      const deadline = Date.now() + 10000;
      while (!existsSync(lockPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(lockPath)).toBe(true);

      const headBefore = await worktreeHead(t.integrationWorktree);
      const planBefore = JSON.stringify(await loadPlan(t.repoDir));
      const verdict = await freshVerdict('feature-b', t.integrationWorktree, t.repoDir);

      // A calls processNext while still valid -> passes the pre-shift gate,
      // then SUSPENDS on the held lock. Take over WHILE A is suspended.
      const started = Date.now();
      const pending = train.processNext(verdict, { skipTest: true });
      await new Promise((r) => setTimeout(r, 500));
      // Child B (real separate pid) claims mid-wait: the epoch bumps while
      // A is blocked. A must refuse when it resumes, not merge.
      const claimerSrc = join(dirname(holderSrc), 'claimer.ts');
      writeFileSync(claimerSrc, [
        `import { claimConductorLease } from '${SRC_LIB}plan-state.ts';`,
        `const [planId, repoRoot] = Bun.argv.slice(2);`,
        `const lease = await claimConductorLease(planId!, process.pid, 'test-B', 'B', repoRoot);`,
        `console.log(JSON.stringify({ pid: lease.pid, epoch: lease.epoch }));`,
      ].join('\n'));
      const claimProc = Bun.spawn([process.execPath, claimerSrc, plan.id, t.repoDir], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
      });
      const [claimOut, claimErr, claimCode] = await Promise.all([
        new Response(claimProc.stdout).text(), new Response(claimProc.stderr).text(), claimProc.exited,
      ]);
      expect(claimCode).toBe(0);
      expect(claimErr).toBe('');
      expect(JSON.parse(claimOut).epoch).toBe(leaseA.epoch + 1);

      // A resumes when the holder releases (~6s) and must refuse: stale epoch.
      const result = await pending;
      // Proves A really suspended on the lock (not a pre-shift refusal).
      expect(Date.now() - started).toBeGreaterThan(4000);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.type).toBe('review_blocked');
        expect(result.output ?? '').toMatch(/fencing|stale/i);
      }
      expect(await worktreeHead(t.integrationWorktree)).toBe(headBefore);
      expect(await worktreeClean(t.integrationWorktree)).toBe(true);
      expect(JSON.stringify(await loadPlan(t.repoDir))).toBe(planBefore);
    } finally {
      try { holder.kill(); } catch {}
      await holder.exited.catch(() => {});
    }
  }, 30000);

  it('valid fencing still merges (no false refusal)', async () => {
    const t = await setupRepo(); trackDir(t.rootDir);
    const { savePlan, claimConductorLease } = await import('../../src/lib/plan-state');
    const job = makeJob('feature-c');
    await createBranchCommit(t.repoDir, 'feature-c', 'c.txt', 'c\n');
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], t.repoDir);
    const plan = makePlan({ id: 'plan-r2-ok', worktree: t.integrationWorktree, job, baseCommit });
    await savePlan(plan, t.repoDir);

    const lease = await claimConductorLease(plan.id, process.pid, 'test-A', 'A', t.repoDir);
    const headBefore = await worktreeHead(t.integrationWorktree);
    const train = new MergeTrain(t.integrationWorktree);
    train.setFencing({ planId: plan.id, repoRoot: t.repoDir, token: lease.token, epoch: lease.epoch, pid: process.pid });
    train.enqueue(job);
    const verdict = await freshVerdict('feature-c', t.integrationWorktree, t.repoDir);

    const result = await train.processNext(verdict, { skipTest: true });
    expect(result.success).toBe(true);
    expect(await worktreeHead(t.integrationWorktree)).not.toBe(headBefore);
  });

  it('dead holder lease reaps safely (signal 0 + epoch bump + audit, no rm)', async () => {
    const t = await setupRepo(); trackDir(t.rootDir);
    const { savePlan, claimConductorLease, readConductorLease, reapConductorLeaseIfDead } =
      await import('../../src/lib/plan-state');
    const { getDataDir } = await import('../../src/lib/paths');
    const job = makeJob('feature-d');
    await createBranchCommit(t.repoDir, 'feature-d', 'd.txt', 'd\n');
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], t.repoDir);
    const plan = makePlan({ id: 'plan-r2-reap', worktree: t.integrationWorktree, job, baseCommit });
    await savePlan(plan, t.repoDir);

    // B holds the lease, then dies (real dead pid).
    const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    const deadPid = sleeper.pid;
    const leaseB = await claimConductorLease(plan.id, deadPid, 'test-B', 'B', t.repoDir);
    sleeper.kill();
    await sleeper.exited.catch(() => {});
    // Truly dead: signal 0 fails.
    let alive = true;
    try { process.kill(deadPid, 0); alive = true; } catch { alive = false; }
    expect(alive).toBe(false);

    // Conductor file exists before reap (recovery never deletes state by hand).
    const dataDir = await getDataDir(t.repoDir);
    const conductorFile = join(dataDir, 'conductor.json');
    expect(existsSync(conductorFile)).toBe(true);

    const reaped = await reapConductorLeaseIfDead(plan.id, t.repoDir, { command: 'test-reap' });
    expect(reaped.reaped).toBe(true);
    expect(reaped.next?.epoch).toBe(leaseB.epoch + 1);
    expect(reaped.next?.pid).toBe(process.pid);
    // No manual rm: the lease file still exists, now owned by the reaper.
    expect(existsSync(conductorFile)).toBe(true);
    const live = await readConductorLease(t.repoDir);
    expect(live?.pid).toBe(process.pid);
    expect(live?.epoch).toBe(leaseB.epoch + 1);
    // Audit entry persisted beside the lease.
    const auditFile = join(dataDir, 'conductor-audit.jsonl');
    expect(existsSync(auditFile)).toBe(true);
    expect(readFileSync(auditFile, 'utf8')).toMatch(/conductor-reaped/);

    // The reaper can now merge with its fresh fencing.
    const train = new MergeTrain(t.integrationWorktree);
    train.setFencing({ planId: plan.id, repoRoot: t.repoDir, token: reaped.next?.token, epoch: reaped.next?.epoch, pid: process.pid });
    train.enqueue(job);
    const verdict = await freshVerdict('feature-d', t.integrationWorktree, t.repoDir);
    const result = await train.processNext(verdict, { skipTest: true });
    expect(result.success).toBe(true);
  });

  it('reap refuses while the holder is alive', async () => {
    const t = await setupRepo(); trackDir(t.rootDir);
    const { savePlan, claimConductorLease, reapConductorLeaseIfDead } = await import('../../src/lib/plan-state');
    const job = makeJob('feature-e');
    await createBranchCommit(t.repoDir, 'feature-e', 'e.txt', 'e\n');
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], t.repoDir);
    const plan = makePlan({ id: 'plan-r2-no-reap', worktree: t.integrationWorktree, job, baseCommit });
    await savePlan(plan, t.repoDir);

    const leaseA = await claimConductorLease(plan.id, process.pid, 'test-A', 'A', t.repoDir);
    const res = await reapConductorLeaseIfDead(plan.id, t.repoDir);
    expect(res.reaped).toBe(false);
    expect(res.reason).toMatch(/alive/i);
    expect(res.prev?.epoch).toBe(leaseA.epoch);
  });
});

describe('R5 — overlap is real intersection (conservative), with Bun.Glob', () => {
  it("witness pair 'src/a*.ts' x 'src/*b.ts' overlaps (meet at src/ab.ts)", () => {
    expect(touchPatternsOverlap('src/a*.ts', 'src/*b.ts')).toBe(true);
  });

  it('directories and wildcards overlap; guidance names depends/widen/split', () => {
    expect(touchPatternsOverlap('src/', 'src/total.js')).toBe(true);
    expect(touchPatternsOverlap('src/**', 'src/total.js')).toBe(true);
    expect(touchPatternsOverlap('src/**', 'src/**/*.js')).toBe(true);
    const planOf = (entries: Array<{ name: string; touchSet: string[] }>) => ({
      requirements: [{ id: 'r1', text: 'overlap guard', acceptance: ['done'] }],
      tasks: entries.map((e) => ({ name: e.name, prompt: `Do ${e.name}`, touchSet: e.touchSet, acceptance: [`${e.name} works`] })),
      decisions: [], questions: [], nextSteps: [],
    });
    expect(() =>
      assertPlanCoherence(planOf([
        { name: 'task-a', touchSet: ['src/a*.ts'] },
        { name: 'task-b', touchSet: ['src/*b.ts'] },
      ])),
    ).toThrow(/dependsOn|widen|split/i);
  });

  it('legitimate disjoint scopes stay disjoint', () => {
    expect(touchPatternsOverlap('src/*.js', 'src/*.ts')).toBe(false);
    expect(touchPatternsOverlap('src/total.js', 'other/src/total.js')).toBe(false);
    expect(touchPatternsOverlap('src/a*', 'src/b*')).toBe(false);
  });
});

describe('R6 — real entries refuse test env; prod proven in clean bun processes', () => {
  it('assertRealEntryEnv refuses NODE_ENV=test / VITEST=true without override', async () => {
    const { assertRealEntryEnv } = await import('../../src/lib/plan-state');
    const savedNode = process.env.NODE_ENV;
    const savedVitest = process.env.VITEST;
    const savedAllow = process.env.MC_ALLOW_TEST_ENV;
    try {
      process.env.NODE_ENV = 'test';
      delete process.env.VITEST;
      delete process.env.MC_ALLOW_TEST_ENV;
      expect(() => assertRealEntryEnv('start')).toThrow(/MC_ALLOW_TEST_ENV/);
      delete process.env.NODE_ENV;
      process.env.VITEST = 'true';
      expect(() => assertRealEntryEnv('resume')).toThrow(/MC_ALLOW_TEST_ENV/);
      // Explicit non-generic override restores explicitly-scoped runs.
      process.env.MC_ALLOW_TEST_ENV = '1';
      expect(() => assertRealEntryEnv('resume')).not.toThrow();
      // Clean env passes without override.
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      delete process.env.MC_ALLOW_TEST_ENV;
      expect(() => assertRealEntryEnv('start')).not.toThrow();
    } finally {
      if (savedNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNode;
      if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
      if (savedAllow === undefined) delete process.env.MC_ALLOW_TEST_ENV; else process.env.MC_ALLOW_TEST_ENV = savedAllow;
    }
  });

  it('clean bun subprocess proves prod scope (no test env, real Bun.Glob)', async () => {
    const probeSrc = join(trackDir(mkdtempSync(join(tmpdir(), 'mc-r6-probe-'))), 'probe.ts');
    writeFileSync(probeSrc, [
      `import { isTestEnvPresent, assertRealEntryEnv } from '${SRC_LIB}plan-state.ts';`,
      `import { isTestScope } from '${SRC_LIB}orchestrator.ts';`,
      `import { touchPatternsOverlap } from '${SRC_LIB}merge-train.ts';`,
      `const report = {`,
      `  testEnv: isTestEnvPresent(),`,
      `  testScope: isTestScope(),`,
      `  overlap: touchPatternsOverlap('src/a*.ts', 'src/*b.ts'),`,
      `};`,
      `assertRealEntryEnv('start');`,
      `console.log(JSON.stringify(report));`,
    ].join('\n'));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'NODE_ENV' || k === 'VITEST' || k === 'MC_ALLOW_TEST_ENV') continue;
      env[k] = v;
    }
    const proc = Bun.spawn([process.execPath, probeSrc], { stdout: 'pipe', stderr: 'pipe', env });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(err).toBe('');
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report.testEnv).toBe(false);
    expect(report.testScope).toBe(false);
    expect(report.overlap).toBe(true);
  });

  it('real CLI process refuses start under NODE_ENV=test', async () => {
    const cli = new URL('../../src/orchestrator-cli/index.ts', import.meta.url).pathname;
    const proc = Bun.spawn([process.execPath, cli, 'start', '--request', 'probe'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test' },
      cwd: new URL('../../', import.meta.url).pathname,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).not.toBe(0);
    expect(`${out}\n${err}`).toMatch(/MC_ALLOW_TEST_ENV/);
  }, 60000);
});
