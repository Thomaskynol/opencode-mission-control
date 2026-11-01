import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as paths from '../../src/lib/paths';
import { dispatchCommand } from '../../src/orchestrator-cli/commands';
import { isConductorAlive } from '../../src/orchestrator-cli/auto-commands';
import { Orchestrator } from '../../src/lib/orchestrator';

function fakeControls(): never {
  return {
    pause: async (name: string) => `paused ${name}`,
    resume: async (name: string) => `resumed ${name}`,
    cancel: async (name: string) => `canceled ${name}`,
    answer: async (name: string, response: string) => `answered ${name}:${response}`,
    launch: async (prompt: string) => `launch ready (${prompt.length} chars)`,
  } as never;
}

describe('conductor lease + atomic claim (sondas 12/13/15, real state + real pids)', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let restoreDataDir: () => void = () => {};
  let liveChildren: number[] = [];

  beforeEach(async () => {
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-conductor-lease-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(() => {
    mock.restore();
    for (const pid of liveChildren) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    liveChildren = [];
    try {
      restoreDataDir();
    } catch {}
    if (testBaseDir) {
      try {
        (require('fs') as typeof import('fs')).rmSync(testBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  async function spawnRealHolderWithLease(
    intakeId: string,
    repoRoot: string,
  ): Promise<{ pid: number; command: string }> {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      (child as unknown as { unref?: () => void }).unref?.();
    } catch {}
    const pid = child.pid;
    if (!pid || !isConductorAlive(pid)) throw new Error('test holder did not start');
    liveChildren.push(pid);
    // Simulate the REAL driver proving assumption: it claims the plan lease
    // itself (pid alive alone is never enough).
    const { loadPlan, claimConductorLease } = await import('../../src/lib/plan-state');
    const plan = await loadPlan(repoRoot);
    if (!plan) throw new Error('no plan to claim (test setup)');
    await claimConductorLease(plan.id, pid, `resume --intake ${intakeId}`, `test-driver:${pid}`, repoRoot);
    return { pid, command: `resume --intake ${intakeId}` };
  }

  async function startIntake(): Promise<string> {
    const started = await dispatchCommand(
      'start Handoff work here --max-parallel 1 --test-command "node check.mjs"',
      fakeControls(),
    );
    return started.match(/Intake (\S+) persisted/)![1];
  }

  async function seedPausedPlan(): Promise<void> {
    const { savePlan } = await import('../../src/lib/plan-state');
    await savePlan(
      {
        id: 'plan-handoff-1',
        name: 'handoff work',
        mode: 'autopilot',
        status: 'paused',
        jobs: [{ id: 'j1', name: 'task-a', prompt: 'do a', status: 'failed', error: 'tests failed' }],
        integrationBranch: 'mc/integration-x',
        integrationWorktree: '/tmp/mc-x',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
        checkpoint: 'on_error',
        checkpointContext: { jobName: 'task-a', failureKind: 'test_failure' },
      } as unknown as PlanSpec,
      undefined,
    );
  }

  it('PID alive alone is NOT enough: live pid without a lease fails closed', async () => {
    const id = await startIntake();
    await seedPausedPlan();
    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    // Starter returns a LIVE pid that never claims the plan (sonda 13).
    const holder = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      (holder as unknown as { unref?: () => void }).unref?.();
    } catch {}
    const livePid = holder.pid!;
    liveChildren.push(livePid);
    expect(isConductorAlive(livePid)).toBe(true);

    const err = await dispatchCommand(`approve --intake ${id} --retry task-a`, fakeControls(), {
      verifyWorkers: async () => ({ live: 1, total: 1 }),
      spawnConductor: async (intakeId) => ({ pid: livePid, command: `resume --intake ${intakeId}` }),
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/lease|claim|not confirmed|assum/i);
  });

  it('queued-only running plan still requires a conductor (never "next pass" without owner)', async () => {
    const id = await startIntake();
    const { savePlan } = await import('../../src/lib/plan-state');
    await savePlan(
      {
        id: 'plan-queued-1',
        name: 'queued work',
        mode: 'autopilot',
        status: 'running',
        jobs: [{ id: 'j1', name: 'task-a', prompt: 'do a', status: 'queued' }],
        integrationBranch: 'mc/integration-x',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      } as unknown as PlanSpec,
      undefined,
    );
    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    let spawned = 0;
    const out = await dispatchCommand(`approve --intake ${id}`, fakeControls(), {
      verifyWorkers: async () => ({ live: 0, total: 0 }),
      spawnConductor: async (intakeId, repoRoot) => {
        spawned++;
        return spawnRealHolderWithLease(intakeId, repoRoot);
      },
    });

    expect(spawned).toBe(1);
    expect(out).toMatch(/conductor detached driver pid \d+/);
    expect(out).not.toMatch(/armed for next driver pass/);
  });

  it('repeated approve is idempotent: second call reuses the live lease, no second spawn', async () => {
    const id = await startIntake();
    await seedPausedPlan();
    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    let spawned = 0;
    const deps = {
      verifyWorkers: async () => ({ live: 1, total: 1 }),
      spawnConductor: async (intakeId: string, repoRoot: string) => {
        spawned++;
        return spawnRealHolderWithLease(intakeId, repoRoot);
      },
    };
    const first = await dispatchCommand(`approve --intake ${id} --retry task-a`, fakeControls(), deps);
    expect(first).toMatch(/conductor detached driver pid \d+/);
    expect(spawned).toBe(1);

    const second = await dispatchCommand(`approve --intake ${id} --retry task-a`, fakeControls(), deps);
    expect(second).toMatch(/conductor detached driver pid \d+/);
    expect(spawned).toBe(1);
  });

  it('spawn failure is explicit and the plan stays valid for the next resume', async () => {
    const id = await startIntake();
    await seedPausedPlan();
    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const err = await dispatchCommand(`approve --intake ${id} --retry task-a`, fakeControls(), {
      verifyWorkers: async () => ({ live: 1, total: 1 }),
      spawnConductor: async () => {
        throw new Error('no driver (probe)');
      },
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no persistent conductor|not confirmed/i);
    const { loadPlan } = await import('../../src/lib/plan-state');
    const plan = await loadPlan(undefined);
    expect(plan!.status).toBe('running');
    expect(plan!.jobs.find((j) => j.name === 'task-a')!.status).toBe('ready_to_merge');
  });
});
