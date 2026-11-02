import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as paths from '../../src/lib/paths';

// G2 repro: live holder blocks approve without fencing (deadlock requiring
// manual rm). Legitimate path: explicit --takeover bumps epoch + audits and
// lets approve proceed; stale holder without takeover stays refused.
describe('G2: approve takeover (no manual rm)', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let restoreDataDir: () => void = () => {};
  let liveChildren: number[] = [];

  function seedPlan(id: string): PlanSpec {
    return {
      id,
      name: 'takeover work',
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
  }

  beforeEach(async () => {
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-g2-takeover-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(() => {
    const { mock } = require('bun:test') as typeof import('bun:test');
    mock.restore();
    for (const pid of liveChildren) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    liveChildren = [];
    try { restoreDataDir(); } catch {}
    if (testBaseDir) {
      try { (require('fs') as typeof import('fs')).rmSync(testBaseDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('live holder without takeover → savePlan refused (fail-closed, no silent overwrite)', async () => {
    const mod = await import('../../src/lib/plan-state');
    await mod.savePlan(seedPlan('g2-plan'), undefined);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try { (child as unknown as { unref?: () => void }).unref?.(); } catch {}
    const holderPid = child.pid!;
    liveChildren.push(holderPid);
    await mod.claimConductorLease('g2-plan', holderPid, 'resume --intake x', 'holder', undefined);
    // Approve in another pid without fencing must be rejected (current deadlock).
    const plan = await mod.loadPlan(undefined);
    plan!.status = 'running';
    (plan as unknown as { checkpoint: null }).checkpoint = null;
    await expect(mod.savePlan(plan!, undefined)).rejects.toThrow(/fencing|stale holder/i);
  });

  it('live holder with explicit takeover → epoch bump + audit, then save succeeds', async () => {
    const mod = await import('../../src/lib/plan-state');
    await mod.savePlan(seedPlan('g2-plan-take'), undefined);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try { (child as unknown as { unref?: () => void }).unref?.(); } catch {}
    const holderPid = child.pid!;
    liveChildren.push(holderPid);
    const first = await mod.claimConductorLease('g2-plan-take', holderPid, 'resume --intake x', 'holder', undefined);
    // Legitimate takeover path (what approve --takeover must use): force bump.
    const take = await (mod as unknown as { takeoverConductorLease: (planId: string, pid: number, command: string, owner: string, repoRoot?: string, reason?: string) => Promise<{ lease: { token: string; epoch: number }; prev: unknown; auditLogged: boolean }> }).takeoverConductorLease(
      'g2-plan-take', process.pid, 'approve --takeover', 'approve:takeover', undefined, 'approve --takeover (explicit operator intent)',
    );
    expect(take.lease.epoch).toBeGreaterThan(first.epoch);
    expect(take.auditLogged).toBe(true);
    const plan = await mod.loadPlan(undefined);
    plan!.status = 'running';
    (plan as unknown as { checkpoint: null }).checkpoint = null;
    await mod.savePlan(plan!, undefined, { token: take.lease.token, epoch: take.lease.epoch, pid: process.pid });
    const after = await mod.loadPlan(undefined);
    expect(after!.status).toBe('running');
    // Stale holder can no longer write.
    await expect(
      mod.updatePlanJob('g2-plan-take', 'task-a', { status: 'running' }, { fencing: { token: first.token, epoch: first.epoch, pid: holderPid } } as never, undefined),
    ).rejects.toThrow(/fencing/i);
  });

  it('ensureApproveFencing: live holder without --takeover refused naming the flag; with --takeover approved + audited', async () => {
    const planMod = await import('../../src/lib/plan-state');
    const autoMod = await import('../../src/orchestrator-cli/auto-commands');
    await planMod.savePlan(seedPlan('g2-plan-flag'), undefined);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try { (child as unknown as { unref?: () => void }).unref?.(); } catch {}
    const holderPid = child.pid!;
    liveChildren.push(holderPid);
    await planMod.claimConductorLease('g2-plan-flag', holderPid, 'resume --intake x', 'holder', undefined);
    await expect(
      autoMod.ensureApproveFencing('g2-plan-flag', testStateDir, {}),
    ).rejects.toThrow(/--takeover/);
    // RepoRoot for ensureApproveFencing is the repo root whose data dir is
    // testStateDir via getDataDir mock — pass a dummy repo root and rely on
    // the mock: use undefined scope (mocked dir) by passing testStateDir's
    // parent? Simpler: call with the mocked dir resolution via undefined.
    // The mock maps ANY repoRoot to testStateDir, so the lease above (created
    // with undefined scope) is visible. Pass undefined as repoRoot through any.
    const fencing = await (autoMod.ensureApproveFencing as (planId: string, repoRoot: string, opts?: { takeover?: boolean }) => Promise<{ token: string; epoch: number; pid: number }>)(
      'g2-plan-flag', undefined as unknown as string, { takeover: true, command: 'approve --takeover' },
    );
    expect(fencing.token).toBeTruthy();
    expect(fencing.pid).toBe(process.pid);
    const fs = await import('fs');
    const audit = fs.readFileSync(join(testStateDir, 'conductor-audit.jsonl'), 'utf8');
    expect(audit).toMatch(/conductor-takeover/);
    expect(audit).toMatch(/g2-plan-flag/);
  });
});
