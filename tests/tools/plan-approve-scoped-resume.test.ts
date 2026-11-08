import { describe, expect, it, mock, spyOn, beforeEach } from 'bun:test';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';

const { mc_plan_approve } = await import('../../src/tools/plan-approve');

const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: mock(),
  ask: mock(),
} as any;

describe('R2 scoped resume: retry ready_to_merge bloqueado por pausa de outro job', () => {
  beforeEach(() => {
    mock.restore();
    spyOn(config, 'loadConfig').mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
  });

  it('permite --retry de ready_to_merge quando pausa on_error é de outro job (twin/dancedocs)', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-r2',
      name: 'R2 Plan',
      mode: 'autopilot',
      status: 'paused',
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'dancedocs', failureKind: 'job_failed' },
      jobs: [
        { id: 'j1', name: 'twin', prompt: 'do twin', status: 'ready_to_merge', branch: 'mc/twin' },
        { id: 'j2', name: 'dancedocs', prompt: 'do docs', status: 'failed', error: 'agent failed' },
      ],
      integrationBranch: 'mc/integration/plan-r2',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as any);

    const mockUpdatePlanJob = spyOn(planState, 'updatePlanJob').mockResolvedValue(undefined);
    const mockUpdatePlanFields = spyOn(planState, 'updatePlanFields').mockResolvedValue(undefined);
    const mockResumePlan = mock().mockResolvedValue(undefined);
    spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
    spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

    const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'twin' }, mockContext);

    expect(result).toContain('scoped resume');
    expect(result).toContain('dancedocs');
    expect(result).toContain('stays failed');
    // Falho preservado como failed (sem aceite), ready mantido.
    // Targeted updates: só campos do plano mudam (job ready re-driven).
    expect(mockUpdatePlanJob).not.toHaveBeenCalled();
    expect(mockUpdatePlanFields).toHaveBeenCalledWith('plan-r2', { status: 'running', checkpoint: null, checkpointContext: null });
    expect(mockResumePlan).toHaveBeenCalled();
  });

  it('segue recusando --retry de ready_to_merge quando é o próprio job do checkpoint', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-r2',
      name: 'R2 Plan',
      mode: 'autopilot',
      status: 'paused',
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'twin', failureKind: 'job_failed' },
      jobs: [
        { id: 'j1', name: 'twin', prompt: 'do twin', status: 'ready_to_merge', branch: 'mc/twin' },
      ],
      integrationBranch: 'mc/integration/plan-r2',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as any);

    await expect(
      mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'twin' }, mockContext),
    ).rejects.toThrow('not in a retryable state');
  });

  it('segue recusando --relaunch de ready_to_merge (só retry escopado)', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-r2',
      name: 'R2 Plan',
      mode: 'autopilot',
      status: 'paused',
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'dancedocs', failureKind: 'job_failed' },
      jobs: [
        { id: 'j1', name: 'twin', prompt: 'do twin', status: 'ready_to_merge', branch: 'mc/twin' },
        { id: 'j2', name: 'dancedocs', prompt: 'do docs', status: 'failed', error: 'x' },
      ],
      integrationBranch: 'mc/integration/plan-r2',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as any);

    await expect(
      mc_plan_approve.execute({ checkpoint: 'on_error', relaunch: 'twin' }, mockContext),
    ).rejects.toThrow('not in a retryable state');
  });

  it('permite --retry de failed enquanto running sem pausa (stall pós-resume escopado)', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-r2',
      name: 'R2 Plan',
      mode: 'autopilot',
      status: 'running',
      checkpoint: null,
      checkpointContext: null,
      jobs: [
        { id: 'j1', name: 'twin', prompt: 'do twin', status: 'merged' },
        { id: 'j2', name: 'dancedocs', prompt: 'do docs', status: 'failed', error: 'review blocked' },
        { id: 'j3', name: 'third', prompt: 'do third', status: 'merged' },
      ],
      integrationBranch: 'mc/integration/plan-r2',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as any);

    const mockUpdatePlanJob = spyOn(planState, 'updatePlanJob').mockResolvedValue(undefined);
    const mockUpdatePlanFields = spyOn(planState, 'updatePlanFields').mockResolvedValue(undefined);
    const mockResumePlan = mock().mockResolvedValue(undefined);
    spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
    spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

    const result = await mc_plan_approve.execute({ retry: 'dancedocs' }, mockContext);

    expect(result).toContain('running scoped retry');
    expect(mockUpdatePlanJob).toHaveBeenCalledWith('plan-r2', 'dancedocs', { status: 'ready_to_merge', error: undefined });
    expect(mockResumePlan).toHaveBeenCalled();
  });

  it('segue recusando --relaunch enquanto running sem pausa', async () => {
    spyOn(planState, 'loadPlan').mockResolvedValue({
      id: 'plan-r2',
      name: 'R2 Plan',
      mode: 'autopilot',
      status: 'running',
      checkpoint: null,
      checkpointContext: null,
      jobs: [
        { id: 'j2', name: 'dancedocs', prompt: 'do docs', status: 'failed', error: 'x' },
      ],
      integrationBranch: 'mc/integration/plan-r2',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as any);

    await expect(
      mc_plan_approve.execute({ relaunch: 'dancedocs' }, mockContext),
    ).rejects.toThrow('not paused');
  });
});
