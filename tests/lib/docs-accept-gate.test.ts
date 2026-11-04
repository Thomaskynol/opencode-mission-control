import { describe, it, expect, afterEach, mock, spyOn } from 'bun:test';
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
 * Lane docs3 — gate: negating docs never auto-pass; explicit human accept
 * merges but stays Unverified (never Verified).
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
const ACCEPT_BACKUP = `Explain the backup restoration procedure.\n\nAcceptance criteria:\n- [ ] Explain the backup restoration procedure`;
const NEGATION_README = `# Backup restoration procedure
This document does not explain the backup restoration procedure. Nobody can recover files using these instructions. Follow the checklist carefully and review the output.`;

describe('docs semantics gate: negation blocks, human accept stays Unverified', () => {
  let rootDir: string;
  let repoDir: string;
  let integrationWorktree: string;
  let planState: PlanSpec | null;
  let monitor: EventEmitter;
  let restoreDataDir: () => void = () => {};

  async function seedRepo(readme: string) {
    rootDir = mkdtempSync(join(tmpdir(), 'mc-docs3-'));
    repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'check.mjs'), TRIVIAL_CHECK);
    writeFileSync(join(repoDir, 'docs-backup.md'), '# placeholder\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);
    await mustExec(['git', 'checkout', '-b', 'feature-backup', 'main'], repoDir);
    writeFileSync(join(repoDir, 'docs-backup.md'), readme);
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'docs: backup'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);
    await mustExec(['git', 'branch', 'integration'], repoDir);
    integrationWorktree = join(rootDir, 'integration-worktree');
    await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
    const baseCommit = await mustExec(['git', 'rev-parse', 'main'], repoDir);
    planState = {
      id: 'plan-docs3-1',
      name: 'docs3 work',
      mode: 'autopilot',
      status: 'running',
      jobs: [
        makeJob('backup-docs', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'feature-backup',
          touchSet: ['docs-backup.md'],
          prompt: ACCEPT_BACKUP,
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

  function newOrchestrator(): Orchestrator {
    const o = new Orchestrator(monitor as never, makeConfig());
    (o as unknown as { repoRoot: string }).repoRoot = repoDir;
    (o as unknown as { activePlanId: string }).activePlanId = 'plan-docs3-1';
    return o;
  }

  afterEach(() => {
    mock.restore();
    try { restoreDataDir(); } catch {}
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('negating docs-only task is REJECTED and pauses (never auto-pass)', async () => {
    await seedRepo(NEGATION_README);
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.jobs[0].status).toBe('failed');
    expect(planState!.status).toBe('paused');
    expect(planState!.jobs[0].error ?? '').toMatch(/deny|disclaim|inconclusive|contradict|fail-closed|explicit|external/i);
  });

  it('explicit human accept of the inconclusive pendency merges but stays Unverified (never Verified)', async () => {
    await seedRepo(NEGATION_README);
    mockPlanState();
    await driveRound(newOrchestrator());
    expect(planState!.status).toBe('paused');

    const jobHead = await mustExec(['git', 'rev-parse', 'feature-backup'], repoDir);
    // Explicit human accept of the CURRENT version (operator decision, version-bound).
    await (planStateMod.updatePlanJob as (p: string, n: string, u: Partial<JobSpec>) => Promise<void>)(
      'plan-docs3-1',
      'backup-docs',
      {
        status: 'ready_to_merge',
        error: undefined,
        reviewApproval: {
          reviewedCommit: jobHead,
          reviewedBase: planState!.baseCommit,
          reason: 'operator accept of inconclusive docs pendency (explicit human decision)',
          at: new Date().toISOString(),
          kind: 'accept',
        },
      } as Partial<JobSpec>,
    );
    await (planStateMod.updatePlanFields as (p: string, u: Partial<PlanSpec>) => Promise<void>)(
      'plan-docs3-1',
      { status: 'running', checkpoint: null, checkpointContext: null } as unknown as Partial<PlanSpec>,
    );

    await driveRound(newOrchestrator());
    expect(planState!.jobs.map((j) => `${j.name}:${j.status}`).join(',')).toContain('backup-docs:merged');

    const { loadMergeEvidence } = await import('../../src/lib/durable-state');
    const { isTaskVerified } = await import('../../src/lib/verification');
    const evidence = await loadMergeEvidence().catch(() => ({}));
    const rec = (evidence as Record<string, { testStatus?: string; scope?: string; reviewedCommit?: string; acceptanceLess?: boolean }>)['backup-docs'];
    // Never auto-pass: no task-scoped passed evidence is minted for a disclaimed/inconclusive doc.
    // The human accept proceeds, but the outcome must NOT render as Verified.
    expect(isTaskVerified(rec as never)).toBe(false);
  });
});
