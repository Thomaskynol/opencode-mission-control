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

function stubDataDir(dir: string): () => void {
  const current = paths.getDataDir as unknown as {
    mockResolvedValue?: (v: string) => void;
    mockReset?: () => void;
  };
  if (current && typeof current.mockResolvedValue === 'function') {
    current.mockResolvedValue(dir);
    return () => current.mockReset?.();
  }
  const spy = spyOn(paths, 'getDataDir').mockResolvedValue(dir);
  return () => spy.mockRestore();
}

/**
 * acceptanceLess fallback: a job whose prompt carries NO `- [ ]` acceptance
 * lines has no criterion to judge coverage against. The functional gate still
 * requires product-observed test evidence (command + exit 0 + output +
 * commit on the candidate — never diff alone), so the job merges; but the
 * merge is recorded acceptanceLess: it stays OUT of Verified and lands in
 * Gaps as "no acceptance criteria defined, outcome not verified by criterion".
 *
 * Via the public orchestrator merge path (reconcile with a real MergeTrain),
 * never a harness calling reviewJob directly. TDD: this test FAILS on code
 * without the acceptanceLess fallback (no flag, job counted Verified) and
 * PASSES with it.
 */
describe('acceptanceLess: job without acceptance merges unverified, out of Verified and in Gaps', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let restoreDataDir: () => void = () => {};

  // NOTE: no `- [ ]` line anywhere in the prompt below — that absence is the
  // behavior under test. Do not add acceptance lines here.
  const manualPrompt = 'Write release notes (manual follow-up, no acceptance criteria yet)';

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-accless-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), `console.log('CHECK PASS: smoke');\n`);
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);

    await mustExec(['git', 'checkout', '-b', 'feature-notes', 'main'], repoDir);
    writeFileSync(join(repoDir, 'notes.txt'), 'release notes v1\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add notes'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);

    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], repoDir);
    planState = {
      id: 'plan-accless',
      name: 'accless notes',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('release-notes', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'feature-notes',
          // No worktreePath: deterministic path, no autonomous relaunch.
          touchSet: ['notes.txt'],
          prompt: manualPrompt,
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

    const testStateDir = join(rootDir, 'state');
    mkdirSync(testStateDir, { recursive: true });
    restoreDataDir = stubDataDir(testStateDir);
    monitor = new EventEmitter();
  });

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('merges on scoped evidence but records acceptanceLess: out of Verified, in Gaps', async () => {
    const orchestrator = new Orchestrator(monitor as never, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      testCommand: 'node check.mjs',
    } as never);
    (orchestrator as unknown as { repoRoot: string }).repoRoot = repoDir;
    (orchestrator as unknown as { activePlanId: string }).activePlanId = 'plan-accless';

    for (let i = 0; i < 15; i++) {
      await (orchestrator as unknown as { reconcile: () => Promise<void> }).reconcile();
      const cur = planState!;
      if (cur.jobs.every((j) => j.status === 'merged')) break;
      if (cur.status === 'paused') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Merge occurs on product-observed scoped evidence despite no criteria.
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('release-notes:merged');

    // Evidence is recorded acceptanceLess (merge allowed, not verified).
    // Evidence is recorded acceptanceLess (merge allowed, not verified).
    // NOTE (observed, core owns): the post-all-merged integration smoke
    // re-runs and field-merges scope:'integration' over the review's
    // scope:'task' (the merge-success write downgrades testStatus first, so
    // the global write does not skip); the acceptanceLess flag, pins and
    // passed status survive, which is what the report contract keys on.
    const { loadMergeEvidence } = await import('../../src/lib/durable-state');
    const evidence = await loadMergeEvidence();
    expect(evidence['release-notes']).toBeDefined();
    expect(evidence['release-notes'].testStatus).toBe('passed');
    expect(evidence['release-notes'].acceptanceLess).toBe(true);
    expect(evidence['release-notes'].reviewedCommit).toBe(
      await mustExec(['git', 'rev-parse', 'feature-notes'], repoDir),
    );

    // Final report: out of Verified, in Gaps with the acceptance-less entry.
    const { readFinalReport } = await import('../../src/lib/reports');
    const md = await readFinalReport('plan-accless');
    expect(md).not.toBeNull();
    const verifiedSection = md!.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).not.toContain('release-notes');
    expect(md).toContain('release-notes [merged] — no acceptance criteria defined, outcome not verified by criterion');
  });
});
