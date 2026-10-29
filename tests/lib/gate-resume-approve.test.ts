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
  return { id: `${name}-id`, name, prompt: `do ${name}`, status: 'queued', ...overrides };
}

function fakeControls() {
  return {
    pause: async (name: string) => `paused ${name}`,
    resume: async (name: string) => `resumed ${name}`,
    cancel: async (name: string) => `canceled ${name}`,
    answer: async (name: string, response: string) => `answered ${name}:${response}`,
    launch: async (prompt: string) => `launch ready (${prompt.length} chars)`,
  };
}

async function tempDir(prefix: string): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), prefix));
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
 * Defect 1 (gate pré-merge imergeável): a task whose acceptance cites the
 * global test command must NOT be gated pre-merge on a repo-wide run in the
 * integration worktree WITHOUT its own change (deterministic fail for
 * aggregator tasks), and anchors must not demand acceptance verbatim text in
 * runner stdout. Pre-merge gate is structural-only; the global test runs once
 * post-all-merged. Via the public orchestrator merge path (real MergeTrain).
 */
describe('defect 1: task citing the global test merges structurally pre-merge', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let restoreDataDir: () => void = () => {};

  const checkMjs = `import fs from 'node:fs';
const fail=(m)=>{console.error('CHECK FAIL: '+m);process.exit(1)};
let readme=''; try{readme=fs.readFileSync('README.md','utf8');}catch{fail('missing README.md');}
if(!readme.includes('helpers')) fail('README must document helpers');
console.log('CHECK PASS: docs present');
`;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-gate1-'));
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

    // Aggregator-style job branch: adds ONLY the README (integration without
    // this change can never pass the global check — pre-merge probe fails).
    await mustExec(['git', 'checkout', '-b', 'feature-docs', 'main'], repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# docs\nhelpers: a, b\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'docs'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);

    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], repoDir);
    planState = {
      id: 'plan-gate1',
      name: 'gate1 docs',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('readme-docs', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'feature-docs',
          touchSet: ['README.md'],
          prompt: `Document helpers.\n\nAcceptance criteria:\n- [ ] README documents helpers\n- [ ] node check.mjs passes`,
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

  it('global-citing task merges without an isolated repo-wide probe; global runs post-merge', async () => {
    const orchestrator = new Orchestrator(monitor as never, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      testCommand: 'node check.mjs',
    } as never);
    (orchestrator as unknown as { repoRoot: string }).repoRoot = repoDir;
    (orchestrator as unknown as { activePlanId: string }).activePlanId = 'plan-gate1';

    for (let i = 0; i < 10; i++) {
      await (orchestrator as unknown as { reconcile: () => Promise<void> }).reconcile();
      const cur = planState!;
      if (cur.jobs.every((j) => j.status === 'merged')) break;
      if (cur.status === 'paused') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('readme-docs:merged');
    const final = await exec(['node', 'check.mjs'], integrationWorktree);
    expect(final.exitCode).toBe(0);
    expect(final.stdout).toMatch(/CHECK PASS/);
  });
});

/**
 * Defect 2 (approve --intake não aplica ceiling): the reconciler reactivated
 * by approve runs without the persisted ceiling (missing test command). Via
 * the public CLI path (dispatchCommand), real Orchestrator, mocked resumePlan
 * (no loops) + shutdown observation.
 */
describe('defect 2: approve applies the persisted effective config', () => {
  let testBaseDir: string;
  let testStateDir: string;
  let restoreDataDir: () => void = () => {};
  let planState: PlanSpec | null;

  beforeEach(async () => {
    testBaseDir = await tempDir('mc-approve-ceil-');
    testStateDir = join(testBaseDir, 'state');
    const fs = await import('fs');
    fs.mkdirSync(testStateDir, { recursive: true });
    restoreDataDir = stubDataDir(testStateDir);

    planState = {
      id: 'plan-approve-1',
      name: 'Add retry',
      mode: 'autopilot',
      status: 'paused',
      jobs: [{ id: 'j1', name: 'task-a', prompt: 'do a', status: 'failed' }],
      integrationBranch: 'mc/integration-x',
      integrationWorktree: '/tmp/mc-x',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
      checkpoint: 'on_error',
      checkpointContext: null,
    } as unknown as PlanSpec;
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
        Object.assign(planState, updates);
      },
    );
  });

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    const fs = require('fs');
    if (testBaseDir && fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  });

  it('approve --retry restores ceiling testCommand and shuts down its own loops', async () => {
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand(
      'start Add retry --max-parallel 1 --test-command "node check.mjs"',
      fakeControls() as never,
    );
    const id = started.match(/Intake (\S+) persisted/)![1];

    expect(typeof (Orchestrator.prototype as unknown as { shutdown?: unknown }).shutdown).toBe('function');
    const applySpy = spyOn(Orchestrator.prototype as unknown as { applyCeiling: (c: unknown) => void }, 'applyCeiling');
    const captured: Orchestrator[] = [];
    const resumeSpy = spyOn(Orchestrator.prototype, 'resumePlan').mockImplementation(async function (
      this: Orchestrator,
    ) {
      captured.push(this);
    });
    const shutdownSpy = spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const out = await dispatchCommand(`approve --intake ${id} --retry task-a`, fakeControls() as never);

    expect(out).toMatch(/ready_to_merge/);
    expect(planState!.jobs.find((j) => j.name === 'task-a')!.status).toBe('ready_to_merge');
    expect(applySpy).toHaveBeenCalledWith({ maxParallel: 1, testCommand: 'node check.mjs' });
    expect(resumeSpy).toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].getEffectiveTestCommand()).toBe('node check.mjs');
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

/**
 * Defect 3 (resume limpa checkpoint silenciosamente): resumePlan must keep
 * the on_error pause/checkpoint until an explicit approve, so the message
 * ("aguarda decisão") matches the disk and the public retry path stays open.
 */
describe('defect 3: resume preserves the pause checkpoint until explicit approve', () => {
  let testBaseDir: string;
  let testStateDir: string;
  let restoreDataDir: () => void = () => {};
  let planState: PlanSpec | null;
  let monitor: EventEmitter;

  beforeEach(async () => {
    testBaseDir = await tempDir('mc-resume-keep-');
    testStateDir = join(testBaseDir, 'state');
    const fs = await import('fs');
    fs.mkdirSync(testStateDir, { recursive: true });
    restoreDataDir = stubDataDir(testStateDir);
    monitor = new EventEmitter();

    planState = {
      id: 'plan-resume-1',
      name: 'paused work',
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
        Object.assign(planState, updates);
      },
    );
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => [] as Job[]);
  });

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    const fs = require('fs');
    if (testBaseDir && fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  });

  it('resumePlan keeps a paused plan paused (no silent clear, no driver started)', async () => {
    const orchestrator = new Orchestrator(monitor as never, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as never);
    const startSpy = spyOn(orchestrator as unknown as { startReconciler: () => void }, 'startReconciler').mockImplementation(
      () => {},
    );

    await orchestrator.resumePlan();

    expect(planState!.status).toBe('paused');
    expect((planState as unknown as { checkpoint: unknown }).checkpoint).toBe('on_error');
    expect(startSpy).not.toHaveBeenCalled();
    expect((orchestrator as unknown as { isRunning: boolean }).isRunning).toBe(false);
  });

  it('public resume reports "aguarda decisão" AND the disk stays paused (retry stays open)', async () => {
    const { saveAutoIntake } = await import('../../src/lib/durable-state');
    const { withRepoRoot } = await import('../../src/lib/paths');
    const now = new Date().toISOString();
    const intakeId = 'intake-resume-keep';
    await withRepoRoot('/tmp', async () => {
      await saveAutoIntake({
        id: intakeId,
        request: 'paused work',
        repo: '/tmp',
        requirements: [],
        decisions: [],
        questions: [],
        nextSteps: [],
        status: 'paused',
        createdAt: now,
        updatedAt: now,
      });
    });

    const { Orchestrator: Orch2 } = await import('../../src/lib/orchestrator');
    const orch = new Orch2(monitor as never, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as never);
    const startSpy = spyOn(orch as unknown as { startReconciler: () => void }, 'startReconciler').mockImplementation(
      () => {},
    );

    const out = await withRepoRoot('/tmp', async () =>
      (orch as unknown as { resumeAutonomousIntake: (id: string) => Promise<string> }).resumeAutonomousIntake(intakeId),
    );

    expect(out).toMatch(/Aguardando decisão/);
    expect(planState!.status).toBe('paused');
    expect((planState as unknown as { checkpoint: unknown }).checkpoint).toBe('on_error');
    expect(startSpy).not.toHaveBeenCalled();
  });
});

/**
 * Defect 4 (CLIs penduram como coordenadores secundários): one-shot commands
 * (complement/approve) must shut down the loops they started and exit; start/
 * resume own the coordinator loops by design (documented in HELP); close never
 * stops or discards work.
 */
describe('defect 4: one-shot CLIs exit, coordinator ownership is explicit', () => {
  let testBaseDir: string;
  let testStateDir: string;
  let restoreDataDir: () => void = () => {};
  let planState: PlanSpec | null;

  beforeEach(async () => {
    testBaseDir = await tempDir('mc-cli-life-');
    testStateDir = join(testBaseDir, 'state');
    const fs = await import('fs');
    fs.mkdirSync(testStateDir, { recursive: true });
    restoreDataDir = stubDataDir(testStateDir);

    planState = {
      id: 'plan-cli-1',
      name: 'paused work',
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
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (p: PlanSpec) => {
      planState = clone(p);
    });
    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => [] as Job[]);
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 2 as const,
      jobs: [],
      updatedAt: new Date().toISOString(),
    }));
  });

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    const fs = require('fs');
    if (testBaseDir && fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  });

  it('complement on a paused plan shuts down what it started and returns', async () => {
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand('start Paused work here', fakeControls() as never);
    const id = started.match(/Intake (\S+) persisted/)![1];

    const shutdownSpy = spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const out = await dispatchCommand(`complement --intake ${id} extra follow-up`, fakeControls() as never);

    expect(out).toMatch(/pause respected|paused/i);
    expect(shutdownSpy).toHaveBeenCalled();
  });

  it('HELP documents coordinator ownership (start/resume drive, close never stops work)', async () => {
    const { HELP } = await import('../../src/orchestrator-cli/commands');
    expect(HELP).toMatch(/stays as coordinator/);
    expect(HELP).toMatch(/one-shot/i);
  });

  it('close ends only the view (nothing stopped, nothing discarded)', async () => {
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const out = await dispatchCommand('close', fakeControls() as never);
    expect(out).toMatch(/nothing stopped, nothing discarded/i);
    expect(planState!.status).toBe('paused');
  });
});
