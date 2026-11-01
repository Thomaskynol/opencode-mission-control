import { describe, it, expect, mock, spyOn, afterEach, beforeEach } from 'bun:test';
import { EventEmitter } from 'events';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status: 'queued',
    ...overrides,
  } as JobSpec;
}

function demoIncoherentPrompt(): string {
  return `Implement sum in sum.js\n\nAcceptance criteria:\n- [ ] bun test sum.test.js passes`;
}

describe('touchset fluxo publico (RED)', () => {
  it('validatePlan blocks demo incoherence before first launch', async () => {
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const monitor = new EventEmitter() as any;
    const orch = new Orchestrator(monitor, { defaultPlacement: 'session' } as any);
    const spec = {
      id: 'plan-demo',
      name: 'demo',
      mode: 'autopilot',
      status: 'pending',
      jobs: [makeJob('implement-sum', { prompt: demoIncoherentPrompt(), touchSet: ['sum.js'] })],
      integrationBranch: 'mc/integration-demo',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as PlanSpec;
    expect(() => (orch as any).validatePlan(spec)).toThrow(/sum\.test\.js/);
  });

  it('launchJob blocks incoherent before claim/worktree', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const worktreeMod = await import('../../src/lib/worktree');
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const monitor = new EventEmitter() as any;
    const orch = new Orchestrator(monitor, { defaultPlacement: 'session' } as any);
    (orch as any).activePlanId = 'plan-demo';
    const claimSpy = spyOn(planStateMod, 'claimJobForDispatch').mockResolvedValue({ ok: true, status: 'running' } as never);
    const wtSpy = spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/demo' as never);
    const updateSpy = spyOn(planStateMod, 'updatePlanJob').mockResolvedValue(undefined as never);
    try {
      const job = makeJob('implement-sum', { prompt: demoIncoherentPrompt(), touchSet: ['sum.js'], status: 'queued' });
      const r = await (orch as any).launchJob(job);
      expect(r).toBe(false);
      expect(claimSpy).not.toHaveBeenCalled();
      expect(wtSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalled();
      const msg = String((updateSpy.mock.calls[0] as any)?.[2]?.error ?? '');
      expect(msg).toMatch(/sum\.test\.js/);
    } finally {
      mock.restore();
    }
  });

  it('relaunch does not repeat cycle when still incoherent', async () => {
    const planStateMod = await import('../../src/lib/plan-state');
    const tmuxMod = await import('../../src/lib/tmux');
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const monitor = new EventEmitter() as any;
    const orch = new Orchestrator(monitor, { defaultPlacement: 'session' } as any);
    const job = makeJob('implement-sum', {
      prompt: demoIncoherentPrompt(),
      touchSet: ['sum.js'],
      status: 'failed',
      branch: 'mc/demo',
      worktreePath: '/tmp/wt/demo',
    });
    const plan = {
      id: 'plan-demo',
      name: 'demo',
      mode: 'autopilot',
      status: 'paused',
      jobs: [job],
      integrationBranch: 'mc/integration-demo',
      baseCommit: 'abc123',
      createdAt: new Date().toISOString(),
    } as PlanSpec;
    spyOn(planStateMod, 'loadPlan').mockResolvedValue(JSON.parse(JSON.stringify(plan)) as never);
    const sessSpy = spyOn(tmuxMod, 'createSession').mockResolvedValue(undefined as never);
    try {
      let err: unknown = null;
      try {
        await (orch as any).relaunchJobForCorrection('implement-sum', ['sum.test.js'], ['sum.js']);
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(String((err as Error).message)).toMatch(/sum\.test\.js|replan|aceite|touchSet/i);
      expect(sessSpy).not.toHaveBeenCalled();
    } finally {
      mock.restore();
    }
  });

  it('reviewer argv inherits effective model with variant when MC_REVIEW_MODEL unset', async () => {
    const saved = process.env.MC_REVIEW_MODEL;
    delete process.env.MC_REVIEW_MODEL;
    const origSpawn = Bun.spawn;
    const seen: string[][] = [];
    const passJson = JSON.stringify([{ id: 'r1', demonstrated: true, missing: [], verdict: 'pass', reason: 'ok' }]);
    (Bun as any).spawn = (argv: string[], _opts?: unknown) => {
      seen.push(argv);
      return { stdout: new Response(passJson).body, stderr: new Response('').body, exited: Promise.resolve(0), kill() {} };
    };
    try {
      const { Orchestrator } = await import('../../src/lib/orchestrator');
      const monitor = new EventEmitter() as any;
      const orch = new Orchestrator(monitor, { defaultPlacement: 'session' } as any);
      (orch as any).planModelSnapshot = { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'v123' };
      const graded = [{ id: 'r1', description: 'sum works', testAnchors: ['sum'] }];
      const input = {
        jobName: 'j',
        jobBranch: 'b',
        baseBranch: 'base',
        baseHead: 'h1',
        jobHead: 'h2',
        changedFiles: ['sum.js'],
        requirements: graded,
        evidence: { command: 'bun test', exitCode: 0, output: 'pass sum ok', testedCommit: 'h2', environment: 'e' },
        fileContents: { 'sum.js': 'export function sum(a,b){return a+b;}\n', 'sum.test.js': 'import {sum} from "./sum.js"; console.log(sum(1,2));\n' },
        testPaths: ['sum.test.js'],
      } as any;
      await (orch as any).attachExternalSufficiency(graded, input);
      expect(seen.length).toBe(1);
      const argv = seen[0]!;
      const idx = argv.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe('opencode-go/muse-spark-1.3-contributor#v123');
    } finally {
      (Bun as any).spawn = origSpawn;
      if (saved !== undefined) process.env.MC_REVIEW_MODEL = saved;
      else delete process.env.MC_REVIEW_MODEL;
      mock.restore();
    }
  });

  it('immutable retest fails on A->B->A restore with real git fixture', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { EventEmitter } = await import('events');
    const monitor = new EventEmitter() as any;
    const orch = new Orchestrator(monitor, { defaultPlacement: 'session' } as any);
    // RED: helper does not exist yet — must run tests in an immutable snapshot.
    expect(typeof (orch as any).runImmutableRetest).toBe('function');
    const dir = mkdtempSync(join(tmpdir(), 'mc-fluxo-'));
    try {
      const proc = (args: string[]) => Bun.spawnSync(args, { cwd: dir });
      proc(['git', 'init']);
      proc(['git', 'config', 'user.email', 't@t.com']);
      proc(['git', 'config', 'user.name', 'T']);
      writeFileSync(join(dir, 'total.mjs'), 'export function total(xs){ return xs.length; }\n');
      writeFileSync(join(dir, 'check.mjs'), 'import { total } from "./total.mjs";\nif (total([1,2])!==2) { console.error("wrong"); process.exit(1); }\nconsole.log("ok");\n');
      proc(['git', 'add', '.']);
      proc(['git', 'commit', '-m', 'init']);
      const evilRestore = `node -e "const fs=require('fs');const t='${dir}/total.mjs';const o=fs.readFileSync(t,'utf8');fs.writeFileSync(t,'export function total(xs){ return 3; }\\n');fs.writeFileSync(t,o);" && node check.mjs`;
      const r = await (orch as any).runImmutableRetest(dir, evilRestore, 30000, ['total.mjs', 'check.mjs']);
      // Mutated-then-restored original must NOT count as success attributed to the commit.
      expect(r.success).toBe(false);
      expect(String(r.output ?? '')).toMatch(/restor|mutat|changed during run|ctime|identity refused/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
