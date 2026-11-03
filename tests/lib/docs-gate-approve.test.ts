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

/**
 * Lane docs2 — RED (gate de docs, approve versionado e touchset CLI ainda não existem).
 *
 * Reproduz o deadlock do REPORT (Achados 2, Run-1/Run-2): tarefa docs-only
 * reprovada para sempre no ramo 2b do classificador funcional + accept que
 * não sobrevive à re-revisão + sem caminho público para editar touchSet.
 */

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

const TRIVIAL_CHECK = `console.log('CHECK PASS: trivial');\n`;
const ACCEPT_DOCS = `Update the README.\n\nAcceptance criteria:\n- [ ] README documents installation (\`bun install\`) and how to run checks (\`bun test\`)`;
const GOOD_README = `# MyApp

Installation: run \`bun install\` to fetch dependencies.

Checks: run \`bun test\` to execute the suite.
`;

describe('docs gate: legit docs-only task merges, illegitimate is rejected', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let restoreDataDir: () => void = () => {};

  async function seedRepo(readme: string) {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-docs-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), TRIVIAL_CHECK);
    writeFileSync(join(repoDir, 'README.md'), '# MyApp\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);
    await mustExec(['git', 'checkout', '-b', 'feature-readme', 'main'], repoDir);
    writeFileSync(join(repoDir, 'README.md'), readme);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'docs: readme'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);
    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], repoDir);
    planState = {
      id: 'plan-docs-1',
      name: 'docs work',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('readme', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'feature-readme',
          touchSet: ['README.md'],
          prompt: ACCEPT_DOCS,
        }),
      ],
      integrationBranch: 'integration',
      integrationWorktree,
      baseCommit,
      createdAt: new Date().toISOString(),
    };
  }

  function mockPlanState() {
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
        if (updates.checkpointContext !== undefined)
          (planState as Record<string, unknown>).checkpointContext = updates.checkpointContext;
        if (updates.checkpoint !== undefined)
          (planState as Record<string, unknown>).checkpoint = updates.checkpoint;
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

  function newOrchestrator(fencing?: { token: string; epoch: number }): Orchestrator {
    const o = new Orchestrator(monitor as never, makeConfig());
    (o as unknown as { repoRoot: string }).repoRoot = repoDir;
    (o as unknown as { activePlanId: string }).activePlanId = 'plan-docs-1';
    if (fencing) {
      (o as unknown as { conductorToken: string }).conductorToken = fencing.token;
      (o as unknown as { conductorEpoch: number }).conductorEpoch = fencing.epoch;
    }
    return o;
  }

  /** Emulate the live driver picking up after approve: the test process
   * assumes the conductor role (the spawned child dies in test env), so the
   * driven reconcile carries fencing identity like the production driver. */
  async function assumeDriverRole(): Promise<{ token: string; epoch: number }> {
    const { takeoverConductorLease } = await import('../../src/lib/plan-state');
    const { lease } = await takeoverConductorLease(
      'plan-docs-1',
      process.pid,
      'test-driver (assume live-driver role after approve)',
      'test-driver',
      repoDir,
      'test assumes the live-driver role: the spawned child exits in test env',
    );
    return { token: lease.token, epoch: lease.epoch };
  }

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('legit README-only task passes the docs gate and merges (no function test demanded)', async () => {
    await seedRepo(GOOD_README);
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('readme:merged');
  });

  it('illegitimate docs task (placeholder, missing criteria) is REJECTED and pauses', async () => {
    await seedRepo('TODO\n');
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.jobs[0].status).toBe('failed');
    expect(planState!.status).toBe('paused');
    expect(planState!.jobs[0].error ?? '').toMatch(/README|bun install|trivial|docs/i);
  });

  it('fixed docs + public approve --retry revalidates and merges (retry/relaunch converge)', async () => {
    await seedRepo('TODO\n');
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.status).toBe('paused');

    // Operator fixes the docs on the job branch (public equivalent: edit + commit).
    await mustExec(['git', 'checkout', 'feature-readme'], repoDir);
    writeFileSync(join(repoDir, 'README.md'), GOOD_README);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'docs: complete readme'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand(
      `start Docs work --repo ${repoDir} --max-parallel 1 --test-command "node check.mjs"`,
      fakeControls() as never,
    );
    const id = started.match(/Intake (\S+) persisted/)![1];
    const resumeSpy = spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    const shutdownSpy = spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const out = await dispatchCommand(`approve --intake ${id} --retry readme`, fakeControls() as never);
    expect(out).toMatch(/ready_to_merge/);
    expect(shutdownSpy).toHaveBeenCalled();
    expect(resumeSpy).toHaveBeenCalled();

    await driveRound(newOrchestrator(await assumeDriverRole()));
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('readme:merged');
  });
});

describe('approve/accept: version-bound, survives resume, stale content re-reviews', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let restoreDataDir: () => void = () => {};

  const wrongTotalMjs = `export function total(xs){ return 0; }\n`;
  const ACCEPT_FN = `Implement total().\n\nAcceptance criteria:\n- [ ] total([1,2])===3`;

  async function seedFunctionalRepo() {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-accept-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), TRIVIAL_CHECK);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);
    await mustExec(['git', 'checkout', '-b', 'feature-total', 'main'], repoDir);
    writeFileSync(join(repoDir, 'total.mjs'), wrongTotalMjs);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'wrong total'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);
    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], repoDir);
    planState = {
      id: 'plan-accept-1',
      name: 'accept work',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('sum-total', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'feature-total',
          touchSet: ['total.mjs', 'check.mjs'],
          prompt: ACCEPT_FN,
        }),
      ],
      integrationBranch: 'integration',
      integrationWorktree,
      baseCommit,
      createdAt: new Date().toISOString(),
    };
  }

  function mockPlanState() {
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
        if (updates.checkpointContext !== undefined)
          (planState as Record<string, unknown>).checkpointContext = updates.checkpointContext;
        if (updates.checkpoint !== undefined)
          (planState as Record<string, unknown>).checkpoint = updates.checkpoint;
      },
    );
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

  function newOrchestrator(fencing?: { token: string; epoch: number }): Orchestrator {
    const o = new Orchestrator(monitor as never, makeConfig());
    (o as unknown as { repoRoot: string }).repoRoot = repoDir;
    (o as unknown as { activePlanId: string }).activePlanId = 'plan-accept-1';
    if (fencing) {
      (o as unknown as { conductorToken: string }).conductorToken = fencing.token;
      (o as unknown as { conductorEpoch: number }).conductorEpoch = fencing.epoch;
    }
    return o;
  }

  /** Emulate the live driver picking up after approve (see docs-gate suite). */
  async function assumeDriverRole(): Promise<{ token: string; epoch: number }> {
    const { takeoverConductorLease } = await import('../../src/lib/plan-state');
    const { lease } = await takeoverConductorLease(
      'plan-accept-1',
      process.pid,
      'test-driver (assume live-driver role after approve)',
      'test-driver',
      repoDir,
      'test assumes the live-driver role: the spawned child exits in test env',
    );
    return { token: lease.token, epoch: lease.epoch };
  }

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('public accept records a version-bound approval; resume honors it once without re-review loop', async () => {
    await seedFunctionalRepo();
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.status).toBe('paused');
    expect(planState!.jobs[0].status).toBe('failed');

    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand(
      `start Accept work --repo ${repoDir} --max-parallel 1 --test-command "node check.mjs"`,
      fakeControls() as never,
    );
    const id = started.match(/Intake (\S+) persisted/)![1];
    spyOn(
      Orchestrator.prototype as unknown as { resumePlan: (r?: string) => Promise<void> },
      'resumePlan',
    ).mockImplementation(async () => {});
    spyOn(
      Orchestrator.prototype as unknown as { shutdown: () => void },
      'shutdown',
    ).mockImplementation(() => {});

    const jobHead = await mustExec(['git', 'rev-parse', 'feature-total'], repoDir);
    const out = await dispatchCommand(`approve --intake ${id}`, fakeControls() as never);
    expect(out).toMatch(/resuming|cleared/i);
    const approval = (planState!.jobs[0] as JobSpec & { reviewApproval?: { reviewedCommit: string } })
      .reviewApproval;
    expect(approval?.reviewedCommit).toBe(jobHead);
    expect(planState!.jobs[0].status).toBe('ready_to_merge');

    // Resume after accept: the SAME version merges without another fail cycle.
    await driveRound(newOrchestrator(await assumeDriverRole()));
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('sum-total:merged');
  });

  it('stale approval (content changed after accept) re-reviews instead of merging', async () => {
    await seedFunctionalRepo();
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.status).toBe('paused');

    // Operator accepts commit A, then the branch advances to commit B (still wrong).
    const headA = await mustExec(['git', 'rev-parse', 'feature-total'], repoDir);
    await mustExec(['git', 'checkout', 'feature-total'], repoDir);
    writeFileSync(join(repoDir, 'total.mjs'), `export function total(xs){ return 1; }\n`);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'still wrong'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);
    const headB = await mustExec(['git', 'rev-parse', 'feature-total'], repoDir);
    expect(headB).not.toBe(headA);

    await (planStateMod.updatePlanJob as (p: string, n: string, u: Partial<JobSpec>) => Promise<void>)(
      'plan-accept-1',
      'sum-total',
      {
        status: 'ready_to_merge',
        error: undefined,
        reviewApproval: {
          reviewedCommit: headA,
          reviewedBase: planState!.baseCommit,
          reason: 'operator accept of an old version',
          at: new Date().toISOString(),
          kind: 'accept',
        },
      } as Partial<JobSpec>,
    );
    await (planStateMod.updatePlanFields as (p: string, u: Partial<PlanSpec>) => Promise<void>)(
      'plan-accept-1',
      { status: 'running', checkpoint: null, checkpointContext: null } as unknown as Partial<PlanSpec>,
    );

    await driveRound(newOrchestrator());
    // New content invalidates the old accept: re-reviewed and rejected, never merged.
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).not.toContain('merged');
    expect(planState!.jobs[0].status).toBe('failed');
    expect(planState!.status).toBe('paused');
  });
});

describe('touchset CLI: editable scope on the public path, pause preserved', () => {
  let testStateDir: string;
  let baseDir: string;
  let restoreDataDir: () => void = () => {};
  let planState: PlanSpec | null;

  beforeEach(async () => {
    const fs = await import('fs');
    baseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-touchset-'));
    testStateDir = join(baseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    restoreDataDir = stubDataDir(testStateDir);
    planState = {
      id: 'plan-touch-1',
      name: 'touch work',
      mode: 'autopilot',
      status: 'paused',
      jobs: [
        makeJob('readme', {
          status: 'failed',
          branch: 'feature-readme',
          touchSet: ['README.md'],
          prompt: ACCEPT_DOCS,
          error: 'touchSet violation',
        }),
        makeJob('code', {
          status: 'failed',
          branch: 'feature-code',
          touchSet: ['src/*.js'],
          prompt: 'Build it.\n\nAcceptance criteria:\n- [ ] src/main.js exists',
          error: 'review blocked',
        }),
      ],
      integrationBranch: 'mc/integration-x',
      integrationWorktree: '/tmp/mc-x',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'readme', failureKind: 'touchset' },
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
  });

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    const fs = require('fs');
    if (baseDir && fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('widens a touchSet, keeps the pause, and audits the change', async () => {
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand('start Touch work here', fakeControls() as never);
    const id = started.match(/Intake (\S+) persisted/)![1];
    const out = await dispatchCommand(
      `touchset --intake ${id} readme README.md docs/`,
      fakeControls() as never,
    );
    expect(out).toMatch(/README\.md.*docs\/|touchSet.*readme/i);
    expect(planState!.jobs.find((j) => j.name === 'readme')!.touchSet).toEqual(['README.md', 'docs/']);
    expect(planState!.status).toBe('paused');
    expect(planState!.checkpoint).toBe('on_error');
  });

  it('refuses overlap with a sibling scope unless a dependency links them', async () => {
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand('start Touch work here', fakeControls() as never);
    const id = started.match(/Intake (\S+) persisted/)![1];
    const err = await dispatchCommand(
      `touchset --intake ${id} readme README.md src/main.js`,
      fakeControls() as never,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/overlap|dependsOn|code/i);
    expect(planState!.jobs.find((j) => j.name === 'readme')!.touchSet).toEqual(['README.md']);
  });

  it('refuses to narrow below the acceptance file refs (incoherent scope)', async () => {
    const { dispatchCommand } = await import('../../src/orchestrator-cli/commands');
    const started = await dispatchCommand('start Touch work here', fakeControls() as never);
    const id = started.match(/Intake (\S+) persisted/)![1];
    const err = await dispatchCommand(`touchset --intake ${id} code src/other.js`, fakeControls() as never).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/coheren|acceptance|src\/main\.js/i);
    expect(planState!.jobs.find((j) => j.name === 'code')!.touchSet).toEqual(['src/*.js']);
  });

  it('is listed in HELP next to approve/resume', async () => {
    const { HELP } = await import('../../src/orchestrator-cli/commands');
    expect(HELP).toMatch(/touchset/);
  });
});

describe('reviewApproval survives a plan save/load round-trip (resume keeps the accept)', () => {
  it('PlanSpecSchema preserves the version-bound approval', async () => {
    const { PlanSpecSchema } = await import('../../src/lib/schemas');
    const plan = {
      id: 'p1',
      name: 'n',
      mode: 'autopilot',
      status: 'paused',
      jobs: [
        {
          id: 'j1',
          name: 'readme',
          prompt: 'do docs',
          status: 'ready_to_merge',
          branch: 'feature-readme',
          reviewApproval: {
            reviewedCommit: 'abc1234',
            reviewedBase: 'def5678',
            reason: 'operator accept',
            at: new Date().toISOString(),
            kind: 'accept',
          },
        },
      ],
      integrationBranch: 'integration',
      baseCommit: 'def5678',
      createdAt: new Date().toISOString(),
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'readme', failureKind: 'test_failure' },
    };
    const parsed = PlanSpecSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(
      (parsed.jobs[0] as unknown as { reviewApproval?: { reviewedCommit: string } }).reviewApproval
        ?.reviewedCommit,
    ).toBe('abc1234');
  });
});
