import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';
import type { PlanSpec } from '../../src/lib/plan-types';
import * as paths from '../../src/lib/paths';

/**
 * Conductor lease fencing + staleness + atomic dispatch (PLAN_ID=2026-11-01-orquestrador-r3401131).
 * Estado isolado por tmpdir (mock getDataDir, mesmo padrão dos suites
 * conductor existentes), pids reais (sleep), concorrência real (Promise.all).
 * RED-first: (a) takeover deve invalidar P1 via fencing; (b) lease 10h sem
 * heartbeat deve ser stale mesmo com pid vivo; (c) double-claim só 1 vence.
 */
describe('conductor lease fencing r3401131', () => {
  let testBaseDir = '';
  let testStateDir = '';
  let restoreDataDir: () => void = () => {};
  let liveChildren: number[] = [];

  function seedPlan(id: string, jobs: Array<{ id: string; name: string; status: string }>): PlanSpec {
    return {
      id,
      name: 'fencing work',
      mode: 'autopilot',
      status: 'running',
      jobs: jobs.map((j) => ({ prompt: `do ${j.name}`, ...j })),
      integrationBranch: 'mc/integration-x',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as unknown as PlanSpec;
  }

  function spawnSleeper(): number {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      (child as unknown as { unref?: () => void }).unref?.();
    } catch {}
    const pid = child.pid;
    if (!pid) throw new Error('sleep did not start');
    liveChildren.push(pid);
    return pid;
  }

  beforeEach(async () => {
    const fs = await import('fs');
    testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-lease-r3401131-'));
    testStateDir = join(testBaseDir, 'state');
    fs.mkdirSync(testStateDir, { recursive: true });
    const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    restoreDataDir = () => spy.mockRestore();
  });

  afterEach(() => {
    mock.restore();
    for (const pid of liveChildren) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
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

  it('(a) takeover: P2 claim por cima invalida P1 via fencing (epoch/token)', async () => {
    const mod = await import('../../src/lib/plan-state');
    const { savePlan, claimConductorLease, readConductorLease, verifyConductorLease } = mod as unknown as {
      savePlan: (p: PlanSpec, r?: string) => Promise<void>;
      claimConductorLease: (planId: string, pid: number, cmd: string, owner?: string, root?: string, opts?: unknown) => Promise<Record<string, unknown>>;
      readConductorLease: (root?: string) => Promise<Record<string, unknown> | null>;
      verifyConductorLease: (planId: string, pid: number, root?: string, opts?: unknown) => Promise<boolean>;
    };
    await savePlan(seedPlan('plan-fence-a', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);

    const pid1 = spawnSleeper();
    const pid2 = spawnSleeper();
    // Concorrência real: duas claims disputando o mesmo plan.
    const [lease1, lease2] = await Promise.all([
      claimConductorLease('plan-fence-a', pid1, 'cmd-p1', 'owner-p1', undefined),
      // Pequeno atraso para garantir ordem P1→P2 sem serializar o lock.
      (async () => {
        await new Promise((r) => setTimeout(r, 25));
        return claimConductorLease('plan-fence-a', pid2, 'cmd-p2', 'owner-p2', undefined);
      })(),
    ]);

    // Fencing: epoch monotônico + token/nonce distintos.
    expect(typeof lease1['epoch']).toBe('number');
    expect(typeof lease1['token']).toBe('string');
    expect(typeof lease2['epoch']).toBe('number');
    expect(typeof lease2['token']).toBe('string');
    expect(lease2['epoch'] as number).toBeGreaterThan(lease1['epoch'] as number);
    expect(lease2['token']).not.toBe(lease1['token']);

    const current = await readConductorLease(undefined);
    expect(current).not.toBeNull();
    expect(current!['pid']).toBe(pid2);

    // P1 com token/epoch antigo deve ser rejeitado; P2 com token atual passa.
    expect(await verifyConductorLease('plan-fence-a', pid1, undefined, { token: lease1['token'], epoch: lease1['epoch'] })).toBe(false);
    expect(await verifyConductorLease('plan-fence-a', pid2, undefined, { token: lease2['token'], epoch: lease2['epoch'] })).toBe(true);
  });

  it('(b) stale: lease 10h sem heartbeat/progresso é suspect/stale mesmo com pid vivo', async () => {
    const mod = await import('../../src/lib/plan-state');
    const { savePlan, claimConductorLease, readConductorLease, verifyConductorLease, isStale } = mod as unknown as {
      savePlan: (p: PlanSpec, r?: string) => Promise<void>;
      claimConductorLease: (planId: string, pid: number, cmd: string, owner?: string, root?: string) => Promise<Record<string, unknown>>;
      readConductorLease: (root?: string) => Promise<Record<string, unknown> | null>;
      verifyConductorLease: (planId: string, pid: number, root?: string, opts?: unknown) => Promise<boolean>;
      isStale: (lease: unknown, now?: unknown, opts?: unknown) => boolean;
    };
    expect(typeof isStale).toBe('function');
    await savePlan(seedPlan('plan-fence-b', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);

    const pid = spawnSleeper();
    const lease = await claimConductorLease('plan-fence-b', pid, 'cmd', 'owner', undefined);
    expect(await verifyConductorLease('plan-fence-b', pid, undefined)).toBe(true);

    // Envelhece 10h sem heartbeat/progresso (pid continua vivo).
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const fs = await import('fs');
    const conductorFile = join(testStateDir, 'conductor.json');
    const raw = JSON.parse(fs.readFileSync(conductorFile, 'utf8'));
    raw.acquiredAt = tenHoursAgo;
    raw.lastHeartbeat = tenHoursAgo;
    raw.lastProgress = tenHoursAgo;
    fs.writeFileSync(conductorFile, JSON.stringify(raw, null, 2));

    const staleLease = await readConductorLease(undefined);
    expect(staleLease).not.toBeNull();
    // Detector configurável: 10h >> limites default → stale.
    expect(isStale(staleLease, Date.now(), {})).toBe(true);
    // PID vivo sozinho não basta: verify deve falhar quando stale.
    expect(await verifyConductorLease('plan-fence-b', pid, undefined)).toBe(false);
    void lease;
  });

  it('(c) double-claim: 2x claimJobForDispatch na mesma queued, só 1 vence sem side-effect', async () => {
    const mod = await import('../../src/lib/plan-state');
    const { savePlan, loadPlan, claimJobForDispatch } = mod as unknown as {
      savePlan: (p: PlanSpec, r?: string) => Promise<void>;
      loadPlan: (r?: string) => Promise<PlanSpec | null>;
      claimJobForDispatch: (planId: string, job: string, owner: string, root?: string) => Promise<{ ok: boolean; status: string }>;
    };
    await savePlan(seedPlan('plan-fence-c', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);

    const [a, b] = await Promise.all([
      claimJobForDispatch('plan-fence-c', 'task-a', 'coord-A', undefined),
      claimJobForDispatch('plan-fence-c', 'task-a', 'coord-B', undefined),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].status).toBe('running');
    const plan = await loadPlan(undefined);
    expect(plan!.jobs.find((j) => j.name === 'task-a')!.status).toBe('running');
  });

  it('(d) task longa saudável: heartbeats frequentes + budgets custom → fresh + verify true', async () => {
    const mod = await import('../../src/lib/plan-state');
    const { savePlan, claimConductorLease, readConductorLease, verifyConductorLease, isStale, recordHeartbeat, recordProgress } = mod as unknown as {
      savePlan: (p: PlanSpec, r?: string) => Promise<void>;
      claimConductorLease: (planId: string, pid: number, cmd: string, owner?: string, root?: string) => Promise<Record<string, unknown>>;
      readConductorLease: (root?: string) => Promise<Record<string, unknown> | null>;
      verifyConductorLease: (planId: string, pid: number, root?: string, opts?: unknown) => Promise<boolean>;
      isStale: (lease: unknown, now?: unknown, opts?: unknown) => boolean;
      recordHeartbeat: (planId: string, pid: number, root?: string) => Promise<Record<string, unknown>>;
      recordProgress: (planId: string, pid: number, root?: string) => Promise<Record<string, unknown>>;
    };
    await savePlan(seedPlan('plan-fence-d', [{ id: 'j1', name: 'task-a', status: 'queued' }]), undefined);

    const pid = spawnSleeper();
    await claimConductorLease('plan-fence-d', pid, 'cmd', 'owner', undefined);
    // Heartbeats frequentes mantêm a task longa saudável nos defaults.
    await recordHeartbeat('plan-fence-d', pid, undefined);
    await recordProgress('plan-fence-d', pid, undefined);
    const freshLease = await readConductorLease(undefined);
    expect(isStale(freshLease, Date.now(), {})).toBe(false);
    expect(await verifyConductorLease('plan-fence-d', pid, undefined)).toBe(true);

    // Simula task longa: acquired há 5h, último beat há 45min (pid vivo).
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const fs = await import('fs');
    const conductorFile = join(testStateDir, 'conductor.json');
    const raw = JSON.parse(fs.readFileSync(conductorFile, 'utf8'));
    raw.acquiredAt = fiveHoursAgo;
    raw.lastHeartbeat = fortyFiveMinAgo;
    raw.lastProgress = fortyFiveMinAgo;
    fs.writeFileSync(conductorFile, JSON.stringify(raw, null, 2));

    const agedLease = await readConductorLease(undefined);
    // Default (30min heartbeat) considera stale…
    expect(isStale(agedLease, Date.now(), {})).toBe(true);
    expect(await verifyConductorLease('plan-fence-d', pid, undefined)).toBe(false);
    // …mas budgets custom da task longa (1h heartbeat / 6h progresso) mantêm fresh.
    const custom = { maxHeartbeatMs: 60 * 60 * 1000, maxProgressMs: 6 * 60 * 60 * 1000 };
    expect(isStale(agedLease, Date.now(), custom)).toBe(false);
    expect(await verifyConductorLease('plan-fence-d', pid, undefined, custom)).toBe(true);
  });
});
