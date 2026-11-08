import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PlanSpec } from '../../src/lib/plan-types';

// ---------------------------------------------------------------------------
// TMC blockers repro (RED first): 4 operational blockers, one file.
// Each describe fails before the fix for the expected reason and passes
// after. Mocks are identified inline; no real tmux/serve workers.
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    id: 'plan-1',
    name: 'pilot',
    mode: 'supervisor',
    status: 'running',
    jobs: [],
    integrationBranch: 'mc/integration-plan-1',
    baseCommit: 'abc123',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as PlanSpec;
}

// --- Blocker 1: failed launch must not leak owned branches/resources --------
describe('blocker1 launch rollback deletes owned branch', () => {
  it('deleteBranchIfUnused removes an mc/ branch nobody uses', async () => {
    const { deleteBranchIfUnused } = await import('../../src/lib/worktree');
    const fs = await import('fs');
    const dir = fs.mkdtempSync(join(tmpdir(), 'mc-tmc1-'));
    try {
      const run = async (args: string[]) => {
        const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      };
      await run(['init', '-b', 'main']);
      await run(['config', 'user.email', 't@t.t']);
      await run(['config', 'user.name', 't']);
      fs.writeFileSync(join(dir, 'f.txt'), 'x');
      await run(['add', '.']);
      await run(['commit', '-m', 'init']);
      await run(['branch', 'mc/tmc-orphan']);
      const deleted = await deleteBranchIfUnused('mc/tmc-orphan', { cwd: dir });
      expect(deleted.deleted).toBe(true);
      const check = Bun.spawnSync(['git', 'branch', '--list', 'mc/tmc-orphan'], { cwd: dir });
      expect(check.stdout.toString().trim()).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteBranchIfUnused never deletes main or a foreign branch', async () => {
    const { deleteBranchIfUnused } = await import('../../src/lib/worktree');
    const fs = await import('fs');
    const dir = fs.mkdtempSync(join(tmpdir(), 'mc-tmc1b-'));
    try {
      const run = async (args: string[]) => {
        const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      };
      await run(['init', '-b', 'main']);
      await run(['config', 'user.email', 't@t.t']);
      await run(['config', 'user.name', 't']);
      fs.writeFileSync(join(dir, 'f.txt'), 'x');
      await run(['add', '.']);
      await run(['commit', '-m', 'init']);
      await run(['branch', 'feature/other']);
      const mainRes = await deleteBranchIfUnused('main', { cwd: dir });
      expect(mainRes.deleted).toBe(false);
      const foreignRes = await deleteBranchIfUnused('feature/other', { cwd: dir });
      expect(foreignRes.deleted).toBe(false);
      const check = Bun.spawnSync(['git', 'branch', '--list', 'feature/other'], { cwd: dir });
      expect(check.stdout.toString().trim()).toContain('feature/other');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('existing mc/job-2 never marks mc/job as pre-existing (exact ref, no substring)', async () => {
    const { checkBranchPreExisted } = await import('../../src/tools/launch');
    const fs = await import('fs');
    const dir = fs.mkdtempSync(join(tmpdir(), 'mc-tmc1c-'));
    try {
      const run = async (args: string[]) => {
        const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      };
      await run(['init', '-b', 'main']);
      await run(['config', 'user.email', 't@t.t']);
      await run(['config', 'user.name', 't']);
      fs.writeFileSync(join(dir, 'f.txt'), 'x');
      await run(['add', '.']);
      await run(['commit', '-m', 'init']);
      await run(['branch', 'mc/job-2']);
      expect(await checkBranchPreExisted('mc/job', { cwd: dir })).toBe(false);
      expect(await checkBranchPreExisted('mc/job-2', { cwd: dir })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Blocker 2: running + on_error checkpoint is inspectable/resumable -----
describe('blocker2 on_error checkpoint state machine', () => {
  it('persisted on_error checkpoint gates the reconciler even when running', async () => {
    const { planHasOpenCheckpoint } = await import('../../src/lib/plan-types');
    expect(planHasOpenCheckpoint(makePlan({ status: 'running', checkpoint: 'on_error' }))).toBe(true);
    expect(planHasOpenCheckpoint(makePlan({ status: 'running', checkpoint: null }))).toBe(false);
  });

  it('approve accepts running+on_error (not only paused)', async () => {
    const { canClearCheckpoint } = await import('../../src/lib/plan-types');
    expect(canClearCheckpoint(makePlan({ status: 'paused', checkpoint: 'on_error' }))).toBe(true);
    expect(canClearCheckpoint(makePlan({ status: 'running', checkpoint: 'on_error' }))).toBe(true);
    expect(canClearCheckpoint(makePlan({ status: 'running', checkpoint: null }))).toBe(false);
  });

  it('approve retry works on a persisted running+on_error plan (race with fire-and-forget handleJobFailed)', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const plan = makePlan({
      status: 'running',
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'a', failureKind: 'job_failed' },
      jobs: [{ id: 'a-id', name: 'a', prompt: 'do a', status: 'failed', error: 'boom' } as PlanSpec['jobs'][number]],
    });
    const loadSpy = spyOn(planStateMod, 'loadPlan').mockImplementation(async () => JSON.parse(JSON.stringify(plan)));
    const fieldUpdates: unknown[] = [];
    const jobUpdates: unknown[] = [];
    const fieldsSpy = spyOn(planStateMod, 'updatePlanFields').mockImplementation(async (...a: unknown[]) => {
      fieldUpdates.push(a);
    });
    const jobSpy = spyOn(planStateMod, 'updatePlanJob').mockImplementation(async (...a: unknown[]) => {
      jobUpdates.push(a);
    });
    // Stub the heavy tail (orchestrator resume + touchset validation) — the
    // contract under test is only the checkpoint gate, not the merge train.
    const orchMod = await import('../../src/lib/orchestrator');
    const resumeSpy = spyOn(orchMod.Orchestrator.prototype, 'resumePlan').mockImplementation(async () => {});
    const validateMod = await import('../../src/lib/merge-train');
    const touchSpy = spyOn(validateMod, 'validateTouchSet').mockImplementation(async () => ({ valid: true } as never));
    try {
      const { mc_plan_approve } = await import('../../src/tools/plan-approve');
      const out = await mc_plan_approve.execute({ retry: 'a' }, undefined as never);
      expect(String(out)).toMatch(/re-driven|reset to ready_to_merge|scoped retry/i);
      // Targeted updates win over whole-snapshot savePlan (no clobber of
      // concurrent monitor writes): job reset + checkpoint cleared.
      expect(jobUpdates.length).toBeGreaterThan(0);
      expect(fieldUpdates.length).toBeGreaterThan(0);
    } finally {
      loadSpy.mockRestore();
      fieldsSpy.mockRestore();
      jobSpy.mockRestore();
      resumeSpy.mockRestore();
      touchSpy.mockRestore();
    }
  });
});

// --- Blocker 3: port.lock ownership + dead-holder recovery -----------------
describe('blocker3 port lock ownership', () => {
  let testDataDir: string;
  let restorePaths: (() => void) | undefined;

  async function freeBase(count: number): Promise<number> {
    for (let base = 26000; base < 30000; base++) {
      let ok = true;
      for (let p = base; p < base + count; p++) {
        try {
          Bun.serve({ port: p, hostname: '127.0.0.1', fetch: () => new Response('probe') }).stop(true);
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) return base;
    }
    throw new Error('no free port block');
  }

  beforeEach(async () => {
    const fs = await import('fs');
    testDataDir = fs.mkdtempSync(join(tmpdir(), 'mc-tmc3-'));
    const paths = await import('../../src/lib/paths');
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testDataDir);
    restorePaths = () => spy.mockRestore();
  });

  afterEach(async () => {
    restorePaths?.();
    const fs = await import('fs');
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  it('release by a foreign process never removes a live holder port', async () => {
    const { allocatePort, readLockedPorts } = await import('../../src/lib/port-allocator');
    const base = await freeBase(4);
    const config = { defaultPlacement: 'session', portRangeStart: base, portRangeEnd: base + 3 } as never;
    const port = await allocatePort(config, []);
    const { releasePort } = await import('../../src/lib/port-allocator');
    await releasePort(port, { ownerPid: 2147483647 });
    const locked = await readLockedPorts();
    expect(locked.map((e) => (typeof e === 'number' ? e : e.port))).toContain(port);
  });

  it('dead-holder ports are reaped with an audit trail instead of leaking', async () => {
    const mod = await import('../../src/lib/port-allocator');
    const base = await freeBase(4);
    const config = { defaultPlacement: 'session', portRangeStart: base, portRangeEnd: base + 3 } as never;
    // Simulate a holder that died (kill -9, no release): pid that cannot exist.
    const deadPid = 2147483647;
    await mod.allocatePortWithOwner(config, [], { ownerPid: deadPid });
    const reaped = await mod.reapDeadPortHolders();
    expect(reaped.length).toBeGreaterThan(0);
    const fs = await import('fs');
    expect(fs.existsSync(join(testDataDir, 'port-audit.jsonl'))).toBe(true);
  });

  it('legacy ownerless entry older than TTL is reaped by allocate (no range exhaustion)', async () => {
    const mod = await import('../../src/lib/port-allocator');
    const base = await freeBase(4);
    const config = { defaultPlacement: 'session', portRangeStart: base, portRangeEnd: base + 3 } as never;
    // Legacy format: unknown owner (pid 0), last touched before the TTL.
    const fs = await import('fs');
    const oldTs = new Date(Date.now() - mod.PORT_LOCK_TTL_MS - 60_000).toISOString();
    fs.writeFileSync(join(testDataDir, 'port.lock'), JSON.stringify([{ port: base, pid: 0, ts: oldTs }]));
    const port = await mod.allocatePort(config, []);
    expect(port).toBe(base);
    const locked = await mod.readLockedPorts();
    expect(locked.some((e) => e.port === base && e.pid !== 0)).toBe(true);
  });

  it('fresh legacy entry is kept by allocate (fail-closed, no steal)', async () => {
    const mod = await import('../../src/lib/port-allocator');
    const base = await freeBase(4);
    const config = { defaultPlacement: 'session', portRangeStart: base, portRangeEnd: base + 3 } as never;
    const fs = await import('fs');
    fs.writeFileSync(join(testDataDir, 'port.lock'), JSON.stringify([{ port: base, pid: 0, ts: new Date().toISOString() }]));
    const port = await mod.allocatePort(config, []);
    expect(port).toBe(base + 1);
  });
});

// --- Blocker 4: review verdict persisted + visible --------------------------
describe('blocker4 verdict visible in plan-status/overview', () => {
  it('plan-status shows checkpoint context, latest report and review verdict', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const reportsMod = await import('../../src/lib/reports');
    const plan = makePlan({
      status: 'paused',
      checkpoint: 'on_error',
      checkpointContext: { jobName: 'a', failureKind: 'test_failure' },
      jobs: [{ id: 'a-id', name: 'a', prompt: 'do a', status: 'failed', error: 'tests red' } as PlanSpec['jobs'][number]],
    });
    const loadSpy = spyOn(planStateMod, 'loadPlan').mockImplementation(async () => JSON.parse(JSON.stringify(plan)));
    const repSpy = spyOn(reportsMod, 'readAllReports').mockImplementation(async () => [
      { jobId: 'a-id', jobName: 'a', status: 'blocked', message: 'tests red on login', timestamp: new Date().toISOString() } as never,
    ]);
    const verSpy = spyOn(reportsMod, 'readAllReviewVerdicts').mockImplementation(async () => [
      { jobId: 'a-id', jobName: 'a', verdict: 'fail', commit: 'deadbee123', baseCommit: 'base1000', transport: 'serve', reason: 'tests red', timestamp: new Date().toISOString() },
    ]);
    try {
      const { mc_plan_status } = await import('../../src/tools/plan-status');
      const out = String(await mc_plan_status.execute({}, undefined as never));
      expect(out).toMatch(/on_error/);
      expect(out).toMatch(/tests red on login/);
      expect(out).toMatch(/deadbee/);
    } finally {
      loadSpy.mockRestore();
      repSpy.mockRestore();
      verSpy.mockRestore();
    }
  });

  it('plan-status never shows a stale same-name verdict as current (explicit stale with old jobId)', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const reportsMod = await import('../../src/lib/reports');
    const plan = makePlan({
      status: 'running',
      jobs: [{ id: 'a-new', name: 'a', prompt: 'do a', status: 'running' } as PlanSpec['jobs'][number]],
    });
    const loadSpy = spyOn(planStateMod, 'loadPlan').mockImplementation(async () => JSON.parse(JSON.stringify(plan)));
    const repSpy = spyOn(reportsMod, 'readAllReports').mockImplementation(async () => []);
    const verSpy = spyOn(reportsMod, 'readAllReviewVerdicts').mockImplementation(async () => [
      { jobId: 'a-old', jobName: 'a', verdict: 'pass', commit: 'deadbee123', branch: 'mc/a', transport: 'serve', reason: 'previous run', timestamp: new Date().toISOString() },
    ] as never);
    try {
      const { mc_plan_status } = await import('../../src/tools/plan-status');
      const out = String(await mc_plan_status.execute({}, undefined as never));
      // Never displayed as the current verdict of the relaunched job...
      expect(out).not.toContain('• verdict "a"');
      // ...but marked stale explicitly with the old jobId.
      expect(out).toMatch(/stale: existe veredito de jobId anterior a-old/);
    } finally {
      loadSpy.mockRestore();
      repSpy.mockRestore();
      verSpy.mockRestore();
    }
  });

  it('overview never shows a stale name-matched report for a relaunched job', async () => {
    const jobStateMod = await import('../../src/lib/job-state');
    const reportsMod = await import('../../src/lib/reports');
    const now = new Date();
    const relaunchAt = new Date(now.getTime()).toISOString();
    const staleAt = new Date(now.getTime() - 3600_000).toISOString();
    const jobsSpy = spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => ({
      version: 3,
      updatedAt: relaunchAt,
      jobs: [
        {
          id: 'a-new', name: 'a', worktreePath: '/tmp/x', branch: 'mc/a', tmuxTarget: 'mc-a',
          placement: 'session', status: 'running', prompt: 'do a', mode: 'vanilla', createdAt: relaunchAt,
        },
      ],
    }) as never);
    const runningSpy = spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => [
      {
        id: 'a-new', name: 'a', worktreePath: '/tmp/x', branch: 'mc/a', tmuxTarget: 'mc-a',
        placement: 'session', status: 'running', prompt: 'do a', mode: 'vanilla', createdAt: relaunchAt,
      },
    ] as never);
    const repSpy = spyOn(reportsMod, 'readAllReports').mockImplementation(async () => [
      { jobId: 'a-old', jobName: 'a', status: 'completed', message: 'STALE previous run verdict', timestamp: staleAt } as never,
    ]);
    const planStateMod = await import('../../src/lib/plan-state');
    const planSpy = spyOn(planStateMod, 'loadPlan').mockImplementation(async () => null);
    const durableMod = await import('../../src/lib/durable-state');
    const snapSpy = spyOn(durableMod, 'loadRuntimeSnapshot').mockImplementation(async () => null as never);
    try {
      const { mc_overview } = await import('../../src/tools/overview');
      const out = String(await mc_overview.execute({}, undefined as never));
      expect(out).not.toMatch(/STALE previous run verdict/);
    } finally {
      jobsSpy.mockRestore();
      runningSpy.mockRestore();
      repSpy.mockRestore();
      planSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });
});
