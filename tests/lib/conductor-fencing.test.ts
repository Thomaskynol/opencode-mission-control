import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as paths from '../../src/lib/paths';

/** E fencing: stale token/epoch rejected, no-lease start fails closed, takeover inverts. */
describe('conductor fencing (E)', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let restoreDataDir: () => void = () => {};

  function seedPlan(id: string, jobs: Array<{ id: string; name: string; status: string }>): PlanSpec {
    return {
      id,
      name: 'fence work',
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
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-fencing-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(() => {
    try { restoreDataDir(); } catch {}
    if (testBaseDir) {
      try { (require('fs') as typeof import('fs')).rmSync(testBaseDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('stale write rejected (updatePlanJob with old token fails after takeover)', async () => {
    const mod = await import('../../src/lib/plan-state');
    await mod.savePlan(seedPlan('e-plan', [{ id: 'j1', name: 'job-a', status: 'queued' }]), undefined);
    const leaseA = await mod.claimConductorLease('e-plan', 10001, 'agent-A', 'agent-A', undefined);
    const leaseB = await mod.claimConductorLease('e-plan', 10002, 'takeover', 'agent-B', undefined, { force: true });
    expect(leaseB.epoch).toBeGreaterThan(leaseA.epoch);
    // stale A write with old fencing must throw
    await expect(
      mod.updatePlanJob('e-plan', 'job-a', { status: 'running' }, { fencing: { token: leaseA.token, epoch: leaseA.epoch, pid: 10001 } } as any, undefined),
    ).rejects.toThrow(/fencing/i);
    // stale write with NO fencing when lease exists must also throw (fail-closed)
    await expect(
      (mod.updatePlanJob as any)('e-plan', 'job-a', { status: 'running' }, undefined, undefined),
    ).rejects.toThrow(/fencing/i);
    // fresh B write with current fencing succeeds
    await mod.updatePlanJob('e-plan', 'job-a', { status: 'running' }, { fencing: { token: leaseB.token, epoch: leaseB.epoch, pid: 10002 } } as any, undefined);
    const plan = await mod.loadPlan(undefined);
    expect(plan!.jobs.find((j) => j.name === 'job-a')!.status).toBe('running');
  });

  it('stale dispatch rejected (claimJobForDispatch with old token throws)', async () => {
    const mod = await import('../../src/lib/plan-state');
    await mod.savePlan(seedPlan('e-plan-d', [{ id: 'j1', name: 'job-a', status: 'queued' }]), undefined);
    const leaseA = await mod.claimConductorLease('e-plan-d', 10001, 'agent-A', 'agent-A', undefined);
    await mod.claimConductorLease('e-plan-d', 10002, 'takeover', 'agent-B', undefined, { force: true });
    await expect(
      (mod.claimJobForDispatch as any)('e-plan-d', 'job-a', 'stale-owner', undefined, { token: leaseA.token, epoch: leaseA.epoch, pid: 10001 }),
    ).rejects.toThrow(/fencing/i);
  });

  it('takeover-then-old-heartbeat rejected', async () => {
    const mod = await import('../../src/lib/plan-state');
    await mod.savePlan(seedPlan('e-plan-h', [{ id: 'j1', name: 'job-a', status: 'queued' }]), undefined);
    const leaseA = await mod.claimConductorLease('e-plan-h', 10001, 'agent-A', 'agent-A', undefined);
    await mod.claimConductorLease('e-plan-h', 10002, 'takeover', 'agent-B', undefined, { force: true });
    await expect(mod.recordHeartbeat('e-plan-h', 10001, undefined, { token: leaseA.token } as any)).rejects.toThrow(/fencing/i);
  });

  it('same-pid re-claim idempotent (keeps epoch, refreshes heartbeat)', async () => {
    const mod = await import('../../src/lib/plan-state');
    await mod.savePlan(seedPlan('e-plan-r', [{ id: 'j1', name: 'job-a', status: 'queued' }]), undefined);
    const l1 = await mod.claimConductorLease('e-plan-r', process.pid, 'cmd', 'owner', undefined);
    const l2 = await mod.claimConductorLease('e-plan-r', process.pid, 'cmd2', 'owner', undefined);
    expect(l2.epoch).toBe(l1.epoch);
    expect(l2.token).toBe(l1.token);
  });

  it('claimConductorOwnership surfaces acquire-failure (false, not swallowed void)', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { JobMonitor } = await import('../../src/lib/monitor');
    const orch = new Orchestrator(new JobMonitor() as never, { defaultPlacement: 'session' } as never);
    // no plan in real state dir -> claim must fail and surface false
    const ok = await (orch as any).claimConductorOwnership('no-such-plan-xyz', 'cmd', 'owner', testStateDir);
    expect(ok).toBe(false);
  });

  it('two-process: stale holder in another process cannot write after takeover', async () => {
    // Real state (no getDataDir mock): parent + child share MC_XDG_DATA_DIR + repoRoot.
    restoreDataDir();
    const fs = await import('fs');
    const repoRoot = join(testBaseDir, 'repo2p');
    fs.mkdirSync(repoRoot, { recursive: true });
    const xdg = join(testBaseDir, 'xdg2p');
    fs.mkdirSync(xdg, { recursive: true });
    const env = { ...process.env, MC_XDG_DATA_DIR: xdg };
    const run = async (script: string): Promise<{ exit: number; out: string }> => {
      const proc = Bun.spawn(['bun', '-e', script], { cwd: '/tmp', env: env as any, stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text().catch(() => '');
      const err = await new Response(proc.stderr).text().catch(() => '');
      const exit = await proc.exited;
      return { exit, out: out + err };
    };
    const setupScript = `
      const m = await import(${JSON.stringify('/tmp/opencode/lane-efgfix/wt/src/lib/plan-state.ts')});
      const plan = { id: 'e-2p', name: 'e-2p', mode: 'autopilot', status: 'running', jobs: [{ id: 'j1', name: 'job-a', status: 'queued', prompt: 'do' }], integrationBranch: 'mc/e', baseCommit: 'HEAD', createdAt: new Date().toISOString() };
      await m.savePlan(plan, ${JSON.stringify(repoRoot)});
      const a = await m.claimConductorLease('e-2p', 10001, 'A', 'A', ${JSON.stringify(repoRoot)});
      await Bun.write(${JSON.stringify(join(testBaseDir, 'leaseA.json'))}, JSON.stringify({ token: a.token, epoch: a.epoch }));
      console.log('setup ok');
    `;
    const s1 = await run(setupScript);
    expect(s1.exit).toBe(0);
    const leaseA = JSON.parse(await Bun.file(join(testBaseDir, 'leaseA.json')).text());
    // B takeover in another process (different pid)
    const takeoverScript = `
      const m = await import(${JSON.stringify('/tmp/opencode/lane-efgfix/wt/src/lib/plan-state.ts')});
      await m.claimConductorLease('e-2p', 10002, 'B', 'B', ${JSON.stringify(repoRoot)}, { force: true });
      console.log('takeover ok');
    `;
    const s2 = await run(takeoverScript);
    expect(s2.exit).toBe(0);
    // Stale A write from a third process must be rejected (exit != 0)
    const staleScript = `
      const m = await import(${JSON.stringify('/tmp/opencode/lane-efgfix/wt/src/lib/plan-state.ts')});
      try {
        await m.updatePlanJob('e-2p', 'job-a', { status: 'running' }, { fencing: { token: ${JSON.stringify(leaseA.token)}, epoch: ${leaseA.epoch}, pid: 10001 } }, ${JSON.stringify(repoRoot)});
        console.log('STALE-WRITE-SUCCEEDED (gap)');
        process.exit(0);
      } catch (e) {
        console.log('STALE-WRITE-REJECTED: ' + (e instanceof Error ? e.message : e));
        process.exit(1);
      }
    `;
    const s3 = await run(staleScript);
    expect(s3.exit).toBe(1);
    expect(s3.out).toMatch(/fencing/i);
    // re-mock for other tests
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });
});
