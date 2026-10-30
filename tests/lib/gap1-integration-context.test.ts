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
 * R01 gap1: sibling tasks under the functional gate. A sibling delivered
 * with the wrong implementation and a green-but-irrelevant suite must NOT
 * merge (the queue blocks behind it, the plan pauses for correction) — even
 * though the old structural gate merged both and only checked post-merge.
 * After correcting the code AND making the test exercise the requirement
 * (missing siblings only skip, never fail), each task re-verifies in its own
 * scope and both merge; the repo-wide check passes post-merge.
 *
 * Via the public orchestrator merge path (reconcile with a real MergeTrain),
 * never a harness calling reviewJob directly. TDD: this test FAILS on the old
 * structural-only gate (wrong sibling merges) and PASSES on the functional
 * gate + correction loop.
 */
describe('R01 gap1: wrong sibling with irrelevant green suite blocks the queue until corrected', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let testStateDir: string;
  let restoreDataDir: () => void = () => {};

  const trivialCheckMjs = `console.log('CHECK PASS: trivial');\n`;
  // Relevant check: asserts each PRESENT helper, skips missing siblings
  // (a sibling merged later must not fail this task's gate), always prints
  // the acceptance anchor next to runner tokens when exercised.
  const relevantCheckMjs = `let failed = false;
const lines = [];
try {
  const { a } = await import('./helpers/a.js');
  if (a() === 1) lines.push('test a()===1: PASS');
  else { lines.push('test a()===1: FAIL'); failed = true; }
} catch { lines.push('note: helpers/a.js missing (sibling pending), skipping'); }
try {
  const { b } = await import('./helpers/b.js');
  if (b() === 2) lines.push('test b()===2: PASS');
  else { lines.push('test b()===2: FAIL'); failed = true; }
} catch { lines.push('note: helpers/b.js missing (sibling pending), skipping'); }
console.log(lines.join('\\n'));
if (failed) process.exit(1);
`;

  function makeConfig() {
    return {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      testCommand: 'node check.mjs',
    } as never;
  }

  function driveRound(orchestrator: Orchestrator): Promise<void> {
    return (async () => {
      for (let i = 0; i < 15; i++) {
        await (orchestrator as unknown as { reconcile: () => Promise<void> }).reconcile();
        const cur = planState!;
        if (cur.jobs.every((j) => j.status === 'merged')) break;
        if (cur.status === 'paused') break;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
  }

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-gap1-')); 
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), trivialCheckMjs);
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);

    // Branch A: WRONG helper (a() returns 0), suite stays green because the
    // trivial check never exercises it.
    await mustExec(['git', 'checkout', '-b', 'feature-a', 'main'], repoDir);
    mkdirSync(join(repoDir, 'helpers'), { recursive: true });
    writeFileSync(join(repoDir, 'helpers/a.js'), 'export function a(){return 0;}\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add wrong a'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    // Branch B: correct helper, same trivial (irrelevant) suite.
    await mustExec(['git', 'checkout', '-b', 'feature-b', 'main'], repoDir);
    try { mkdirSync(join(repoDir, 'helpers'), { recursive: true }); } catch {}
    writeFileSync(join(repoDir, 'helpers/b.js'), 'export function b(){return 2;}\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add b'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);

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
          touchSet: ['helpers/a.js', 'check.mjs'],
          prompt: `Create helpers/a.js worktree-local.\n\nAcceptance criteria:\n- [ ] a()===1`,
        }),
        makeJob('helper-b', {
          status: 'completed',
          mergeOrder: 1,
          branch: 'feature-b',
          touchSet: ['helpers/b.js', 'check.mjs'],
          prompt: `Create helpers/b.js worktree-local.\n\nAcceptance criteria:\n- [ ] b()===2`,
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

  it('wrong sibling is rejected with the queue blocked; correction lets both merge with repo-wide check passing', async () => {
    const newOrchestrator = () => {
      const o = new Orchestrator(monitor as never, makeConfig());
      (o as unknown as { repoRoot: string }).repoRoot = repoDir;
      (o as unknown as { activePlanId: string }).activePlanId = 'plan-gap1';
      return o;
    };

    // Round 1: helper-a is wrong, suite green-but-irrelevant → rejected, the
    // queue blocks behind it (helper-b never attempted), plan pauses.
    await driveRound(newOrchestrator());
    const round1 = planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',');
    expect(round1).not.toContain('merged');
    expect(round1).toContain('helper-a:failed');
    expect(planState!.status).toBe('paused');
    expect(planState!.jobs.find((j) => j.name === 'helper-a')!.error ?? '').toMatch(/do not cover requirement|a\(\)===1/);

    // Correction: fix a() and make the suite exercise the requirements
    // (identical check on both branches so the later merge stays clean).
    await mustExec(['git', 'checkout', 'feature-a'], repoDir);
    writeFileSync(join(repoDir, 'helpers/a.js'), 'export function a(){return 1;}\n');
    writeFileSync(join(repoDir, 'check.mjs'), relevantCheckMjs);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'correct a + relevant check'], repoDir);
    await mustExec(['git', 'checkout', 'feature-b'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), relevantCheckMjs);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'relevant check'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    // Retry: corrected jobs re-report completion, pause cleared.
    for (const name of ['helper-a', 'helper-b']) {
      await (planStateMod.updatePlanJob as (planId: string, jobName: string, updates: Partial<JobSpec>) => Promise<void>)(
        'plan-gap1',
        name,
        { status: 'completed', error: undefined } as Partial<JobSpec>,
      );
    }
    await (planStateMod.updatePlanFields as (planId: string, updates: Partial<PlanSpec>) => Promise<void>)(
      'plan-gap1',
      { status: 'running', checkpoint: null, checkpointContext: null } as unknown as Partial<PlanSpec>,
    );

    // Round 2: each sibling re-verifies in its own scope, both merge, the
    // repo-wide check passes post-merge.
    await driveRound(newOrchestrator());
    const round2 = planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',');
    expect(round2).toContain('helper-a:merged');
    expect(round2).toContain('helper-b:merged');
    const final = await exec(['node', 'check.mjs'], integrationWorktree);
    expect(final.exitCode).toBe(0);
    expect(final.stdout).toMatch(/a\(\)===1/);
    expect(final.stdout).toMatch(/b\(\)===2/);
  });
});
