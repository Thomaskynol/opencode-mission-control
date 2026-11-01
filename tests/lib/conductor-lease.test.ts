import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as paths from '../../src/lib/paths';

/** Atomic dispatch claim + conductor lease units (sondas 13/15), real state. */
describe('atomic job claim + conductor lease units', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let restoreDataDir: () => void = () => {};

  function seedPlan(id: string, jobs: Array<{ id: string; name: string; status: string }>): PlanSpec {
    return {
      id,
      name: 'claim work',
      mode: 'autopilot',
      status: 'running',
      jobs: jobs.map((j) => ({ prompt: `do ${j.name}`, ...j })),
      integrationBranch: 'mc/integration-x',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as unknown as PlanSpec;
  }

  beforeEach(async () => {
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-conductor-lease-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(() => {
    try {
      restoreDataDir();
    } catch {}
    if (testBaseDir) {
      try {
        (require('fs') as typeof import('fs')).rmSync(testBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('exposes claimJobForDispatch (queued->running atomic)', async () => {
    const mod = await import('../../src/lib/plan-state');
    expect(typeof (mod as unknown as { claimJobForDispatch?: unknown }).claimJobForDispatch).toBe('function');
  });

  it('claimJobForDispatch is atomic: two racers, only one wins', async () => {
    const { savePlan, loadPlan, claimJobForDispatch } = await import('../../src/lib/plan-state');
    await savePlan(seedPlan('plan-claim-1', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);
    const [a, b] = await Promise.all([
      claimJobForDispatch('plan-claim-1', 'task-a', 'coord-A', undefined),
      claimJobForDispatch('plan-claim-1', 'task-a', 'coord-B', undefined),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].status).toBe('running');
    const plan = await loadPlan(undefined);
    expect(plan!.jobs.find((j) => j.name === 'task-a')!.status).toBe('running');
  });

  it('claimJobForDispatch refuses non-queued jobs (no running->running re-claim)', async () => {
    const { savePlan, claimJobForDispatch } = await import('../../src/lib/plan-state');
    await savePlan(
      seedPlan('plan-claim-2', [
        { id: 'j1', name: 'task-a', status: 'running' },
        { id: 'j2', name: 'task-b', status: 'waiting_deps' },
      ]),
      undefined,
    );
    await expect(claimJobForDispatch('plan-claim-2', 'task-a', 'coord-A', undefined)).resolves.toMatchObject({
      ok: false,
      status: 'running',
    });
    await expect(claimJobForDispatch('plan-claim-2', 'task-b', 'coord-A', undefined)).resolves.toMatchObject({
      ok: false,
      status: 'waiting_deps',
    });
  });

  it('claimJobForDispatch throws for unknown plan and unknown job', async () => {
    const { savePlan, claimJobForDispatch } = await import('../../src/lib/plan-state');
    await savePlan(seedPlan('plan-claim-3', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);
    await expect(claimJobForDispatch('no-such-plan', 'task-a', 'coord-A', undefined)).rejects.toThrow(
      /No active plan|mismatch/i,
    );
    await expect(claimJobForDispatch('plan-claim-3', 'ghost', 'coord-A', undefined)).rejects.toThrow(/not found/i);
  });

  it('lease roundtrip: claim -> read -> verify (same pid), mismatch pid fails', async () => {
    const { savePlan, claimConductorLease, readConductorLease, verifyConductorLease } =
      await import('../../src/lib/plan-state');
    await savePlan(seedPlan('plan-lease-1', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);
    expect(await readConductorLease(undefined)).toBeNull();
    const lease = await claimConductorLease('plan-lease-1', process.pid, 'resume --intake x', 'resume', undefined);
    expect(lease.planId).toBe('plan-lease-1');
    expect(lease.pid).toBe(process.pid);
    const reread = await readConductorLease(undefined);
    expect(reread).toMatchObject({ planId: 'plan-lease-1', pid: process.pid, owner: 'resume' });
    expect(await verifyConductorLease('plan-lease-1', process.pid, undefined)).toBe(true);
    expect(await verifyConductorLease('plan-lease-1', process.pid + 999999, undefined)).toBe(false);
    expect(await verifyConductorLease('other-plan', process.pid, undefined)).toBe(false);
  });

  it('lease claim is fail-closed: unknown plan and invalid pid throw', async () => {
    const { savePlan, claimConductorLease } = await import('../../src/lib/plan-state');
    await savePlan(seedPlan('plan-lease-2', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);
    await expect(claimConductorLease('no-such-plan', process.pid, 'cmd', 'o', undefined)).rejects.toThrow(
      /no active plan|mismatch/i,
    );
    await expect(claimConductorLease('plan-lease-2', -5, 'cmd', 'o', undefined)).rejects.toThrow(/invalid pid/i);
  });
});
