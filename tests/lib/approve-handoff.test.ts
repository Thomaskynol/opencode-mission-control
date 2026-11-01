import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as planStateMod from '../../src/lib/plan-state';
import * as paths from '../../src/lib/paths';
import * as durableStateMod from '../../src/lib/durable-state';
import { dispatchCommand } from '../../src/orchestrator-cli/commands';
import { isConductorAlive } from '../../src/orchestrator-cli/auto-commands';
import { Orchestrator } from '../../src/lib/orchestrator';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function fakeControls(): never {
  return {
    pause: async (name: string) => `paused ${name}`,
    resume: async (name: string) => `resumed ${name}`,
    cancel: async (name: string) => `canceled ${name}`,
    answer: async (name: string, response: string) => `answered ${name}:${response}`,
    launch: async (prompt: string) => `launch ready (${prompt.length} chars)`,
  } as never;
}

describe('approve handoff (R04: verifiable conductor, no false live claim)', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let restoreDataDir: () => void = () => {};
  let planState: PlanSpec | null;
  // Real OS children spawned as conductor stand-ins (no tmux needed):
  // liveness is verifiable via kill(pid, 0) and cleaned up after each test.
  let liveChildren: number[] = [];

  const seedPlan = (): void => {
    planState = {
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
    } as unknown as PlanSpec;
  };

  beforeEach(async () => {
    // XDG isolation per test (wire-lane pattern): never inherit or leak the
    // ambient data dir, regardless of file order in the full suite.
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-approve-handoff-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();

    seedPlan();
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (p: PlanSpec) => {
      planState = clone(p);
    });
    // The conductor lease verifies against the real plan file (internal
    // loadPlan bypasses the in-memory mock above), so seed a real copy with
    // the same id — status may go stale, id never does.
    try {
      fs.writeFileSync(join(testStateDir, 'plan.json'), JSON.stringify(planState));
    } catch {}
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
        (require('fs') as typeof import('fs')).rmSync(testBaseDir, {
          recursive: true,
          force: true,
        });
      } catch {}
    }
  });

  /** Real detached child as conductor stand-in: alive and verifiable via pid (no tmux).
   * Simulates the real driver proving assumption: it claims the plan lease
   * itself (pid-alive alone never counts), so the handoff can re-read it. */
  async function spawnRealHolder(intakeId: string): Promise<{ pid: number; command: string }> {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      (child as unknown as { unref?: () => void }).unref?.();
    } catch {}
    const pid = child.pid;
    if (!pid || !isConductorAlive(pid)) {
      throw new Error('test holder did not start');
    }
    liveChildren.push(pid);
    const { loadPlan, claimConductorLease } = await import('../../src/lib/plan-state');
    const plan = await loadPlan().catch(() => null);
    if (plan) {
      await claimConductorLease(plan.id, pid, `resume --intake ${intakeId}`, `test-driver:${pid}`);
    }
    return { pid, command: `resume --intake ${intakeId}` };
  }

  async function startIntake(): Promise<string> {
    const started = await dispatchCommand(
      'start Handoff work here --max-parallel 1 --test-command "node check.mjs"',
      fakeControls(),
    );
    return started.match(/Intake (\S+) persisted/)![1];
  }

  async function readDecisions(id: string): Promise<string> {
    const { loadAutoIntake } = await import('../../src/lib/durable-state');
    const record = await loadAutoIntake(id);
    return (record?.decisions ?? []).join('\n');
  }

  it('names the durable owner with worker evidence plus a live conductor pid (never the dying temp)', async () => {
    const id = await startIntake();

    // Instrumented conductor like the review sonda: resumePlan reports live.
    const resumeSpy = spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async function (this: Orchestrator) {
      (this as unknown as { isRunning: boolean }).isRunning = true;
    });
    const shutdownSpy = spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});
    void resumeSpy;

    let conductorPid = 0;
    const out = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      {
        verifyWorkers: async () => ({ live: 1, total: 1 }),
        spawnConductor: async (intakeId) => {
          const c = await spawnRealHolder(intakeId);
          conductorPid = c.pid;
          return c;
        },
      },
    );

    expect(out).toMatch(/ready_to_merge/);
    expect(planState!.status).toBe('running');
    // Durable owner + independent worker evidence are recorded...
    expect(out).toMatch(/workers live 1\/1/);
    expect(out).toMatch(new RegExp(`plan ${planState!.id}`));
    // ...plus a verifiably live conductor (detached driver, auto-spawned —
    // never a manual step for the user) and the preserved profile...
    expect(out).toMatch(/conductor detached driver pid \d+/);
    expect(out).toMatch(/auto-spawned/);
    expect(out).toMatch(/model .*ceiling /);
    expect(conductorPid).toBeGreaterThan(0);
    expect(isConductorAlive(conductorPid)).toBe(true);
    // ...and the temp controller is never presented as the ongoing conductor.
    expect(out).not.toMatch(/reconciler running in pid/);
    // The handoff decision persisted before the temp controller detached.
    const decisions = await readDecisions(id);
    expect(decisions).toMatch(/handoff:/);
    expect(decisions).toMatch(/workers live 1\/1/);
    expect(decisions).toMatch(new RegExp(`conductor detached driver pid ${conductorPid}`));
    expect(shutdownSpy).toHaveBeenCalled();
  });

  it('previous conductor unavailable + pending work: new handoff with a live child, never the old coordinator', async () => {
    const id = await startIntake();

    // Old coordinator is dead: never live, already shut down.
    const old = { isRunning: false as boolean, shutdown: () => {} };
    old.shutdown();
    expect(old.isRunning).toBe(false);

    const seen: Orchestrator[] = [];
    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async function (this: Orchestrator) {
      seen.push(this);
    });
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    let conductorPid = 0;
    const out = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      {
        verifyWorkers: async () => ({ live: 2, total: 2 }),
        spawnConductor: async (intakeId) => {
          const c = await spawnRealHolder(intakeId);
          conductorPid = c.pid;
          return c;
        },
      },
    );

    expect(out).toMatch(/ready_to_merge/);
    expect(planState!.status).toBe('running');
    // Handoff was established by the NEW controller instance, never the old one...
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(old as unknown as Orchestrator);
    // ...and a real child owns the continuation: verifiably alive, not an
    // object literal, without requiring tmux.
    expect(conductorPid).toBeGreaterThan(0);
    expect(isConductorAlive(conductorPid)).toBe(true);
    expect(out).toMatch(new RegExp(`conductor detached driver pid ${conductorPid}`));
    const decisions = await readDecisions(id);
    expect(decisions).toMatch(new RegExp(`pid ${process.pid}`));
    expect(decisions).toMatch(/workers live 2\/2/);
    expect(decisions).toMatch(new RegExp(`conductor detached driver pid ${conductorPid}`));
  });

  it('fails closed when the handoff record cannot persist (no false success)', async () => {
    const id = await startIntake();

    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    const shutdownSpy = spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});
    spyOn(durableStateMod, 'appendAutoDecision').mockRejectedValue(
      new Error('disk full (probe)'),
    );

    const err = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      {
        verifyWorkers: async () => ({ live: 0, total: 0 }),
        spawnConductor: (intakeId) => spawnRealHolder(intakeId),
      },
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/handoff.*not confirmed|persist/i);
    // Temp hygiene still runs, but no success message was produced.
    expect(shutdownSpy).toHaveBeenCalled();
    const decisions = await readDecisions(id);
    expect(decisions).not.toMatch(/handoff:/);
  });

  it('fails explicitly when no conductor assumes responsibility (no false continuity)', async () => {
    const id = await startIntake();

    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    const shutdownSpy = spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const err = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      {
        verifyWorkers: async () => ({ live: 2, total: 2 }),
        spawnConductor: async () => {
          throw new Error('no driver (probe)');
        },
      },
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no persistent conductor|not confirmed/i);
    expect((err as Error).message).toMatch(/workers live 2\/2/);
    // Temp hygiene runs, but nothing claims continuity.
    expect(shutdownSpy).toHaveBeenCalled();
    const decisions = await readDecisions(id);
    expect(decisions).not.toMatch(/conductor detached driver/);
  });

  it('fails explicitly when the spawned conductor pid is not alive', async () => {
    const id = await startIntake();

    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const err = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      {
        verifyWorkers: async () => ({ live: 1, total: 1 }),
        spawnConductor: async () => ({ pid: -1, command: 'dead (probe)' }),
      },
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not alive|not confirmed/i);
  });

  it('preserves the effective profile/model in the handoff (never silently dropped)', async () => {
    const id = await startIntake();
    // Persist the effective profile the reconciler runs under (triple +
    // ceiling), as startAutonomous does on the real path.
    const { loadAutoIntake, saveAutoIntake } = await import('../../src/lib/durable-state');
    const rec = await loadAutoIntake(id);
    await saveAutoIntake({
      ...rec!,
      effectiveModel: 'opencode-go/muse-spark-1.3-contributor',
      effectiveVariant: 'xhigh',
      ceiling: { maxParallel: 1, testCommand: 'node check.mjs' },
      updatedAt: new Date().toISOString(),
    });

    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const out = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      {
        verifyWorkers: async () => ({ live: 1, total: 1 }),
        spawnConductor: (intakeId) => spawnRealHolder(intakeId),
      },
    );

    expect(out).toMatch(/opencode-go\/muse-spark-1\.3-contributor#xhigh/);
    expect(out).toMatch(/maxParallel=1/);
    expect(out).toMatch(/node check\.mjs/);
    const decisions = await readDecisions(id);
    expect(decisions).toMatch(/opencode-go\/muse-spark-1\.3-contributor#xhigh/);
    expect(decisions).toMatch(/maxParallel=1/);
  });
});
