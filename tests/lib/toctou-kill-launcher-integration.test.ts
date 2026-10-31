import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import { Orchestrator } from '../../src/lib/orchestrator';
import * as planStateMod from '../../src/lib/plan-state';
import * as mergeTrainMod from '../../src/lib/merge-train';
import * as tmuxMod from '../../src/lib/tmux';
import * as sdkClientMod from '../../src/lib/sdk-client';

async function exec(args: string[], cwd: string) {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
async function mustExec(args: string[], cwd: string) {
  const r = await exec(args, cwd);
  if (r.exitCode !== 0) throw new Error(`cmd failed: ${args.join(' ')} ${r.stderr}`);
  return r.stdout;
}

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return { id: `${name}-id-12345678`, name, prompt: `do ${name}`, status: 'completed' as const, ...overrides };
}

describe('toctou kill launcher integration', () => {
  let rootDir = '';
  let repoDir = '';
  let monitor: any;

  beforeEach(() => {
    monitor = new EventEmitter();
  });
  afterEach(() => {
    mock.restore();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
  });

  it('mutation during test is never attributed as clean pass to the old commit', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-toctou-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 't@t.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'T'], repoDir);
    writeFileSync(join(repoDir, 'total.mjs'), 'export function total(xs){ return 0; }\n');
    writeFileSync(join(repoDir, 'check.mjs'), 'import { total } from "./total.mjs"; if (total([1,2])!==3) { console.error("wrong"); process.exit(1);} console.log("ok");\n');
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'init'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);
    await mustExec(['git', 'branch', 'integration'], repoDir);
    const jobHead = await mustExec(['git', 'rev-parse', 'HEAD'], repoDir);

    const orch = new Orchestrator(monitor, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      testCommand: 'node check.mjs',
    } as any);
    (orch as any).setRepoRoot(repoDir);

    const job = makeJob('total', { branch: 'main', worktreePath: repoDir, status: 'completed' as const });
    let calls = 0;
    spyOn(mergeTrainMod, 'runTestCommand').mockImplementation(async (dir: string, _cmd: string, _t: number) => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(join(dir, 'total.mjs'), 'export function total(xs){ return 3; }\n');
        return { success: true, output: 'ok', timedOut: false };
      }
      return { success: false, output: 'wrong', timedOut: false };
    });

    const gathered: any = await (orch as any).gatherScopeEvidence(job, jobHead, 'integration', ['total.mjs']);
    expect(gathered).not.toBeNull();
    const { evidence, fileContents } = gathered;
    // The test executed mutated content (return 3) while the commit holds return 0.
    // Job-scope contents win on collision, so the mutating run stays visible.
    expect(fileContents['total.mjs']).toContain('return 3');
    expect(evidence.output).toContain('identity refused');
    // Fixed behavior: never a clean pass stamped with the old commit.
    const cleanPassToOldCommit =
      evidence.exitCode === 0 && evidence.dirty !== true && evidence.testedCommit === jobHead;
    expect(cleanPassToOldCommit).toBe(false);
  });

  it('relaunch never kills a foreign same-prefix session', async () => {
    const plan: PlanSpec = {
      id: 'plan-12345678-aaaa-bbbb-cccc-1234567890ab',
      name: 'p',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('total', {
          branch: 'mc/total',
          worktreePath: '/tmp/wt-total',
          tmuxTarget: 'mc-total-recorded-owner',
          status: 'failed' as const,
        }),
      ],
      integrationBranch: 'mc/integration-plan',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    };
    spyOn(planStateMod, 'loadPlan').mockResolvedValue(JSON.parse(JSON.stringify(plan)));
    spyOn(planStateMod, 'updatePlanJob').mockResolvedValue();
    spyOn(tmuxMod, 'sessionExists').mockImplementation(async (name: string) => name === 'mc-total');
    const killSpy = spyOn(tmuxMod, 'killSession').mockResolvedValue();
    spyOn(tmuxMod, 'windowExists').mockResolvedValue(false);
    spyOn(tmuxMod, 'killWindow').mockResolvedValue();
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'createWindow').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);

    const orch = new Orchestrator(monitor, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      useServeMode: true,
    } as any);
    (orch as any).setRepoRoot('/tmp');
    (orch as any).activePlanId = plan.id;

    // Stub git + prompt + serve/tui downstream so the flow reaches completion.
    const git = await import('../../src/lib/git');
    spyOn(git, 'gitCommand').mockImplementation(async (args: string[]) => {
      const s = args.join(' ');
      if (s.includes('status --porcelain')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const promptFile = await import('../../src/lib/prompt-file');
    spyOn(promptFile, 'writePromptFile').mockResolvedValue('/tmp/p.txt');
    spyOn(promptFile, 'cleanupPromptFile').mockImplementation(() => {});
    spyOn(promptFile, 'cleanupLauncherScript').mockImplementation(() => {});
    spyOn(promptFile, 'writeLauncherScript').mockResolvedValue('/tmp/l.sh');
    spyOn(promptFile, 'writeServeLauncherScript').mockResolvedValue('/tmp/s.sh');
    const jobState = await import('../../src/lib/job-state');
    spyOn(jobState, 'loadJobState').mockResolvedValue({ version: 2, jobs: [], updatedAt: '' } as any);
    spyOn(jobState, 'addJob').mockResolvedValue();
    spyOn(jobState, 'removeJob').mockResolvedValue();
    const reports = await import('../../src/lib/reports');
    spyOn(reports, 'removeReport').mockResolvedValue();
    // Serve path stubs (fixed code uses serve by default).
    const portAlloc = await import('../../src/lib/port-allocator');
    spyOn(portAlloc, 'allocatePort').mockResolvedValue(14111 as never);
    spyOn(sdkClientMod, 'v2WaitForServer').mockResolvedValue({ baseUrl: '', headers: {} } as any);
    const serveSpy = spyOn(sdkClientMod, 'launchWorkerViaServe').mockResolvedValue({ sessionId: 'sess-1', tmuxTarget: 'x' } as any);

    await (orch as any).relaunchJobForCorrection('total', [], []);
    expect(killSpy).not.toHaveBeenCalledWith('mc-total');
    expect(killSpy.mock.calls.flat().includes('mc-total' as never)).toBe(false);
    expect(serveSpy).toHaveBeenCalled();
  });

  it('launchJob dispatches via verified serve with triple+variant and recorded tmuxTarget', async () => {
    const plan: PlanSpec = {
      id: 'plan-12345678-aaaa-bbbb-cccc-1234567890ab',
      name: 'p',
      mode: 'autopilot',
      status: 'running',
      jobs: [makeJob('worker-a', { status: 'queued' as const })],
      integrationBranch: 'mc/integration-plan',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    };
    let saved: PlanSpec = JSON.parse(JSON.stringify(plan));
    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => JSON.parse(JSON.stringify(saved)));
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(async (_id: string, name: string, u: Partial<JobSpec>) => {
      saved.jobs = saved.jobs.map((j) => (j.name === name ? { ...j, ...u } : j));
    });
    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue(undefined);
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(false);

    const orch = new Orchestrator(monitor, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      useServeMode: true,
    } as any);
    (orch as any).setRepoRoot('/tmp');
    (orch as any).activePlanId = saved.id;
    (orch as any).setPlanModelSnapshot('opencode-go/muse-spark-1.3-contributor#xhigh');
    spyOn(orch as any, 'createJobWorktree').mockResolvedValue('/tmp/wt-worker');
    const promptFile = await import('../../src/lib/prompt-file');
    spyOn(promptFile, 'writePromptFile').mockResolvedValue('/tmp/p.txt');
    spyOn(promptFile, 'cleanupPromptFile').mockImplementation(() => {});
    spyOn(promptFile, 'cleanupLauncherScript').mockImplementation(() => {});
    spyOn(promptFile, 'writeServeLauncherScript').mockResolvedValue('/tmp/s.sh');
    const portAlloc = await import('../../src/lib/port-allocator');
    spyOn(portAlloc, 'allocatePort').mockResolvedValue(14122 as never);
    spyOn(sdkClientMod, 'v2WaitForServer').mockResolvedValue({ baseUrl: '', headers: {} } as any);
    const serveSpy = spyOn(sdkClientMod, 'launchWorkerViaServe').mockResolvedValue({
      sessionId: 'sess-9',
      tmuxTarget: 'mc-worker-a-plan-123',
      model: { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'xhigh' },
    } as any);
    const jobState = await import('../../src/lib/job-state');
    spyOn(jobState, 'loadJobState').mockResolvedValue({ version: 2, jobs: [], updatedAt: '' } as any);
    spyOn(jobState, 'addJob').mockResolvedValue();
    spyOn(jobState, 'removeJob').mockResolvedValue();
    const reports = await import('../../src/lib/reports');
    spyOn(reports, 'removeReport').mockResolvedValue();

    await (orch as any).launchJob(saved.jobs[0]);
    expect(serveSpy).toHaveBeenCalled();
    const input = serveSpy.mock.calls[0][1];
    expect(input.model).toEqual({ providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'xhigh' });
    expect(typeof input.tmuxTarget).toBe('string');
    expect(input.tmuxTarget.length).toBeGreaterThan('mc-worker-a'.length);
    expect(input.prompt).toContain('mc_report');
  });
});
