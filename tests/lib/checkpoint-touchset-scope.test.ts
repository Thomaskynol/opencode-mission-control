import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import { Orchestrator } from '../../src/lib/orchestrator';
import * as planStateMod from '../../src/lib/plan-state';
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
  if (r.exitCode !== 0) throw new Error(`cmd failed: ${args.join(' ')} ${r.stderr} ${r.stdout}`);
  return r.stdout;
}

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return { id: `${name}-id-12345678`, name, prompt: `do ${name}`, status: 'failed' as const, ...overrides };
}

/**
 * Checkpoint scope (defect: `git add -A` committed files outside the touchSet,
 * M10: `.opencode/plugins/mc-mission-control/index.js` 1.7M landed in a
 * checkpoint commit). The checkpoint must stage only touchSet-matching files,
 * refuse `.opencode/**` and outsiders fail-closed with no commit.
 */
describe('checkpoint touchset scope', () => {
  let rootDir = '';
  let repoDir = '';
  let monitor: any;

  function mockDownstream() {
    spyOn(planStateMod, 'updatePlanJob').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'sessionExists').mockResolvedValue(false);
    spyOn(tmuxMod, 'windowExists').mockResolvedValue(false);
    spyOn(tmuxMod, 'killSession').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'killWindow').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'createSession').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'createWindow').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue(undefined as never);
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    return mockServePath();
  }

  async function mockServePath() {
    const promptFile = await import('../../src/lib/prompt-file');
    spyOn(promptFile, 'writeServeLauncherScript').mockResolvedValue('/tmp/s.sh');
    spyOn(promptFile, 'cleanupLauncherScript').mockImplementation(() => {});
    spyOn(promptFile, 'writePromptFile').mockResolvedValue('/tmp/p.txt');
    spyOn(promptFile, 'cleanupPromptFile').mockImplementation(() => {});
    const jobState = await import('../../src/lib/job-state');
    spyOn(jobState, 'loadJobState').mockResolvedValue({ version: 2, jobs: [], updatedAt: '' } as any);
    spyOn(jobState, 'addJob').mockResolvedValue(undefined as never);
    spyOn(jobState, 'removeJob').mockResolvedValue(undefined as never);
    const reports = await import('../../src/lib/reports');
    spyOn(reports, 'removeReport').mockResolvedValue(undefined as never);
    const portAlloc = await import('../../src/lib/port-allocator');
    spyOn(portAlloc, 'allocatePort').mockResolvedValue(14211 as never);
    spyOn(sdkClientMod, 'v2WaitForServer').mockResolvedValue({ baseUrl: '', headers: {} } as any);
    const serveSpy = spyOn(sdkClientMod, 'launchWorkerViaServe').mockResolvedValue({
      sessionId: 'sess-1',
      tmuxTarget: 'x',
      requestedModel: { providerID: 'opencode-go', id: 'm' },
      observedModel: { providerID: 'opencode-go', id: 'm' },
    } as any);
    return serveSpy;
  }

  function mockPlan(job: JobSpec) {
    const plan = {
      id: 'plan-12345678-aaaa-bbbb-cccc-1234567890ab',
      name: 'p',
      mode: 'autopilot',
      status: 'paused',
      jobs: [JSON.parse(JSON.stringify(job))],
      integrationBranch: 'mc/integration-plan',
      baseCommit: 'abc',
      createdAt: new Date().toISOString(),
    } as PlanSpec;
    spyOn(planStateMod, 'loadPlan').mockResolvedValue(JSON.parse(JSON.stringify(plan)) as never);
    return plan;
  }

  /** Real git fixture: tracked in-scope file + tracked (ignored) plugin + gitignore. */
  async function initFixture() {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-checkpoint-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 't@t.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'T'], repoDir);
    mkdirSync(join(repoDir, 'allowed'), { recursive: true });
    writeFileSync(join(repoDir, 'allowed', 'task.txt'), 'v1\n');
    writeFileSync(join(repoDir, '.gitignore'), '.opencode/\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'init'], repoDir);
    // Pre-existing pollution (M10 shape): plugin tracked despite the ignore.
    mkdirSync(join(repoDir, '.opencode', 'plugins', 'mc-mission-control'), { recursive: true });
    writeFileSync(join(repoDir, '.opencode', 'plugins', 'mc-mission-control', 'index.js'), '// v1\n');
    await mustExec(['git', 'add', '-f', '.opencode/plugins/mc-mission-control/index.js'], repoDir);
    await mustExec(['git', 'commit', '-m', 'track plugin'], repoDir);
  }

  async function commitCount(): Promise<string> {
    return mustExec(['git', 'rev-list', '--count', 'HEAD'], repoDir);
  }

  async function stagedPaths(): Promise<string[]> {
    const out = await mustExec(['git', 'diff', '--cached', '--name-only'], repoDir);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  beforeEach(() => {
    monitor = new EventEmitter();
  });

  afterEach(() => {
    mock.restore();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
  });

  it('refuses checkpoint with .opencode/outsider dirt: stages only in-scope, never commits', async () => {
    await initFixture();
    // Dirty: in-scope modification + blocked plugin modification + outsider.
    writeFileSync(join(repoDir, 'allowed', 'task.txt'), 'v2\n');
    writeFileSync(join(repoDir, '.opencode', 'plugins', 'mc-mission-control', 'index.js'), '// v2\n');
    writeFileSync(join(repoDir, 'outsider.txt'), 'junk\n');

    const job = makeJob('job-a', { branch: 'mc/job-a', worktreePath: repoDir });
    mockPlan(job);
    mockDownstream();

    const orch = new Orchestrator(monitor, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      useServeMode: true,
    } as any);
    (orch as any).setRepoRoot(repoDir);

    const before = await commitCount();
    let err: unknown = null;
    try {
      await (orch as any).relaunchJobForCorrection('job-a', ['outsider.txt'], ['allowed/**']);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toMatch(/\.opencode/);
    expect(String((err as Error).message)).toMatch(/outsider\.txt/);

    // Never committed: no new commit, outsiders never staged.
    expect(await commitCount()).toBe(before);
    expect(await stagedPaths()).toEqual(['allowed/task.txt']);
  });

  it('checkpoints clean in-scope dirt: one commit with only that file', async () => {
    await initFixture();
    writeFileSync(join(repoDir, 'allowed', 'task.txt'), 'v2\n');

    const job = makeJob('job-a', { branch: 'mc/job-a', worktreePath: repoDir });
    mockPlan(job);
    const serveSpy = await mockDownstream();

    const orch = new Orchestrator(monitor, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      useServeMode: true,
    } as any);
    (orch as any).setRepoRoot(repoDir);

    const before = await commitCount();
    await (orch as any).relaunchJobForCorrection('job-a', [], ['allowed/**']);
    expect(await commitCount()).toBe(String(Number(before) + 1));
    const files = await mustExec(['git', 'show', '--name-only', '--pretty=format:', 'HEAD'], repoDir);
    expect(files.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['allowed/task.txt']);
    expect(serveSpy).toHaveBeenCalled();
  });
});
