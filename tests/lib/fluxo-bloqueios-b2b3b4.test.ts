import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function git(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }) as unknown as { exitCode: number; stderr: Uint8Array };
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(r.stderr)}`);
}
function gitOut(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }) as unknown as { exitCode: number; stdout: Uint8Array };
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return new TextDecoder().decode(r.stdout).trim();
}

describe('B2 dispatch-infra re-elegivel com teto (RED)', () => {
  it('failed com erro de dispatch-infra volta a ser elegivel', async () => {
    const { decideNextJobs } = await import('../../src/lib/coordinator');
    const jobs = [
      { name: 'average-task', status: 'failed', mergeOrder: 0, error: 'dispatch-infra (attempt 1/3): Server on port 14103 did not become ready within 60000ms' },
    ] as any;
    const picked = decideNextJobs(jobs, 0, 2);
    expect(picked.map((j: any) => j.name)).toContain('average-task');
  });

  it('distingue infra de falha funcional', async () => {
    const mod = (await import('../../src/lib/coordinator')) as any;
    expect(typeof mod.isDispatchInfraError).toBe('function');
    expect(mod.isDispatchInfraError('dispatch-infra (attempt 1/3): Server on port 14103 did not become ready')).toBe(true);
    expect(mod.isDispatchInfraError('Server on port 14103 did not become ready within 60000ms')).toBe(true);
    expect(mod.isDispatchInfraError('Review blocked: empty diff')).toBe(false);
    expect(mod.isDispatchInfraError('assertion failed: expected 3 got 4')).toBe(false);
  });

  it('teto: attempt esgotado nunca re-elege (anti-loop)', async () => {
    const mod = (await import('../../src/lib/coordinator')) as any;
    expect(mod.MAX_DISPATCH_ATTEMPTS).toBeGreaterThanOrEqual(1);
    const { decideNextJobs } = mod;
    const jobs = [
      { name: 'average-task', status: 'failed', mergeOrder: 0, error: `dispatch-infra (attempt ${mod.MAX_DISPATCH_ATTEMPTS}/${mod.MAX_DISPATCH_ATTEMPTS}): Server on port 14103 did not become ready` },
    ] as any;
    const picked = decideNextJobs(jobs, 0, 2);
    expect(picked.map((j: any) => j.name)).not.toContain('average-task');
  });
});

describe('B3 merged terminal / re-merge vazio no-op (RED, git real)', () => {
  let root = '';
  let repo = '';
  let intWt = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-b3-'));
    repo = join(root, 'repo');
    intWt = join(root, 'int');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 't@t.com']);
    git(repo, ['config', 'user.name', 'T']);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    git(repo, ['branch', '-M', 'main']);
    git(repo, ['branch', 'integration']);
    git(repo, ['worktree', 'add', intWt, 'integration']);
  });
  afterEach(() => {
    mock.restore();
    rmSync(root, { recursive: true, force: true });
  });

  it('re-merge vazio com verdict pass no mesmo commit = no-op success mesmo em estrito', async () => {
    const { MergeTrain } = await import('../../src/lib/merge-train');
    // job branch com mudanca real
    git(repo, ['checkout', '-b', 'feat-cap', 'main']);
    writeFileSync(join(repo, 'cap.txt'), 'cap\n');
    git(repo, ['add', 'cap.txt']);
    git(repo, ['commit', '-m', 'feat cap']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-cap']);
    const baseHead = gitOut(intWt, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    // primeiro merge: integra de verdade
    const train = new MergeTrain(intWt, { requireReviewPass: true });
    train.enqueue({ id: 'feat-cap-id', name: 'feat-cap', prompt: 'x', status: 'ready_to_merge', branch: 'feat-cap' } as any);
    const first = await train.processNext(
      { verdict: 'pass', blocking: false, reasons: [], jobName: 'feat-cap', reviewedCommit: jobHead, reviewedBase: baseHead } as any,
      { skipTest: true },
    );
    expect(first.success).toBe(true);
    // segundo merge do MESMO commit (diff vazio) com verdict pass no mesmo commit: deve ser no-op success, nunca review_blocked
    const train2 = new MergeTrain(intWt, { requireReviewPass: true });
    train2.enqueue({ id: 'feat-cap-id', name: 'feat-cap', prompt: 'x', status: 'ready_to_merge', branch: 'feat-cap' } as any);
    const second = await train2.processNext(
      { verdict: 'pass', blocking: false, reasons: [], jobName: 'feat-cap', reviewedCommit: jobHead, reviewedBase: gitOut(intWt, ['rev-parse', 'HEAD']) } as any,
      { skipTest: true },
    );
    expect(second.success).toBe(true);
  });

  it('merged eh terminal: reviewJobWithFixLoop nunca re-falha o mesmo commit', async () => {
    process.env.NODE_ENV = 'test';
    const { Orchestrator } = await import('../../src/lib/orchestrator');
    const { EventEmitter } = await import('events');
    const orch = new Orchestrator(new EventEmitter() as any, { defaultPlacement: 'session' } as any);
    // job ja merged: branch ja integrada => diff vazio, mas status merged deve passar sem re-revisar
    git(repo, ['checkout', '-b', 'feat-term', 'main']);
    writeFileSync(join(repo, 't.txt'), 't\n');
    git(repo, ['add', 't.txt']);
    git(repo, ['commit', '-m', 'feat term']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-term']);
    git(repo, ['checkout', 'main']);
    git(intWt, ['merge', '--squash', 'feat-term']);
    git(intWt, ['commit', '-m', 'Merge feat-term']);
    const plan = {
      id: 'p1', name: 'p', mode: 'autopilot', status: 'running',
      jobs: [{ id: 'feat-term-id', name: 'feat-term', prompt: 'do feat-term\n\nAcceptance criteria:\n- [ ] t.txt exists', status: 'merged', branch: 'feat-term', worktreePath: repo }],
      integrationBranch: 'integration', integrationWorktree: intWt, baseCommit: 'x', createdAt: new Date().toISOString(),
    } as any;
    (orch as any).repoRoot = repo;
    const verdict = await (orch as any).reviewJobWithFixLoop(plan.jobs[0], plan);
    expect(verdict.verdict).toBe('pass');
    expect(String(jobHead).length).toBeGreaterThan(0);
  });
});

describe('B4 failed irmao nao bloqueia ready_to_merge elegivel (RED)', () => {
  it('gate permite ready_to_merge independente quando irmao falhou', async () => {
    const mod = (await import('../../src/lib/orchestrator')) as any;
    expect(typeof mod.canMergeJobNow).toBe('function');
    const jobs = [
      { name: 'capitalize-task', status: 'failed', mergeOrder: 0 },
      { name: 'pad-task', status: 'ready_to_merge', mergeOrder: 1 },
    ] as any;
    expect(mod.canMergeJobNow(jobs, 'pad-task')).toBe(true);
  });

  it('gate ainda bloqueia quando depende do job falho', async () => {
    const mod = (await import('../../src/lib/orchestrator')) as any;
    const jobs = [
      { name: 'capitalize-task', status: 'failed', mergeOrder: 0 },
      { name: 'index-task', status: 'ready_to_merge', mergeOrder: 2, dependsOn: ['capitalize-task'] },
    ] as any;
    expect(mod.canMergeJobNow(jobs, 'index-task')).toBe(false);
  });
});
