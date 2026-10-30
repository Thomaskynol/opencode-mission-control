import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as planStateMod from '../../src/lib/plan-state';
import * as paths from '../../src/lib/paths';
import * as durableStateMod from '../../src/lib/durable-state';
import { dispatchCommand } from '../../src/orchestrator-cli/commands';
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
  });

  afterEach(() => {
    mock.restore();
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

  it('names the durable owner with worker evidence instead of claiming the dying temp reconciler', async () => {
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

    const out = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      { verifyWorkers: async () => ({ live: 1, total: 1 }) },
    );

    expect(out).toMatch(/ready_to_merge/);
    expect(planState!.status).toBe('running');
    // Durable owner + independent worker evidence are recorded...
    expect(out).toMatch(/workers live 1\/1/);
    expect(out).toMatch(new RegExp(`plan ${planState!.id}`));
    // ...and the temp controller is never presented as the ongoing conductor,
    // nor is a manual `resume` left as the continuity step.
    expect(out).not.toMatch(/reconciler running in pid/);
    expect(out).not.toMatch(/resume --intake/);
    // The handoff decision persisted before the temp controller detached.
    const decisions = await readDecisions(id);
    expect(decisions).toMatch(/handoff:/);
    expect(decisions).toMatch(/workers live 1\/1/);
    expect(shutdownSpy).toHaveBeenCalled();
  });

  it('previous conductor unavailable + pending work: new handoff without depending on the old coordinator', async () => {
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

    const out = await dispatchCommand(
      `approve --intake ${id} --retry task-a`,
      fakeControls(),
      { verifyWorkers: async () => ({ live: 2, total: 2 }) },
    );

    expect(out).toMatch(/ready_to_merge/);
    expect(planState!.status).toBe('running');
    // Handoff was established by the NEW controller instance, never the old one.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(old as unknown as Orchestrator);
    const decisions = await readDecisions(id);
    expect(decisions).toMatch(new RegExp(`pid ${process.pid}`));
    expect(decisions).toMatch(/workers live 2\/2/);
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
      { verifyWorkers: async () => ({ live: 0, total: 0 }) },
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/handoff.*not confirmed|persist/i);
    // Temp hygiene still runs, but no success message was produced.
    expect(shutdownSpy).toHaveBeenCalled();
    const decisions = await readDecisions(id);
    expect(decisions).not.toMatch(/handoff:/);
  });
});
