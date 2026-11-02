import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Job, JobState } from '../../src/lib/job-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import * as integrationMod from '../../src/lib/integration';
import * as jobStateMod from '../../src/lib/job-state';
import * as mergeTrainMod from '../../src/lib/merge-train';
import { Orchestrator } from '../../src/lib/orchestrator';
import * as planStateMod from '../../src/lib/plan-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as worktreeMod from '../../src/lib/worktree';
import * as reportsMod from '../../src/lib/reports';
import { JobMonitor } from '../../src/lib/monitor';

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

function makeRunningJob(name: string, overrides: Partial<Job> = {}): Job {
  return {
    id: `${name}-jid`,
    name,
    worktreePath: `/tmp/wt/${name}`,
    branch: `mc/${name}`,
    tmuxTarget: `mc-${name}`,
    placement: 'session',
    status: 'running',
    prompt: `do ${name}`,
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    planId: 'plan-1',
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
  defaultPlacement: 'session' as const,
  pollInterval: 10000,
  idleThreshold: 300000,
  worktreeBasePath: '/tmp',
  omo: { enabled: false, defaultMode: 'vanilla' as const },
  maxParallel: 3,
};

/** Fake with the conductor surface (start/isActive/pollNow) and call counters. */
class CountingMonitor extends EventEmitter {
  startCalls = 0;
  pollNowCalls = 0;
  private active = false;
  start(): void {
    this.startCalls++;
    this.active = true;
  }
  isActive(): boolean {
    return this.active;
  }
  async pollNow(): Promise<void> {
    this.pollNowCalls++;
  }
}

describe('monitor-autocomplete: ensureMonitorRunning idempotent', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
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
        Object.assign(planState, updates);
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
    spyOn(jobStateMod, 'addJob').mockResolvedValue();
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2,
      jobs: clone(runningJobs),
      updatedAt: new Date().toISOString(),
    }));
    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/job-a');
    spyOn(worktreeMod, 'removeWorktree').mockResolvedValue();
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(tmuxMod, 'isTmuxHealthy').mockResolvedValue(true);
    spyOn(tmuxMod, 'killSession').mockResolvedValue();
    spyOn(tmuxMod, 'killWindow').mockResolvedValue();
    spyOn(tmuxMod, 'sendKeys').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();
    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
  });

  afterEach(() => {
    mock.restore();
  });

  it('startPlan starts the monitor exactly once', async () => {
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

    await orchestrator.startPlan(makePlan({ jobs: [makeJob('a')] }));

    expect(monitor.startCalls).toBe(1);
    expect(monitor.isActive()).toBe(true);
  });

  it('resumePlan starts the monitor and is idempotent when already active', async () => {
    planState = makePlan({ status: 'running', jobs: [makeJob('a', { status: 'queued' })] });
    runningJobs = [];
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

    await orchestrator.resumePlan();
    expect(monitor.startCalls).toBe(1);

    // Second resume must not start again (isActive guard).
    await orchestrator.resumePlan();
    expect(monitor.startCalls).toBe(1);
  });

  it('_doReconcile starts the monitor once across passes (isActive guard)', async () => {
    planState = makePlan({ status: 'running', jobs: [makeJob('a', { status: 'queued' })] });
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await (orchestrator as any)._doReconcile();
    await (orchestrator as any)._doReconcile();

    expect(monitor.startCalls).toBe(1);
    expect(monitor.pollNowCalls).toBe(2);
  });

  it('tolerates a duck-typed monitor without start/isActive and a throwing start', async () => {
    planState = makePlan({ status: 'running', jobs: [makeJob('a', { status: 'queued' })] });
    const bare = new EventEmitter();
    const orchestrator = new Orchestrator(bare as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    // No start/pollNow surface: must not throw, reconcile still advances.
    await (orchestrator as any)._doReconcile();
    expect((orchestrator as any).launchJob).toHaveBeenCalled();

    const throwing = new EventEmitter() as any;
    throwing.start = () => {
      throw new Error('boom');
    };
    throwing.pollNow = async () => {
      throw new Error('poll boom');
    };
    const orchestrator2 = new Orchestrator(throwing as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator2 as any, 'launchJob').mockResolvedValue(undefined);
    planState = makePlan({ status: 'running', jobs: [makeJob('b', { status: 'queued' })] });
    await (orchestrator2 as any)._doReconcile();
    expect((orchestrator2 as any).launchJob).toHaveBeenCalled();
  });
});

describe('monitor-autocomplete: driveMonitorOnce covers missed events', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
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
        Object.assign(planState, updates);
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
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => clone(runningJobs));
    spyOn(jobStateMod, 'addJob').mockResolvedValue();
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2,
      jobs: clone(runningJobs),
      updatedAt: new Date().toISOString(),
    }));
    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/job-a');
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
  });

  afterEach(() => {
    mock.restore();
  });

  it('drives one monitor cycle per reconcile pass', async () => {
    planState = makePlan({ status: 'running', jobs: [makeJob('a', { status: 'queued' })] });
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await (orchestrator as any)._doReconcile();
    expect(monitor.pollNowCalls).toBe(1);
  });

  it('safety net recovers a missed completion even when pollNow is a no-op', async () => {
    // Plan still thinks the job is running; jobs.json already shows completed
    // (the `complete` event was lost). driveMonitorOnce runs first, then the
    // safety net must advance the plan job to completed.
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('stuck', { status: 'running', mergeOrder: 0 })],
    });
    runningJobs = [];
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2,
      jobs: [
        {
          ...makeRunningJob('stuck', { status: 'completed' as const }),
          planId: 'plan-1',
        },
      ],
      updatedAt: new Date().toISOString(),
    }));

    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);

    await (orchestrator as any)._doReconcile();

    expect(monitor.pollNowCalls).toBe(1);
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'stuck', {
      status: 'completed',
    });
  });

  it('safety net recovers a missed failure as failed', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('killed', { status: 'running', mergeOrder: 0 })],
    });
    runningJobs = [];
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2,
      jobs: [
        {
          ...makeRunningJob('killed', { status: 'stopped' as const }),
          planId: 'plan-1',
        },
      ],
      updatedAt: new Date().toISOString(),
    }));

    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    await (orchestrator as any)._doReconcile();

    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'killed', {
      status: 'failed',
      error: 'recovered from missed completion event',
    });
  });
});

describe('monitor-autocomplete: running→completed via reports/pane-exit (pollNow)', () => {
  beforeEach(() => {
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => []);
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(tmuxMod, 'capturePane').mockResolvedValue('Working...\n  ⬝ esc interrupt\n');
    spyOn(tmuxMod, 'captureExitStatus').mockResolvedValue(undefined);
    spyOn(reportsMod, 'readReport').mockResolvedValue(null);
  });

  afterEach(() => {
    mock.restore();
  });

  it('pollNow is the on-demand conductor cover (no interval needed)', async () => {
    const monitor = new JobMonitor();
    expect(monitor.isActive()).toBe(false);
    (jobStateMod.getRunningJobs as any).mockResolvedValue([]);
    await monitor.pollNow();
    expect(jobStateMod.getRunningJobs).toHaveBeenCalled();
    expect(monitor.isActive()).toBe(false);
  });

  it('isActive guards start idempotence on the real monitor', async () => {
    (jobStateMod.getRunningJobs as any).mockResolvedValue([]);
    const monitor = new JobMonitor();
    monitor.start();
    expect(monitor.isActive()).toBe(true);
    const callsAfterFirstStart = (jobStateMod.getRunningJobs as any).mock.calls.length;
    monitor.start();
    // Second start is a no-op: no extra immediate poll.
    expect((jobStateMod.getRunningJobs as any).mock.calls.length).toBe(callsAfterFirstStart);
    monitor.stop();
    expect(monitor.isActive()).toBe(false);
  });

  it('completes a running job via agent report even while the pane is alive', async () => {
    const job = makeRunningJob('rep');
    (jobStateMod.getRunningJobs as any).mockResolvedValue([job]);
    (tmuxMod.isPaneRunning as any).mockResolvedValue(true);
    (reportsMod.readReport as any).mockResolvedValue({
      jobId: job.id,
      jobName: job.name,
      status: 'completed',
      message: 'done',
      timestamp: new Date().toISOString(),
    });
    const updated = jobStateMod.updateJob as any;

    const monitor = new JobMonitor();
    const onComplete = mock();
    monitor.on('complete', onComplete);
    await monitor.pollNow();

    expect(updated).toHaveBeenCalledWith(job.id, expect.objectContaining({ status: 'completed' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('completes via pane exit 0 and fails via non-zero exit', async () => {
    const okJob = makeRunningJob('ok');
    (jobStateMod.getRunningJobs as any).mockResolvedValue([okJob]);
    (tmuxMod.isPaneRunning as any).mockResolvedValue(false);
    (tmuxMod.captureExitStatus as any).mockResolvedValue(0);
    const monitor = new JobMonitor();
    const onComplete = mock();
    monitor.on('complete', onComplete);
    await monitor.pollNow();
    expect(jobStateMod.updateJob).toHaveBeenCalledWith(okJob.id, expect.objectContaining({ status: 'completed' }));
    expect(onComplete).toHaveBeenCalledTimes(1);

    mock.restore();
    spyOn(jobStateMod, 'getRunningJobs').mockResolvedValue([makeRunningJob('bad')]);
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(false);
    spyOn(tmuxMod, 'captureExitStatus').mockResolvedValue(2);
    spyOn(reportsMod, 'readReport').mockResolvedValue(null);

    const monitor2 = new JobMonitor();
    const onFailed = mock();
    monitor2.on('failed', onFailed);
    await monitor2.pollNow();
    expect(jobStateMod.updateJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    );
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

describe('monitor-autocomplete: writeAutoFinalReport best-effort (completed + pre_pr, no push)', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
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
        Object.assign(planState, updates);
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
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => clone(runningJobs));
    spyOn(jobStateMod, 'addJob').mockResolvedValue();
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2,
      jobs: clone(runningJobs),
      updatedAt: new Date().toISOString(),
    }));
    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/job-a');
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
    spyOn(reportsMod, 'readAllReports').mockResolvedValue([]);
  });

  afterEach(() => {
    mock.restore();
  });

  it('writes the auto final report on autopilot completed (no push in tests, PR mocked)', async () => {
    planState = makePlan({
      mode: 'autopilot',
      status: 'running',
      jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
    });
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'createPR').mockResolvedValue('https://example.com/pr/1');
    const writeSpy = spyOn(reportsMod, 'writeFinalReport').mockResolvedValue('/tmp/final-plan-1.md');

    await (orchestrator as any)._doReconcile();

    expect(planState?.status).toBe('completed');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const markdown = writeSpy.mock.calls[0][1] as string;
    // Verified stays empty by construction; merged work lands in Gaps-free sections.
    expect(markdown).toContain('# Final Report');
    expect(markdown).toContain('## Verified');
    expect(markdown).toContain('## Gaps (Unmet / Unverified)');
  });

  it('writes the auto final report on supervisor pre_pr pause without pushing', async () => {
    planState = makePlan({
      mode: 'supervisor',
      status: 'running',
      jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
    });
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    const createPRSpy = spyOn(orchestrator as any, 'createPR');
    const writeSpy = spyOn(reportsMod, 'writeFinalReport').mockResolvedValue('/tmp/final-plan-1.md');

    await (orchestrator as any)._doReconcile();

    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('pre_pr');
    expect(createPRSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('writes the auto final report on fail-closed pre_pr when push needs human auth', async () => {
    planState = makePlan({
      mode: 'autopilot',
      status: 'running',
      jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
    });
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'createPR').mockRejectedValue(
      new Error('refusing without explicit human authorization'),
    );
    const writeSpy = spyOn(reportsMod, 'writeFinalReport').mockResolvedValue('/tmp/final-plan-1.md');

    await (orchestrator as any)._doReconcile();

    // F08: no push/PR without human auth completes LOCALLY instead of
    // pausing — the destination already received the delivery, so the run
    // finishes (completed) with an explicit note, never conditioned on a PR.
    expect(planState?.status).toBe('completed');
    expect(planState?.checkpoint ?? null).toBeNull();
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: reporting failures never fail the run', async () => {
    planState = makePlan({
      mode: 'autopilot',
      status: 'running',
      jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
    });
    (reportsMod.readAllReports as any).mockRejectedValue(new Error('reports gone'));
    spyOn(reportsMod, 'writeFinalReport').mockRejectedValue(new Error('disk gone'));

    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    spyOn(orchestrator as any, 'createPR').mockResolvedValue('https://example.com/pr/9');

    await expect((orchestrator as any)._doReconcile()).resolves.toBeUndefined();
    expect(planState?.status).toBe('completed');
  });
});

describe('monitor-autocomplete: resume without duplicating or reintegrating', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
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
        Object.assign(planState, updates);
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
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => clone(runningJobs));
    spyOn(jobStateMod, 'addJob').mockResolvedValue();
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2,
      jobs: clone(runningJobs),
      updatedAt: new Date().toISOString(),
    }));
    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/job-a');
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'isTmuxHealthy').mockResolvedValue(true);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(tmuxMod, 'killSession').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();
    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
    spyOn(reportsMod, 'readAllReports').mockResolvedValue([]);
    spyOn(reportsMod, 'writeFinalReport').mockResolvedValue('/tmp/final.md');
  });

  afterEach(() => {
    mock.restore();
  });

  it('resume reuses live panes and does not relaunch running jobs', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('alive', { status: 'running', mergeOrder: 0 })],
    });
    runningJobs = [makeRunningJob('alive')];
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    const reconcilerSpy = spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});
    const launchSpy = spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await orchestrator.resumePlan();

    expect(monitor.startCalls).toBe(1);
    expect(reconcilerSpy).toHaveBeenCalled();
    // Resume itself never launches; the follow-up reconcile must not duplicate.
    expect(launchSpy).not.toHaveBeenCalled();

    await (orchestrator as any)._doReconcile();
    expect(launchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'alive' }));
  });

  it('never reintegrates merged work on resume/reconcile', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('old', { status: 'merged', mergeOrder: 0 }),
        makeJob('next', { status: 'queued', mergeOrder: 1 }),
      ],
    });
    runningJobs = [];
    const monitor = new CountingMonitor();
    const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
    const enqueued: string[] = [];
    (orchestrator as any).mergeTrain = {
      queue: [] as JobSpec[],
      enqueue(job: JobSpec) {
        if (!(this.queue as JobSpec[]).some((q) => q.name === job.name)) {
          enqueued.push(job.name);
          (this.queue as JobSpec[]).push(job);
        }
      },
      has(name: string) {
        return (this.queue as JobSpec[]).some((q) => q.name === name);
      },
      getQueue() {
        return [...(this.queue as JobSpec[])];
      },
      async processNext() {
        (this.queue as JobSpec[]).shift();
        return { success: true, mergedAt: new Date().toISOString() };
      },
    };
    spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);
    spyOn(orchestrator as any, 'createPR').mockResolvedValue('https://example.com/pr/1');

    await orchestrator.resumePlan();
    await (orchestrator as any)._doReconcile();

    expect(enqueued).not.toContain('old');

    // Hygiene: resumePlan starts the real background loop — shut it down so
    // its ticks cannot outlive the test and log 'reconcile error' noise once
    // mocks are restored. Condition-based drain, never a fixed sleep.
    (orchestrator as unknown as { stopReconciler?: () => void }).stopReconciler?.();
    const drainStart = Date.now();
    while ((orchestrator as unknown as { isReconciling?: boolean }).isReconciling && Date.now() - drainStart < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((orchestrator as unknown as { isRunning?: boolean }).isRunning).toBe(false);
  });
});
