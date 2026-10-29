import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import type { Job } from '../../src/lib/job-state';
import * as planStateMod from '../../src/lib/plan-state';
import * as jobStateMod from '../../src/lib/job-state';
import * as paths from '../../src/lib/paths';
import { Orchestrator } from '../../src/lib/orchestrator';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

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
  if (r.exitCode !== 0) throw new Error(`Command failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status: 'queued',
    ...overrides,
  };
}

/**
 * Gap1 TDD: repo-wide test that only passes with siblings.
 * Two scoped tasks (helpers/a.js, helpers/b.js); global `node check.mjs`
 * requires BOTH. Isolated worktrees have only one sibling -> CHECK FAIL.
 * Integration post-merge (both present) -> CHECK PASS.
 * Must run via the public orchestrator merge path (reconcile with a real
 * MergeTrain), never a harness calling reviewJob directly.
 */
describe('gap1: repo-wide test runs in integration context, not isolated worktree', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let wtA: string;
  let wtB: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let testStateDir: string;
  let restoreDataDir: () => void = () => {};

  const checkMjs = `import fs from 'node:fs';
const fail=(m)=>{console.error('CHECK FAIL: '+m);process.exit(1)};
const must=(c,m)=>{if(!c)fail(m)};
must(fs.existsSync('helpers/a.js'),'missing helpers/a.js');
must(fs.existsSync('helpers/b.js'),'missing helpers/b.js');
const {a}=await import('./helpers/a.js');
const {b}=await import('./helpers/b.js');
must(a()===1,'a() behavior');
must(b()===2,'b() behavior');
console.log('CHECK PASS: siblings present');
`;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-gap1-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), checkMjs);
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);

    // Branch A: helpers/a.js only (isolated: missing b.js -> check FAILS).
    await mustExec(['git', 'checkout', '-b', 'feature-a', 'main'], repoDir);
    mkdirSync(join(repoDir, 'helpers'), { recursive: true });
    writeFileSync(join(repoDir, 'helpers/a.js'), 'export function a(){return 1;}\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add a'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    // Branch B: helpers/b.js only (isolated: missing a.js -> check FAILS).
    await mustExec(['git', 'checkout', '-b', 'feature-b', 'main'], repoDir);
    // helpers dir may not exist on main; recreate.
    try { mkdirSync(join(repoDir, 'helpers'), { recursive: true }); } catch {}
    writeFileSync(join(repoDir, 'helpers/b.js'), 'export function b(){return 2;}\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add b'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    // Integration branch + worktree (post-merge: both siblings present -> PASS).
    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);

    // Isolated worktrees (each missing its sibling -> check FAILS in isolation).
    wtA = join(rootDir, 'wt-a');
    wtB = join(rootDir, 'wt-b');
    await mustExec(['git', 'worktree', 'add', wtA, 'feature-a'], repoDir);
    await mustExec(['git', 'worktree', 'add', wtB, 'feature-b'], repoDir);

    // Sanity: isolated contexts fail, combined integration will pass after merges.
    const isolatedA = await exec(['node', 'check.mjs'], wtA);
    expect(isolatedA.exitCode).not.toBe(0);
    const isolatedB = await exec(['node', 'check.mjs'], wtB);
    expect(isolatedB.exitCode).not.toBe(0);

    // In-memory plan state with REAL repo paths; REAL MergeTrain (no fake).
    planState = null;
    monitor = new EventEmitter();
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], repoDir);
    planState = {
      id: 'plan-gap1',
      name: 'gap1 siblings',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('helper-a', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'feature-a',
          worktreePath: wtA,
          touchSet: ['helpers/a.js'],
          prompt: `Create helpers/a.js worktree-local.\n\nAcceptance criteria:\n- [ ] helpers/a.js exists as ESM\n- [ ] node --check passes`,
        }),
        makeJob('helper-b', {
          status: 'completed',
          mergeOrder: 1,
          branch: 'feature-b',
          worktreePath: wtB,
          touchSet: ['helpers/b.js'],
          prompt: `Create helpers/b.js worktree-local.\n\nAcceptance criteria:\n- [ ] helpers/b.js exists as ESM\n- [ ] node --check passes`,
        }),
      ],
      integrationBranch: 'integration',
      integrationWorktree,
      baseCommit,
      createdAt: new Date().toISOString(),
    };

    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (p: PlanSpec) => {
      planState = clone(p);
    });
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(
      async (planId: string, jobName: string, updates: Partial<JobSpec>) => {
        if (!planState || planState.id !== planId) return;
        planState.jobs = planState.jobs.map((j) => (j.name === jobName ? { ...j, ...updates } : j));
      },
    );
    spyOn(planStateMod, 'updatePlanFields').mockImplementation(
      async (planId: string, updates: Partial<PlanSpec>) => {
        if (!planState || planState.id !== planId) return;
        if (updates.status !== undefined) planState.status = updates.status;
        if (updates.checkpoint !== undefined) (planState as Record<string, unknown>).checkpoint = updates.checkpoint;
        if (updates.checkpointContext !== undefined) (planState as Record<string, unknown>).checkpointContext = updates.checkpointContext;
        if (updates.completedAt !== undefined) planState.completedAt = updates.completedAt;
        if (updates.prUrl !== undefined) (planState as Record<string, unknown>).prUrl = updates.prUrl;
      },
    );
    spyOn(planStateMod, 'clearPlan').mockImplementation(async () => {
      planState = null;
    });

    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => [] as Job[]);
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2 as const,
      jobs: [],
      updatedAt: new Date().toISOString(),
    }));

    // Durable state writes go to temp (never the real XDG dir).
    testStateDir = join(rootDir, 'state');
    mkdirSync(testStateDir, { recursive: true });
    const current = paths.getDataDir as unknown as { mockResolvedValue?: (v: string) => void; mockReset?: () => void };
    if (current && typeof current.mockResolvedValue === 'function') {
      current.mockResolvedValue(testStateDir);
      restoreDataDir = () => current.mockReset?.();
    } else {
      const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
      restoreDataDir = () => spy.mockRestore();
    }
  });

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('merges sibling tasks via integration verification (no isolated repo-wide gate)', async () => {
    const orchestrator = new Orchestrator(monitor as never, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      testCommand: 'node check.mjs',
    } as never);
    (orchestrator as unknown as { repoRoot: string }).repoRoot = repoDir;
    (orchestrator as unknown as { activePlanId: string }).activePlanId = 'plan-gap1';

    // Drive the PUBLIC merge path (reconciler + real MergeTrain), repeatedly
    // until quiescent: each pass merges at most one job, so loop.
    for (let i = 0; i < 10; i++) {
      await (orchestrator as unknown as { reconcile: () => Promise<void> }).reconcile();
      const cur = planState!;
      if (cur.jobs.every((j) => j.status === 'merged')) break;
      if (cur.status === 'paused') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // GREEN: both siblings merged; integration holds both; repo-wide check passes there.
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('helper-a:merged');
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('helper-b:merged');
    const final = await exec(['node', 'check.mjs'], integrationWorktree);
    expect(final.exitCode).toBe(0);
    expect(final.stdout).toMatch(/CHECK PASS/);
  });
});
