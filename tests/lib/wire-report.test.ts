import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { Job, JobState } from '../../src/lib/job-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import * as integrationMod from '../../src/lib/integration';
import * as jobStateMod from '../../src/lib/job-state';
import * as mergeTrainMod from '../../src/lib/merge-train';
import { MergeTrain } from '../../src/lib/merge-train';
import { Orchestrator } from '../../src/lib/orchestrator';
import * as planStateMod from '../../src/lib/plan-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as worktreeMod from '../../src/lib/worktree';
import * as paths from '../../src/lib/paths';
import {
  buildFinalReportMarkdown,
  readFinalReport,
  writeFinalReport,
} from '../../src/lib/reports';
import { requireHumanAuth } from '../../src/lib/integration';
import { mc_pr } from '../../src/tools/pr';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function makePlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    id: 'plan-1',
    name: 'Plan One',
    mode: 'autopilot',
    status: 'pending',
    jobs: [makeJob('job-a')],
    integrationBranch: 'mc/integration-plan-1',
    integrationWorktree: '/tmp/integration-plan-1',
    baseCommit: 'abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

class FakeMonitor extends EventEmitter {}

function makeOrchestrator(monitor: FakeMonitor): Orchestrator {
  return new Orchestrator(monitor as any, {
    defaultPlacement: 'session',
    pollInterval: 10000,
    idleThreshold: 300000,
    worktreeBasePath: '/tmp',
    omo: { enabled: false, defaultMode: 'vanilla' },
    maxParallel: 3,
  } as any);
}

describe('m5/m7 wire: coordinateOnce inside reconcile', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];
  let monitor: FakeMonitor;

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    monitor = new FakeMonitor();

    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
    });
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(
      async (planId: string, jobName: string, updates: Partial<JobSpec>) => {
        if (!planState || planState.id !== planId) return;
        planState.jobs = planState.jobs.map((job) =>
          job.name === jobName ? { ...job, ...updates } : job,
        );
      },
    );
    spyOn(planStateMod, 'updatePlanFields').mockImplementation(
      async (planId: string, updates: Partial<PlanSpec>) => {
        if (!planState || planState.id !== planId) return;
        if (updates.status !== undefined) planState.status = updates.status;
        if (updates.checkpoint !== undefined) planState.checkpoint = updates.checkpoint;
        if (updates.checkpointContext !== undefined) planState.checkpointContext = updates.checkpointContext;
        if (updates.completedAt !== undefined) planState.completedAt = updates.completedAt;
        if (updates.prUrl !== undefined) planState.prUrl = updates.prUrl;
      },
    );
    spyOn(planStateMod, 'clearPlan').mockImplementation(async () => {
      planState = null;
    });
    spyOn(planStateMod, 'validateGhAuth').mockResolvedValue(true);

    spyOn(integrationMod, 'createIntegrationBranch').mockResolvedValue({
      branch: 'mc/integration-plan-1',
      worktreePath: '/tmp/integration-plan-1',
    });
    spyOn(integrationMod, 'deleteIntegrationBranch').mockResolvedValue();

    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => clone(runningJobs));
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => {
      const state: JobState = {
        version: 2,
        jobs: runningJobs,
        updatedAt: new Date().toISOString(),
      };
      return state;
    });

    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/job-a');
    spyOn(worktreeMod, 'removeWorktree').mockResolvedValue();

    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'createWindow').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(tmuxMod, 'killSession').mockResolvedValue();
    spyOn(tmuxMod, 'killWindow').mockResolvedValue();
    spyOn(tmuxMod, 'sendKeys').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();

    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
  });

  afterEach(() => {
    mock.restore();
  });

  it('does not duplicate launches: 1 queued job launches exactly once', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('job-a', { status: 'queued' })],
    });

    const orchestrator = makeOrchestrator(monitor);
    const launchSpy = spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await (orchestrator as any).reconcile();

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'job-a' }));
  });

  it('respects the configured parallel budget under the coordinator clamp', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('j1', { status: 'queued' }),
        makeJob('j2', { status: 'queued' }),
        makeJob('j3', { status: 'queued' }),
      ],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      maxParallel: 2,
    } as any);
    const launchSpy = spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await (orchestrator as any).reconcile();

    // Manual loop (2) + coordinator pass (budget preserved → 0 extra).
    expect(launchSpy).toHaveBeenCalledTimes(2);
  });

  it('re-enqueues a job stuck in merging after a crash without duplicating', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('stuck', { status: 'merging', mergeOrder: 0, branch: 'mc/stuck' })],
    });

    const enqueued: string[] = [];
    const fakeTrain = {
      queue: [] as JobSpec[],
      enqueue(job: JobSpec) {
        // Mirror the idempotent contract: no duplicates by name.
        if (this.queue.some((q) => q.name === job.name)) return;
        enqueued.push(job.name);
        this.queue.push(job);
      },
      has(name: string) {
        return this.queue.some((q) => q.name === name);
      },
      getQueue() {
        return [...this.queue];
      },
      async processNext() {
        this.queue.shift();
        return { success: true, mergedAt: '2026-01-02T00:00:00.000Z' };
      },
    };

    const orchestrator = makeOrchestrator(monitor);
    (orchestrator as any).mergeTrain = fakeTrain;

    await (orchestrator as any).reconcile();

    // Crash recovery enqueues the stuck job exactly once; then it merges.
    expect(enqueued.filter((n) => n === 'stuck')).toHaveLength(1);
    // R2: the merged write threads fencing context (undefined = instance never claimed).
    const mergedCalls = ((planStateMod.updatePlanJob as any).mock.calls as unknown[][]).filter(
      (c) => c[0] === 'plan-1' && c[1] === 'stuck' && (c[2] as { status?: string })?.status === 'merged',
    );
    expect(mergedCalls).toHaveLength(1);
    expect(mergedCalls[0]![2]).toEqual({
      status: 'merged',
      mergedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(mergedCalls[0]![3]).toEqual({ fencing: undefined });
  });
});

describe('m5/m7 wire: single merge queue with identifiers', () => {
  afterEach(() => {
    mock.restore();
  });

  it('enqueue is idempotent: retry does not duplicate the merge', () => {
    const train = new MergeTrain('/tmp/irrelevant-worktree');
    const job: JobSpec = {
      id: 'job-1',
      name: 'alpha',
      prompt: 'do alpha',
      status: 'ready_to_merge',
      branch: 'mc/alpha',
    };
    train.enqueue(job);
    train.enqueue({ ...job });
    train.enqueue({ ...job, id: 'different-id-same-name' });
    expect(train.getQueue()).toHaveLength(1);
    expect(train.has('alpha')).toBe(true);
    expect(train.has('ghost')).toBe(false);
  });
});

describe('m5/m7 wire: empty merge is a no-op success', () => {
  it('merge with no changes does not fail artificially', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mc-wire-empty-'));
    try {
      const repoDir = join(rootDir, 'repo');
      const integrationWorktree = join(rootDir, 'integration-worktree');
      mkdirSync(repoDir, { recursive: true });

      const exec = async (args: string[], cwd: string) => {
        const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
      };
      const mustExec = async (args: string[], cwd: string) => {
        const result = await exec(args, cwd);
        if (result.exitCode !== 0) {
          throw new Error(`Command failed: ${args.join(' ')}\n${result.stderr}`);
        }
      };

      await mustExec(['git', 'init'], repoDir);
      await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
      await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
      writeFileSync(join(repoDir, 'base.txt'), 'base\n');
      await mustExec(['git', 'add', '.'], repoDir);
      await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
      await mustExec(['git', 'branch', '-M', 'main'], repoDir);
      await mustExec(['git', 'branch', 'integration'], repoDir);
      await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
      // Empty branch: same commit, no diff — valid for diagnosis.
      await mustExec(['git', 'branch', 'empty-job', 'integration'], repoDir);

      const train = new MergeTrain(integrationWorktree, { testCommand: 'true' });
      train.enqueue({
        id: 'empty-id',
        name: 'empty-job',
        prompt: 'no changes',
        status: 'ready_to_merge',
        branch: 'empty-job',
      });
      const result = await train.processNext();
      expect(result.success).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('m5/m7 wire: no push/PR without explicit human auth', () => {
  let restoreXdg: (() => void) | undefined;

  beforeEach(async () => {
    // Full-suite isolation: plan-state/config suites vi.mock paths.getDataDir,
    // which leaks a mocked getDataDir (undefined) into this file when bun runs
    // all files in one process. Mock loadPlan explicitly so this guard test
    // does not depend on real FS/global mock state. No src change.
    const { isolateXdg } = await import('../helpers/test-env');
    const iso = await isolateXdg();
    restoreXdg = iso.restore;
    spyOn(planStateMod, 'loadPlan').mockResolvedValue(null);
    // Common-test boundary: prove no external drivers are touched here.
    spyOn(tmuxMod, 'createSession').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'killSession').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    try {
      restoreXdg?.();
    } catch {}
    restoreXdg = undefined;
    mock.restore();
  });

  it('orchestrator.createPR refuses without humanAuth', async () => {
    const orchestrator = makeOrchestrator(new FakeMonitor());
    await expect((orchestrator as any).createPR()).rejects.toThrow(/explicit human authorization/);
    await expect((orchestrator as any).createPR({})).rejects.toThrow(/explicit human authorization/);
    await expect((orchestrator as any).createPR({ humanAuth: false })).rejects.toThrow(
      /explicit human authorization/,
    );
  });

  it('orchestrator.createPR passes the guard with humanAuth (fails later on missing plan)', async () => {
    const orchestrator = makeOrchestrator(new FakeMonitor());
    // Guard passes; with mocked loadPlan=null it fails on the plan lookup,
    // proving the auth check itself did not throw (isolated from FS leakage).
    await expect((orchestrator as any).createPR({ humanAuth: true })).rejects.toThrow(
      /No active plan/,
    );
    // Boundary proof: common tests never touch external drivers.
    expect(tmuxMod.createSession).not.toHaveBeenCalled();
    expect(tmuxMod.killSession).not.toHaveBeenCalled();
  });

  it('mc_pr refuses to push without humanAuth', async () => {
    spyOn(jobStateMod, 'getJobByName').mockResolvedValue({
      id: 'job-1',
      name: 'feature-auth',
      branch: 'mc/feature-auth',
      worktreePath: '/tmp/definitely-not-a-repo-wire-test',
      tmuxTarget: 'mc-feature-auth',
      placement: 'session',
      status: 'running',
      prompt: 'Add OAuth support',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
    } as Job);
    await expect(mc_pr.execute({ name: 'feature-auth' } as any, {} as any)).rejects.toThrow(
      /explicit human authorization/,
    );
    expect(requireHumanAuth).toBeDefined();
  });
});

describe('m7: standardized final report', () => {
  let testBaseDir: string;
  let testStateDir: string;
  let restore: () => void;

  beforeEach(async () => {
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-wire-report-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restore = () => spy.mockRestore();
  });

  afterEach(async () => {
    restore();
    const fs = await import('fs');
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
    mock.restore();
  });

  it('emits every required section with a readable body', () => {
    const markdown = buildFinalReportMarkdown({
      title: 'Wire Report',
      request: 'Wire the coordinator and ship a readable final report.',
      scope: ['coordinateOnce in reconcile', 'final report'],
      architecture: ['Single integrator under file-lock'],
      decisions: ['Gate stays in the merge-train path'],
      tasks: [{ name: 'wire', status: 'merged' }],
      contributions: [{ instance: 'ses_1', job: 'wire', summary: '[completed] done' }],
      files: ['src/lib/orchestrator.ts'],
      branches: ['mc/integration-plan-1', 'mc/wire'],
      integration: { branch: 'mc/integration-plan-1', strategy: 'squash', merged: ['wire'] },
      installUsage: ['bun install', 'bun run build'],
      tests: [{ command: 'bun test', result: 'passed' }],
      evidences: ['build log: Bundled 221 modules'],
      problems: [{ problem: 'empty merge failed commit', solution: 'treat as no-op success' }],
      verified: ['wire [merged]'],
      unmet: [],
      unverified: ['docs [queued] — outcome not verified'],
      limitations: ['no remote push in tests'],
      nextSteps: ['resolve docs, re-run report'],
      preservation: {
        preserved: ['wip [running] — code preserved in mc/wip'],
        closed: ['wire — merged into mc/integration-plan-1'],
        cleanup: [],
      },
      attachments: [{ name: 'wire log', content: 'line1\nline2' }],
    });

    for (const heading of [
      '# Final Report: Wire Report',
      '## Request & Scope',
      '## Architecture & Decisions',
      '## Plan & Tasks',
      '## Per-Instance Contributions',
      '## Files & Branches',
      '## Integration',
      '## Install & Usage',
      '## Tests (Commands & Results)',
      '## Real Evidence',
      '## Problems & Solutions',
      '## Verified',
      '## Gaps (Unmet / Unverified)',
      '## Limitations & Next Steps',
      '## Preservation (Preserved vs Closed vs Cleanup)',
      '## Annexes (Logs & References)',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('wire [merged]');
    expect(markdown).toContain('### Annex A: wire log');
  });

  it('keeps unknown work out of Verified and truncates long annexes explicitly', () => {
    const longLog = `x`.repeat(13000);
    const markdown = buildFinalReportMarkdown({
      title: 'Gaps',
      verified: ['done [merged]'],
      unmet: ['broken [failed]: tests red'],
      unverified: ['todo [queued] — outcome not verified'],
      attachments: [{ name: 'huge log', content: longLog }],
    });

    const verifiedSection = markdown.split('## Verified')[1].split('## Gaps')[0];
    expect(verifiedSection).toContain('done [merged]');
    expect(verifiedSection).not.toContain('todo [queued]');
    expect(markdown).toContain('Unmet: broken [failed]');
    expect(markdown).toContain('Unverified: todo [queued]');
    expect(markdown).toContain('[truncated');
  });

  it('persists and reads back the final report', async () => {
    const markdown = buildFinalReportMarkdown({ title: 'Roundtrip', verified: ['a [merged]'] });
    const filePath = await writeFinalReport('plan-rt', markdown);
    expect(filePath).toContain('final-plan-rt.md');
    expect(await readFinalReport('plan-rt')).toBe(markdown);
  });
});
