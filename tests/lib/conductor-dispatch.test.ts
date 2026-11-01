import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { EventEmitter } from 'events';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import type { Job } from '../../src/lib/job-state';
import * as planStateMod from '../../src/lib/plan-state';
import * as jobStateMod from '../../src/lib/job-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as worktreeMod from '../../src/lib/worktree';
import * as portAllocMod from '../../src/lib/port-allocator';
import * as promptFileMod from '../../src/lib/prompt-file';
import * as sdkClientMod from '../../src/lib/sdk-client';
import * as omoMod from '../../src/lib/omo';
import { Orchestrator, shouldUseServeMode } from '../../src/lib/orchestrator';

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return { id: `${name}-id`, name, prompt: `do ${name}`, status: 'queued', ...overrides };
}

function makePlan(jobs: JobSpec[]): PlanSpec {
  return {
    id: 'plan-dispatch-1', name: 'dispatch', mode: 'autopilot', status: 'running',
    jobs, integrationBranch: 'mc/integration-x', integrationWorktree: '/tmp/mc-x',
    baseCommit: 'abc123', createdAt: new Date().toISOString(),
  };
}

class FakeMonitor extends EventEmitter {}

describe('conductor dispatch (sondas 12/15/13, revisão 9f47d5f)', () => {
  let planState: PlanSpec | null;
  let jobs: Job[];
  let monitor: FakeMonitor;

  beforeEach(() => {
    planState = null;
    jobs = [];
    monitor = new FakeMonitor();
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (p: PlanSpec) => { planState = clone(p); });
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(async (planId: string, jobName: string, updates: Partial<JobSpec>) => {
      if (!planState || planState.id !== planId) return;
      planState.jobs = planState.jobs.map((j) => (j.name === jobName ? { ...j, ...updates } : j));
    });
    spyOn(planStateMod, 'updatePlanFields').mockImplementation(async (planId: string, updates: Partial<PlanSpec>) => {
      if (!planState || planState.id !== planId) return;
      if (updates.status !== undefined) planState.status = updates.status;
    });
    spyOn(planStateMod, 'validateGhAuth').mockResolvedValue(true);
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => clone(jobs));
    spyOn(jobStateMod, 'addJob').mockImplementation(async (j: Job) => { jobs.push(clone(j)); });
    spyOn(jobStateMod, 'updateJob').mockImplementation(async (id: string, u: Partial<Job>) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, ...u } : j));
    });
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({ version: 3 as const, jobs: clone(jobs), updatedAt: new Date().toISOString() }));
    spyOn(jobStateMod, 'removeJob').mockResolvedValue();
    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/a');
    spyOn(worktreeMod, 'removeWorktree').mockResolvedValue();
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'createWindow').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'killSession').mockResolvedValue();
    spyOn(tmuxMod, 'killWindow').mockResolvedValue();
    spyOn(tmuxMod, 'sendKeys').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();
    spyOn(portAllocMod, 'allocatePort').mockResolvedValue(14101);
    spyOn(portAllocMod, 'releasePort').mockResolvedValue();
    spyOn(promptFileMod, 'writeServeLauncherScript').mockResolvedValue('/tmp/wt/a/.mc-launch.sh');
    spyOn(promptFileMod, 'cleanupLauncherScript').mockImplementation(() => {});
    spyOn(promptFileMod, 'writePromptFile').mockResolvedValue('/tmp/wt/a/.mc-prompt');
    spyOn(promptFileMod, 'cleanupPromptFile').mockImplementation(() => {});
    spyOn(promptFileMod, 'writeLauncherScript').mockResolvedValue('/tmp/wt/a/.mc-launch.sh');
    spyOn(sdkClientMod, 'v2WaitForServer').mockImplementation(async () => ({ baseUrl: 'http://127.0.0.1:14101/api', headers: {} }));
    spyOn(omoMod, 'detectOMO').mockResolvedValue({ detected: true } as never);
    spyOn(sdkClientMod, 'launchWorkerViaServe').mockImplementation(async (_c: unknown, input: { worktree: string; prompt: string; tmuxTarget?: string; model?: { providerID: string; id: string } }) => ({
      sessionId: 'ses-1', tmuxTarget: input.tmuxTarget,
      requestedModel: input.model ? { ...input.model } : undefined,
      observedModel: input.model ? { ...input.model } : undefined,
    }));
  });

  afterEach(() => { mock.restore(); });

  function newOrch() {
    const orch = new Orchestrator(monitor as never, { defaultPlacement: 'session', pollInterval: 10000, idleThreshold: 300000, worktreeBasePath: '/tmp', omo: { enabled: false, defaultMode: 'vanilla' }, useServeMode: true } as never);
    (orch as unknown as { activePlanId: string }).activePlanId = 'plan-dispatch-1';
    (orch as unknown as { repoRoot: string }).repoRoot = process.cwd();
    spyOn(orch as unknown as { createJobWorktree: () => Promise<string> }, 'createJobWorktree').mockResolvedValue('/tmp/wt/a');
    return orch;
  }

  it('serve é default: {} e ausente servem, só false opta pelo TUI', () => {
    expect(shouldUseServeMode({})).toBe(true);
    expect(shouldUseServeMode({ useServeMode: undefined } as never)).toBe(true);
    expect(shouldUseServeMode({ useServeMode: true })).toBe(true);
    expect(shouldUseServeMode({ useServeMode: false })).toBe(false);
  });

  it('registro antes do prompt: addJob existe quando o launcher roda', async () => {
    planState = makePlan([makeJob('a', { status: 'queued' })]);
    let jobsAtLaunch = -1;
    spyOn(sdkClientMod, 'launchWorkerViaServe').mockImplementation(async (_c: unknown, input: never) => {
      jobsAtLaunch = (await jobStateMod.loadJobState()).jobs.length;
      return { sessionId: 'ses-1', ...(input as object) } as never;
    });
    const orch = newOrch();
    spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: true, status: 'running' } as never);
    await (orch as unknown as { launchJob: (j: JobSpec) => Promise<unknown> }).launchJob(planState!.jobs[0]);
    expect(jobsAtLaunch).toBe(1);
  });

  it('perdedor do claim aborta sem criar/killar nada (sonda 15)', async () => {
    planState = makePlan([makeJob('a', { status: 'running' })]);
    spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: false, status: 'running' } as never);
    const orch = newOrch();
    await (orch as unknown as { launchJob: (j: JobSpec) => Promise<unknown> }).launchJob({ ...planState!.jobs[0], status: 'queued' } as JobSpec);
    expect(tmuxMod.createSession).not.toHaveBeenCalled();
    expect(tmuxMod.killSession).not.toHaveBeenCalled();
    expect(sdkClientMod.launchWorkerViaServe).not.toHaveBeenCalled();
  });

  it('falha antes de createSession não mata homônima (sonda 16)', async () => {
    planState = makePlan([makeJob('a', { status: 'queued' })]);
    spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: true, status: 'running' } as never);
    spyOn(promptFileMod, 'writeServeLauncherScript').mockRejectedValue(new Error('launcher boom'));
    const orch = newOrch();
    await (orch as unknown as { launchJob: (j: JobSpec) => Promise<unknown> }).launchJob(planState!.jobs[0]);
    expect(tmuxMod.createSession).not.toHaveBeenCalled();
    expect(tmuxMod.killSession).not.toHaveBeenCalled();
    expect(tmuxMod.killWindow).not.toHaveBeenCalled();
  });

  it('sem pin observado = fail-closed no launchJob (sonda 11)', async () => {
    planState = makePlan([makeJob('a', { status: 'queued' })]);
    spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: true, status: 'running' } as never);
    spyOn(sdkClientMod, 'launchWorkerViaServe').mockResolvedValue({ sessionId: 'ses-1', requestedModel: { providerID: 'p', id: 'm' } } as never);
    const orch = newOrch();
    await (orch as unknown as { launchJob: (j: JobSpec) => Promise<unknown> }).launchJob(planState!.jobs[0]);
    expect(planState!.jobs[0].status).toBe('failed');
    expect(String(planState!.jobs[0].error ?? '')).toMatch(/observed|pin|model/i);
  });

  it('serve passa agent/title e usa v2RunCommand para /start-work (sonda §5 perfil)', async () => {
    planState = makePlan([makeJob('a', { status: 'queued', mode: 'plan' })]);
    spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: true, status: 'running' } as never);
    const runCmd = spyOn(sdkClientMod, 'v2RunCommand').mockResolvedValue({});
    const orch = newOrch();
    await (orch as unknown as { launchJob: (j: JobSpec) => Promise<unknown> }).launchJob(planState!.jobs[0]);
    expect(sdkClientMod.launchWorkerViaServe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profile: expect.objectContaining({ title: 'a' }) }),
    );
    expect(runCmd).toHaveBeenCalledWith(expect.anything(), 'ses-1', '/start-work', expect.anything());
  });
});
