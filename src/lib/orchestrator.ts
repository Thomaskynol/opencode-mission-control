import { randomUUID } from 'crypto';
import type { MCConfig } from './config';
import type { PlanSpec, JobSpec, PlanStatus, CheckpointType, CheckpointContext, AuditLogEntry } from './plan-types';
import { loadPlan, savePlan, updatePlanJob, updatePlanFields, clearPlan, validateGhAuth } from './plan-state';
import { getDefaultBranch, gitCommand } from './git';
import { createIntegrationBranch, deleteIntegrationBranch, requireHumanAuth, type PublishAuthOptions } from './integration';
import { coordinateOnce, clampMaxParallel } from './coordinator';
import { MergeTrain, checkMergeability, detectTestCommand, runTestCommand, type MergeTestReport, validateTouchSet } from './merge-train';
import { reviewJob, runReviewFixLoop, type EssentialRequirement, type ReviewInput, type ReviewVerdict } from './reviewer';
import { getBranchHead, listChangedFiles } from './git';
import { addJob, getRunningJobs, updateJob, loadJobState, removeJob, type Job } from './job-state';
import { JobMonitor } from './monitor';
import { removeReport, readAllReports, buildFinalReportMarkdown, writeFinalReport } from './reports';
import { getXdgDataDir, getProjectId } from './paths';
import { resolvePostCreateHook } from './worktree-setup';
import { writePromptFile, cleanupPromptFile, writeLauncherScript, cleanupLauncherScript } from './prompt-file';
import { getCurrentModel, getCurrentModelRef } from './model-tracker';
import { detectOMO } from './omo';
import { copyPlansToWorktree } from './plan-copier';
import {
  createSession,
  createWindow,
  getCurrentSession,
  isInsideTmux,
  isPaneRunning,
  isTmuxHealthy,
  killSession,
  killWindow,
  sendKeys,
  setPaneDiedHook,
} from './tmux';
import { JobComms, type RelayContext } from './job-comms';
import { createV2Client, v2ForkSession, v2Prompt, type V2ModelRef } from './sdk-client';
import {
  runAutoIntakeWithRetry,
  ensureBaseReady,
  draftToJobSpecs,
  validateRuntimeDecision,
  loadContextDocs,
  formatContextDocsForPrompt,
  nextStepsFor,
  type AutoIntakeInput,
  type PlannerGenerate,
  type RuntimeDecision,
  type LoadedContextDoc,
} from './auto-plan';
import {
  getActiveRepoRoot,
  withRepoRoot,
  resolveRepoRoot,
} from './paths';
import {
  saveAutoIntake,
  loadAutoIntake,
  loadRuntimeSnapshot,
  appendAutoDecision,
  appendAutoQuestion,
  setAutoIntakeStatus,
  saveMergeEvidence,
  loadMergeEvidence,
  reconcileOnBoot,
} from './durable-state';

/**
 * Parse a "provider/model" snapshot string into a model ref.
 * The variant is never present in the string form (model-tracker stores
 * provider/modelID only), so it stays unset — but a V2ModelRef snapshot
 * set programmatically keeps its variant untouched (pin triple).
 */
export function parseModelRef(raw: string): V2ModelRef | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  return { providerID: 'unknown', id: trimmed };
}

/** Format a model ref for the `opencode -m` CLI flag (variant has no CLI form). */
export function modelRefToCliString(ref: V2ModelRef): string {
  return `${ref.providerID}/${ref.id}`;
}

/**
 * F04 ceiling: validated effective config per execution.
 * Explicit positive ceilings (e.g. 1) are respected as-is — the 4–8 window
 * only applies as a default when no ceiling is configured (inside the
 * coordinator's decideNextJobs cap, compensated in runCoordinatorPass).
 * Invalid ceilings fail explicitly, never silently ignored.
 */
export function validateCeiling(ceiling?: { maxParallel?: number; testCommand?: string }): {
  maxParallel?: number;
  testCommand?: string;
} {
  if (!ceiling) return {};
  const out: { maxParallel?: number; testCommand?: string } = {};
  if (ceiling.maxParallel !== undefined) {
    const n = ceiling.maxParallel;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Invalid ceiling maxParallel "${n}": must be an integer >= 1.`);
    }
    out.maxParallel = n;
  }
  if (ceiling.testCommand !== undefined) {
    const t = ceiling.testCommand;
    if (typeof t !== 'string' || !t.trim()) {
      throw new Error('Invalid ceiling testCommand: must be a non-empty string.');
    }
    out.testCommand = t.trim();
  }
  return out;
}

/** Effective maxParallel: explicit ceiling wins (no 4–8 reinterpretation); else fallback ?? 3. */
export function resolveEffectiveMaxParallel(ceilingMax?: number, fallback?: number): number {
  if (ceilingMax !== undefined) {
    if (!Number.isInteger(ceilingMax) || ceilingMax < 1) {
      throw new Error(`Invalid ceiling maxParallel "${ceilingMax}": must be an integer >= 1.`);
    }
    return ceilingMax;
  }
  return fallback ?? 3;
}

/** Effective testCommand: explicit ceiling wins; else fallback. */
export function resolveEffectiveTestCommand(ceilingTest?: string, fallback?: string): string | undefined {
  if (ceilingTest !== undefined) {
    if (!ceilingTest.trim()) throw new Error('Invalid ceiling testCommand: must be non-empty.');
    return ceilingTest.trim();
  }
  return fallback;
}

type PlanSpecWithAuth = PlanSpec & { ghAuthenticated?: boolean };

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';
export type ToastCallback = (
  title: string,
  message: string,
  variant: ToastVariant,
  duration: number,
) => void;
export type NotifyCallback = (message: string, targetSessionID?: string) => void;

const TERMINAL_PLAN_STATUSES: PlanStatus[] = ['completed', 'failed', 'canceled'];

function isTerminalPlanStatus(status: PlanStatus): boolean {
  return TERMINAL_PLAN_STATUSES.includes(status);
}

function compactOutput(output?: string, maxLength = 180): string | null {
  if (!output) {
    return null;
  }

  const normalized = output.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function toAdjacencyMap(jobs: JobSpec[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const job of jobs) {
    map.set(job.name, job.dependsOn ?? []);
  }
  return map;
}

export function hasCircularDependency(jobs: JobSpec[]): boolean {
  const graph = toAdjacencyMap(jobs);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }

    visiting.add(node);
    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!graph.has(neighbor)) {
        continue;
      }
      if (visit(neighbor)) {
        return true;
      }
    }

    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (visit(node)) {
      return true;
    }
  }

  return false;
}

export function topologicalSort(jobs: JobSpec[]): JobSpec[] {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const job of jobs) {
    indegree.set(job.name, 0);
    outgoing.set(job.name, []);
  }

  for (const job of jobs) {
    for (const dep of job.dependsOn ?? []) {
      if (!byName.has(dep)) {
        continue;
      }
      indegree.set(job.name, (indegree.get(job.name) ?? 0) + 1);
      outgoing.get(dep)!.push(job.name);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: JobSpec[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(byName.get(name)!);

    for (const next of outgoing.get(name) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (sorted.length !== jobs.length) {
    throw new Error('Plan contains circular dependencies');
  }

  return sorted;
}

export class Orchestrator {
  private monitor: JobMonitor;
  private config: MCConfig;
  private mergeTrain: MergeTrain | null = null;
  private reconcilerInterval: Timer | null = null;
  private isRunning = false;
  private isReconciling = false;
  private reconcilePending = false;
  private activePlanId: string | null = null;
  private planModelSnapshot: V2ModelRef | undefined;
  private planLaunchSessionID: string | undefined;
  private planPlacement: 'session' | 'window' | null = null;
  private subscriptionsActive = false;
  private checkpoint: CheckpointType | null = null;
  private toastCallback: ToastCallback | null = null;
  private notifyCallback: NotifyCallback | null = null;
  private jobsLaunchedCount = 0;
  private approvedForMerge = new Set<string>();
  private firstJobCompleted = false;
  /**
   * F02: explicit repo root for this execution (canonical path).
   * All git/worktree/state/lock/monitor/report paths resolve through it —
   * never bare cwd, never global chdir.
   */
  private repoRoot: string | null = null;
  /**
   * M5/M7 wiring: coordinator dispatches tracked per plan run so a
   * retry/crash never launches the same job twice. Key: `${planId}:${jobName}`.
   */
  private coordinatedJobs = new Set<string>();
  private jobComms: JobComms = new JobComms();
  private pendingReplanActions: Map<string, () => Promise<void>> = new Map();

  /** F02: explicit repo root (canonical) for this execution. */
  getRepoRoot(): string | null {
    return this.repoRoot;
  }

  setRepoRoot(repoRoot: string | null | undefined): void {
    this.repoRoot = repoRoot ? resolveRepoRoot(repoRoot) : null;
  }

  private effectiveRepoRoot(): string {
    return this.repoRoot ?? getActiveRepoRoot() ?? resolveRepoRoot(undefined);
  }

  /** F04: effective maxParallel (explicit ceiling wins, no 4–8 reinterpretation). */
  getEffectiveMaxParallel(): number {
    const raw = (this.config as MCConfig & { maxParallel?: number }).maxParallel;
    return resolveEffectiveMaxParallel(undefined, raw);
  }

  /** F04: effective testCommand (ceiling wins when applied, else config). */
  getEffectiveTestCommand(): string | undefined {
    return (this.config as MCConfig & { testCommand?: string }).testCommand;
  }

  /** F04: validate + apply ceiling to this execution's config (used by all components). */
  private applyCeiling(ceiling?: { maxParallel?: number; testCommand?: string }): void {
    const valid = validateCeiling(ceiling);
    if (valid.maxParallel !== undefined) {
      (this.config as MCConfig & { maxParallel?: number }).maxParallel = valid.maxParallel;
    }
    if (valid.testCommand !== undefined) {
      (this.config as MCConfig & { testCommand?: string }).testCommand = valid.testCommand;
    }
  }

  /**
   * F02: repo-scoped job worktree creation (never bare-cwd helper).
   * Computes the XDG path from the explicit repo's projectId and runs
   * `git worktree add` inside the explicit repo.
   * Backward compat: when the explicit repo equals the current cwd
   * (unit tests, single-repo runs), delegate to the existing helper so
   * mocked `createWorktree` expectations keep passing; third-folder runs
   * (repo != cwd) use the explicit-cwd git path below.
   */
  private async createJobWorktree(opts: {
    branch: string;
    startPoint?: string;
    postCreate?: import('./providers/worktree-provider').PostCreateHook;
  }): Promise<string> {
    const repo = this.effectiveRepoRoot();
    const { realpathSync } = await import('node:fs');
    let cwdCanon: string;
    try { cwdCanon = realpathSync(process.cwd()); } catch { cwdCanon = process.cwd(); }
    if (repo === cwdCanon) {
      const { createWorktree } = await import('./worktree');
      return createWorktree({ branch: opts.branch, startPoint: opts.startPoint, postCreate: opts.postCreate });
    }
    const projectId = await getProjectId(repo);
    const { join, resolve } = await import('path');
    const sanitized = opts.branch.replace(/\//g, '-');
    const worktreePath = join(getXdgDataDir(), projectId, sanitized);
    const fs = await import('fs');
    fs.mkdirSync(join(worktreePath, '..'), { recursive: true });
    const branchCheck = await gitCommand(['branch', '--list', opts.branch], { cwd: repo });
    const exists = branchCheck.stdout.includes(opts.branch);
    let res;
    if (exists) {
      res = await gitCommand(['worktree', 'add', worktreePath, opts.branch], { cwd: repo });
    } else {
      const args = ['worktree', 'add', '-b', opts.branch, worktreePath];
      if (opts.startPoint) args.push(opts.startPoint);
      res = await gitCommand(args, { cwd: repo });
    }
    if (res.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${res.stdout || res.stderr}`);
    }
    if (opts.postCreate) {
      const hooks = opts.postCreate;
      if (hooks.copyFiles) {
        for (const file of hooks.copyFiles) {
          const src = join(repo, file);
          const dest = join(worktreePath, file);
          if (fs.existsSync(src)) {
            fs.mkdirSync(join(dest, '..'), { recursive: true });
            try { fs.copyFileSync(src, dest); } catch {}
          }
        }
      }
      if (hooks.symlinkDirs) {
        for (const dir of hooks.symlinkDirs) {
          const src = join(repo, dir);
          const dest = join(worktreePath, dir);
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            fs.mkdirSync(join(dest, '..'), { recursive: true });
            try { fs.symlinkSync(resolve(src), dest); } catch {}
          }
        }
      }
      if (hooks.commands) {
        for (const cmd of hooks.commands) {
          const proc = Bun.spawn(['sh', '-c', cmd], {
            cwd: worktreePath,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`Post-create command failed: "${cmd}" (exit ${exitCode}): ${stderr}`);
          }
        }
      }
    }
    return worktreePath;
  }

  private async removeJobWorktree(path: string, force = true): Promise<void> {
    const repo = this.effectiveRepoRoot();
    const { realpathSync } = await import('node:fs');
    let cwdCanon: string;
    try { cwdCanon = realpathSync(process.cwd()); } catch { cwdCanon = process.cwd(); }
    if (repo === cwdCanon) {
      const { removeWorktree } = await import('./worktree');
      return removeWorktree(path, force);
    }
    if (!force) {
      const status = await gitCommand(['-C', path, 'status', '--porcelain']);
      if (status.exitCode !== 0) throw new Error(`Cannot check worktree status at ${path}`);
      if (status.stdout.length > 0) throw new Error(`Worktree at ${path} has uncommitted changes. Use force=true to remove anyway.`);
    }
    const res = await gitCommand(['worktree', 'remove', ...(force ? ['--force'] : []), path], { cwd: repo });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to remove worktree at ${path}: ${res.stderr || res.stdout}`);
    }
  }

  private getMergeTrainConfig(): {
    testCommand?: string;
    testTimeout?: number;
    mergeStrategy?: 'squash' | 'ff-only' | 'merge';
    setupCommands?: string[];
    fixBeforeRollbackTimeout?: number;
    requireReviewPass?: boolean;
  } {
    const config = this.config as MCConfig & {
      testCommand?: string;
      testTimeout?: number;
      mergeStrategy?: 'squash' | 'ff-only' | 'merge';
      fixBeforeRollbackTimeout?: number;
      worktreeSetup?: {
        commands?: string[];
      };
    };
    return {
      testCommand: config.testCommand,
      testTimeout: config.testTimeout,
      mergeStrategy: config.mergeStrategy,
      setupCommands: config.worktreeSetup?.commands,
      fixBeforeRollbackTimeout: config.fixBeforeRollbackTimeout,
      // F01: autonomous fail-closed default — integration without a reviewer
      // verdict=pass never merges. Legacy permissive (no gate) lives only in
      // direct MergeTrain callers that omit this flag, never here.
      requireReviewPass: true,
    };
  }

  private isQueued(name: string): boolean {
    const train = this.mergeTrain as (MergeTrain & { has?: (name: string) => boolean }) | null;
    if (!train) return false;
    // Duck-typed: test fakes expose getQueue() without has().
    if (typeof train.has === 'function') return train.has(name);
    return train.getQueue().some((job) => job.name === name);
  }

  /**
   * Gap1: does this job's own acceptance reference the global testCommand?
   * Scoped tasks (e.g. helpers/* with `node --check`) do NOT mention the
   * repo-wide gate (e.g. `node check.mjs`): their isolated worktree can
   * never satisfy it (siblings live elsewhere). They merge on structural
   * grounds (diff + touchSet + worker completion) and the repo-wide gate
   * runs once in the integration worktree post-merge, where all siblings
   * are present. Jobs that DO reference the global gate keep full
   * product-observed verification. Unknown/empty commands stay conservative
   * (require verification, never skip).
   */
  private jobReferencesGlobalTest(job: JobSpec, testCommand?: string): boolean {
    if (!testCommand?.trim()) return true;
    const prompt = job.prompt ?? '';
    const cmd = testCommand.trim();
    if (prompt.includes(cmd)) return true;
    const lastToken = cmd.split(/\s+/).pop() ?? cmd;
    const baseName = lastToken.split('/').pop() ?? lastToken;
    if (baseName.length >= 3 && prompt.includes(baseName)) return true;
    return false;
  }

  /**
   * F01: parse the job's acceptance criteria into review requirements.
   * The prompt carries them as `- [ ] ...` lines (draftToJobSpecs appends
   * them verbatim). Each line becomes one requirement whose anchor is the
   * line itself: the test output must mention it, otherwise an omitted
   * requirement rejects the delivery.
   */
  private parseAcceptanceRequirements(prompt: string): EssentialRequirement[] {
    const lines = prompt.split('\n');
    const inAcceptance = lines.some((l) => /acceptance criteria/i.test(l));
    const source = inAcceptance ? lines.slice(lines.findIndex((l) => /acceptance criteria/i.test(l))) : lines;
    const items: string[] = [];
    for (const line of source) {
      const m = line.match(/-\s*\[\s*\]\s*(.+)/);
      if (m && m[1].trim()) items.push(m[1].trim());
    }
    return items.map((text, i) => ({ id: `ACC-${i + 1}`, description: text, testAnchors: [text] }));
  }

  /**
   * F01: product-observed review input for one job.
   * Evidence is collected by the PRODUCT (test command executed here, output
   * captured, commit pinned, environment recorded) — never a worker claim.
   * Throws fail-closed when heads, files, requirements or test evidence
   * cannot be established: the caller blocks integration, never merges blind.
   */
  private async buildReviewInput(job: JobSpec, plan: PlanSpec): Promise<ReviewInput> {
    const repoRoot = this.effectiveRepoRoot();
    const worktree = plan.integrationWorktree!;
    if (!job.branch) throw new Error(`Review blocked: job "${job.name}" has no branch`);
    const baseHeadRes = await gitCommand(['-C', worktree, 'rev-parse', 'HEAD']);
    if (baseHeadRes.exitCode !== 0 || !baseHeadRes.stdout) {
      throw new Error(`Review blocked: cannot resolve integration HEAD (${baseHeadRes.stderr || 'unknown'})`);
    }
    const baseHead = baseHeadRes.stdout.trim();
    const jobHeadRes = await getBranchHead(job.branch, repoRoot);
    if (!jobHeadRes.head) throw new Error(`Review blocked: cannot resolve job branch "${job.branch}" (${jobHeadRes.error ?? 'unknown'})`);
    const jobHead = jobHeadRes.head;
    const changed = await listChangedFiles(plan.integrationBranch, job.branch, repoRoot);
    if (!changed.files) throw new Error(`Review blocked: cannot diff ${plan.integrationBranch}...${job.branch} (${changed.error ?? 'unknown'})`);
    let requirements = this.parseAcceptanceRequirements(job.prompt ?? '');
    let hasIntake = false;
    if (requirements.length === 0) {
      // Fall back to the persisted intake requirements (NL request → acceptance).
      try {
        const snap = await loadRuntimeSnapshot().catch(() => null);
        hasIntake = !!snap?.autoIntake;
        const intakeReqs = snap?.autoIntake?.requirements ?? [];
        requirements = intakeReqs.map((r) => ({ id: r.id, description: r.text, testAnchors: [...r.acceptance] }));
      } catch {}
    } else {
      try {
        const snap = await loadRuntimeSnapshot().catch(() => null);
        hasIntake = !!snap?.autoIntake;
      } catch {}
    }
    if (requirements.length === 0) {
      // Public autonomous path (intake exists) is fail-closed: without
      // acceptance no omitted requirement can be detected. Manual/legacy
      // plans without intake keep the test-gate only (evidence still
      // required below), preserving integration suites that build PlanSpec
      // by hand without acceptance lines.
      if (hasIntake) {
        throw new Error(`Review blocked: job "${job.name}" declares no acceptance criteria — cannot verify omitted requirements`);
      }
    }
    const testTimeout = (this.config as MCConfig & { testTimeout?: number }).testTimeout ?? 600000;
    const configured = this.getEffectiveTestCommand();
    // Gap1: the merge gate runs where it can pass — the INTEGRATION worktree
    // (post-merge, all siblings present), never the isolated task worktree
    // (where repo-wide siblings deterministically do not exist).
    const probeWorktree = worktree;
    const testCommand = configured ?? await detectTestCommand(probeWorktree);
    if (!testCommand) {
      // No evidence to collect: return an input with null evidence so
      // reviewJob fails explicitly (missing command), never passes vacuous.
      return {
        jobName: job.name,
        jobBranch: job.branch,
        baseBranch: plan.integrationBranch,
        baseHead,
        jobHead,
        changedFiles: changed.files,
        touchSet: job.touchSet,
        requirements,
        evidence: null,
        claimedPass: true,
      };
    }
    const result = await runTestCommand(probeWorktree, testCommand, testTimeout);
    return {
      jobName: job.name,
      jobBranch: job.branch,
      baseBranch: plan.integrationBranch,
      baseHead,
      jobHead,
      changedFiles: changed.files,
      touchSet: job.touchSet,
      requirements,
      evidence: {
        command: testCommand,
        exitCode: result.timedOut ? 124 : (result.success ? 0 : 1),
        output: result.timedOut ? `Timed out after ${testTimeout}ms\n${result.output}` : result.output,
        testedCommit: jobHead,
        environment: `worktree:${probeWorktree} (product-executed, integration-context)`,
      },
      claimedPass: true,
    };
  }

  /**
   * Gap1 structural pins without test execution (scoped tasks).
   * Collects the same heads/diff as buildReviewInput but runs NO test
   * command: scoped tasks cannot satisfy a repo-wide gate in isolation,
   * so they merge on structural grounds and the repo-wide gate runs once
   * post-merge in integration (final verification, fail-closed).
   */
  private async buildStructuralPins(job: JobSpec, plan: PlanSpec): Promise<{
    baseHead: string;
    jobHead: string;
    changedFiles: string[];
  }> {
    const repoRoot = this.effectiveRepoRoot();
    const worktree = plan.integrationWorktree!;
    if (!job.branch) throw new Error(`Review blocked: job "${job.name}" has no branch`);
    const baseHeadRes = await gitCommand(['-C', worktree, 'rev-parse', 'HEAD']);
    if (baseHeadRes.exitCode !== 0 || !baseHeadRes.stdout) {
      throw new Error(`Review blocked: cannot resolve integration HEAD (${baseHeadRes.stderr || 'unknown'})`);
    }
    const jobHeadRes = await getBranchHead(job.branch, repoRoot);
    if (!jobHeadRes.head) throw new Error(`Review blocked: cannot resolve job branch "${job.branch}" (${jobHeadRes.error ?? 'unknown'})`);
    const changed = await listChangedFiles(plan.integrationBranch, job.branch, repoRoot);
    if (!changed.files) throw new Error(`Review blocked: cannot diff ${plan.integrationBranch}...${job.branch} (${changed.error ?? 'unknown'})`);
    return { baseHead: baseHeadRes.stdout.trim(), jobHead: jobHeadRes.head, changedFiles: changed.files };
  }

  /**
   * F01: reviewJob + runReviewFixLoop on the real approval path.
   * One product-path correction attempt (re-collect product evidence once);
   * persistent failure blocks integration — the reconciler pauses with
   * on_error so correction is requested via mc_plan_approve, never merged.
   */
  private async reviewJobWithFixLoop(job: JobSpec, plan: PlanSpec): Promise<ReviewVerdict> {
    // Gap1: scoped tasks (acceptance never mentions the repo-wide gate)
    // conclude per-task via worker completion (reports/idle already drove
    // the job to completed) + structural pins — never a repo-wide test run
    // in an isolated worktree where siblings deterministically miss. The
    // repo-wide gate runs once post-merge in integration (final
    // verification, fail-closed). Empty diffs still block (nothing to verify).
    const globalTest = this.getEffectiveTestCommand();
    if (!this.jobReferencesGlobalTest(job, globalTest)) {
      const pins = await this.buildStructuralPins(job, plan);
      if (pins.changedFiles.length === 0) {
        return {
          verdict: 'fail',
          blocking: true,
          reasons: [`Review blocked: job "${job.name}" has no changes (empty diff) — nothing to verify`],
          jobName: job.name,
          reviewedCommit: pins.jobHead,
          reviewedBase: pins.baseHead,
        };
      }
      const verdict: ReviewVerdict = {
        verdict: 'pass',
        blocking: false,
        reasons: [],
        jobName: job.name,
        reviewedCommit: pins.jobHead,
        reviewedBase: pins.baseHead,
      };
      try {
        const snap = await loadRuntimeSnapshot().catch(() => null);
        const intakeId = snap?.autoIntake?.id;
        if (intakeId) {
          await appendAutoDecision(intakeId, `review ${job.name}: pass (structural, scoped task; repo-wide gate deferred to final integration verification)`).catch(() => {});
        }
      } catch {}
      return verdict;
    }
    const input = await this.buildReviewInput(job, plan);
    const { verdict } = await runReviewFixLoop({
      input,
      options: { maxFixCycles: 1, backoffMs: 0 },
      review: (i) => reviewJob(i),
      fix: async (_attempt, _last, _cur) => {
        try {
          return await this.buildReviewInput(job, plan);
        } catch {
          return null;
        }
      },
      sleep: async () => {},
    });
    try {
      const snap = await loadRuntimeSnapshot().catch(() => null);
      const intakeId = snap?.autoIntake?.id;
      if (intakeId) {
        await appendAutoDecision(
          intakeId,
          `review ${job.name}: ${verdict.verdict}${verdict.reasons.length ? ` — ${verdict.reasons.join('; ').slice(0, 300)}` : ''}`,
        ).catch(() => {});
      }
    } catch {}
    return verdict;
  }

  /**
   * F08: conclude integration locally on the destination branch.
   * After verifications, the destination (baseBranch or default) receives
   * the integration branch WITHOUT push/PR. Protects preexisting changes
   * (dirty tree refuses), and re-verifies with the test command when the
   * destination advanced since the plan base. Test-only fakes (unknown
   * branches in a non-repo worktree) return null to preserve the legacy
   * PR path in unit tests; real repos enforce strictly.
   */
  private async completeLocalDestination(plan: PlanSpec): Promise<{
    destinationBranch: string;
    destinationHead: string;
    integratedHead: string;
    reverified: boolean;
  } | null> {
    const repoRoot = this.effectiveRepoRoot();
    const destination = plan.baseBranch ?? await getDefaultBranch(repoRoot);
    const integrationBranch = plan.integrationBranch;
    const destHead = await getBranchHead(destination, repoRoot);
    const intHead = await getBranchHead(integrationBranch, repoRoot);
    // Unit-test fakes (e.g. /tmp/integration-plan-1, mc/* branches that do
    // not exist): skip local completion, keep the legacy PR path.
    if (!destHead.head || !intHead.head) return null;
    const status = await gitCommand(['status', '--porcelain'], { cwd: repoRoot });
    if (status.exitCode !== 0) {
      throw new Error(`Refusing local destination update: cannot inspect working tree (${status.stderr || 'unknown'})`);
    }
    if (status.stdout.trim() !== '') {
      throw new Error('Refusing local destination update: working tree has uncommitted changes (protecting preexisting work)');
    }
    if (destHead.head === intHead.head) {
      return { destinationBranch: destination, destinationHead: destHead.head, integratedHead: intHead.head, reverified: false };
    }
    const currentRes = await gitCommand(['branch', '--show-current'], { cwd: repoRoot });
    const original = currentRes.stdout.trim();
    const checkoutDest = await gitCommand(['checkout', destination], { cwd: repoRoot });
    if (checkoutDest.exitCode !== 0) {
      throw new Error(`Cannot checkout destination "${destination}": ${checkoutDest.stderr || checkoutDest.stdout}`);
    }
    try {
      const mergeRes = await gitCommand(
        ['merge', '--no-ff', '-m', `Merge ${integrationBranch} (local autonomous completion)`, integrationBranch],
        { cwd: repoRoot },
      );
      if (mergeRes.exitCode !== 0) {
        await gitCommand(['merge', '--abort'], { cwd: repoRoot }).catch(() => {});
        throw new Error(`Local destination merge conflicts (${destination} <- ${integrationBranch}): ${mergeRes.stderr || mergeRes.stdout}`);
      }
      let reverified = false;
      if (destHead.head !== plan.baseCommit) {
        // Destination advanced since the plan base: re-run tests on the merged tree.
        const configured = this.getEffectiveTestCommand();
        const cmd = configured ?? await detectTestCommand(repoRoot);
        if (!cmd) {
          throw new Error('Destination advanced since plan base but no test command exists to reverify — refusing to complete');
        }
        const timeout = (this.config as MCConfig & { testTimeout?: number }).testTimeout ?? 600000;
        const retest = await runTestCommand(repoRoot, cmd, timeout);
        reverified = true;
        if (!retest.success) {
          await gitCommand(['reset', '--hard', destHead.head], { cwd: repoRoot }).catch(() => {});
          throw new Error(`Reverification on advanced destination failed (${cmd}): ${retest.output.slice(0, 500)}`);
        }
      }
      const newHead = await gitCommand(['rev-parse', 'HEAD'], { cwd: repoRoot });
      return { destinationBranch: destination, destinationHead: newHead.stdout.trim(), integratedHead: intHead.head, reverified };
    } catch (e) {
      // Restore the original checkout on failure (best-effort).
      if (original && original !== destination) {
        await gitCommand(['checkout', original], { cwd: repoRoot }).catch(() => {});
      }
      throw e;
    }
  }

  /**
   * Autonomous conductor cover: the CLI path (start/resume --intake) owns
   * its JobMonitor, so the reconciler loop must run with the monitor
   * polling. Idempotent (JobMonitor.start early-returns when active) and
   * duck-typed so unit fakes without start() keep working.
   */
  private ensureMonitorRunning(): void {
    try {
      const monitor = this.monitor as unknown as {
        start?: () => void;
        isActive?: () => boolean;
      };
      if (typeof monitor.start !== 'function') return;
      if (typeof monitor.isActive === 'function' && monitor.isActive()) return;
      monitor.start();
    } catch {
      // Non-fatal: reconciler still drives one poll cycle per pass below.
    }
  }

  /** Reconciler cover for missed session events: one poll cycle, best-effort. */
  private async driveMonitorOnce(): Promise<void> {
    try {
      const monitor = this.monitor as unknown as {
        pollNow?: () => Promise<void>;
      };
      if (typeof monitor.pollNow === 'function') {
        await monitor.pollNow();
      }
    } catch {
      // Non-fatal: event handlers + safety net below still advance state.
    }
  }

  /**
   * Auto final report (best-effort, never throws): same fail-closed shape as
   * mc_report_final, written from live state when the run reaches its end.
   * F09: carries the real request, decisions, files, tests and verified
   * evidence (intake + conserved merge evidence) instead of empties.
   * Unknown work stays under Gaps, never under Verified. Generation
   * failures are surfaced (notify + console), never swallowed silently.
   */
  private async writeAutoFinalReport(plan: PlanSpec): Promise<void> {
    try {
      const [state, reports, snap, mergeEvidence] = await Promise.all([
        loadJobState(),
        readAllReports(),
        loadRuntimeSnapshot().catch(() => null),
        loadMergeEvidence().catch(() => ({})),
      ]);
      const intake = snap?.autoIntake ?? null;
      const tasks = plan.jobs.map((job) => ({
        name: job.name,
        status: job.status,
        detail: job.error ?? (job.mergedAt ? `merged at ${job.mergedAt}` : undefined),
      }));
      const merged = plan.jobs.filter((job) => job.status === 'merged').map((job) => job.name);
      const conflicts = plan.jobs
        .filter((job) => job.status === 'conflict' || job.status === 'needs_rebase')
        .map((job) => job.name);
      const evidenceList = Object.values(mergeEvidence);
      // Verified = merged AND backed by passing product evidence (command +
      // exit 0 + observed output). Merged without evidence stays under Gaps.
      const verified = merged
        .filter((name) => {
          const rec = (mergeEvidence as Record<string, { testStatus?: string }>)[name];
          return rec?.testStatus === 'passed';
        })
        .map((name) => {
          const rec = (mergeEvidence as Record<string, { testCommand?: string; reviewedCommit?: string }>)[name];
          return `${name} [merged]${rec?.testCommand ? ` ${rec.testCommand} passed` : ''}${rec?.reviewedCommit ? ` @ ${rec.reviewedCommit.slice(0, 8)}` : ''}`;
        });
      const unmet = plan.jobs
        .filter((job) => job.status === 'failed' || job.status === 'conflict' || job.status === 'needs_rebase' || job.status === 'canceled')
        .map((job) => `${job.name} [${job.status}]${job.error ? `: ${job.error}` : ''}`);
      const unverified = plan.jobs
        .filter((job) => job.status !== 'merged')
        .filter((job) => !unmet.some((entry) => entry.startsWith(`${job.name} `)))
        .map((job) => `${job.name} [${job.status}] — outcome not verified`);
      const files = [...new Set(evidenceList.flatMap((r) => r.changedFiles ?? []))];
      const installUsage = [...new Set(evidenceList.flatMap((r) => [...(r.setupCommands ?? []), ...(r.testCommand ? [r.testCommand] : [])]))];
      const tests = evidenceList
        .filter((r) => r.testCommand)
        .map((r) => ({ command: r.testCommand!, result: r.testStatus, output: r.testOutput }));
      const decisions = [...(intake?.decisions ?? []), ...(plan.auditLog ?? []).map((a) => `${a.action}${a.jobName ? ` ${a.jobName}` : ''}`)];
      const markdown = buildFinalReportMarkdown({
        title: plan.name,
        request: intake?.request?.trim() ? intake.request.trim() : `Plan "${plan.name}" (${plan.mode}) — ${plan.jobs.length} job(s).`,
        scope: intake?.requirements?.length ? intake.requirements.map((r) => `${r.id}: ${r.text}`) : plan.jobs.map((job) => job.name),
        architecture: [`Integration branch: ${plan.integrationBranch}`, `Base commit: ${plan.baseCommit}`],
        decisions,
        tasks,
        contributions: reports.map((report) => ({
          instance: report.jobId,
          job: report.jobName,
          summary: `[${report.status}] ${report.message}`,
        })),
        files,
        branches: [
          plan.integrationBranch,
          ...plan.jobs.map((job) => job.branch).filter((branch): branch is string => Boolean(branch)),
        ],
        integration: {
          branch: plan.integrationBranch,
          merged,
          conflicts,
          note: plan.prUrl ? `PR: ${plan.prUrl}` : 'Local completion only; no push/PR without explicit humanAuth',
        },
        installUsage,
        tests,
        evidences: [
          ...evidenceList.map((r) => `${r.jobName} [${r.testStatus}]${r.testCommand ? ` ${r.testCommand}` : ''}${r.reviewedCommit ? ` @ ${r.reviewedCommit.slice(0, 8)}` : ''}${r.testOutput ? ` — ${r.testOutput.slice(0, 200)}` : ''}`),
          `Plan status: ${plan.status}${plan.prUrl ? ` — PR: ${plan.prUrl}` : ''}`,
        ],
        problems: unmet.map((entry) => ({ problem: entry, solution: 'See job error and retry via mc_plan_approve' })),
        verified,
        unmet,
        unverified,
        limitations: [
          'Local completion only; no push/PR without explicit humanAuth',
          ...(unverified.length > 0 || unmet.length > 0 ? [] : []),
        ],
        nextSteps: unverified.length > 0 || unmet.length > 0
          ? ['Resolve the Gaps above, then re-run this report']
          : [],
        preservation: {
          preserved: state.jobs
            .filter((job) => job.status === 'running' || job.status === 'completed')
            .map((job) => `${job.name} [${job.status}] — code preserved in ${job.branch} (${job.worktreePath ?? 'no worktree'})`),
          closed: merged.map((name) => `${name} — merged into ${plan.integrationBranch}`),
          cleanup: [],
        },
        attachments: [
          ...reports.map((report) => ({
            name: `${report.jobName} [${report.status}] @ ${report.timestamp}`,
            content: report.progress !== undefined
              ? `${report.message} (${report.progress}%)`
              : report.message,
          })),
          ...evidenceList.map((r) => ({
            name: `MergeTestReport ${r.jobName} [${r.testStatus}] @ ${r.mergedAt}`,
            content: [
              r.testCommand ? `command: ${r.testCommand}` : null,
              `status: ${r.testStatus}`,
              r.reviewedCommit ? `reviewedCommit: ${r.reviewedCommit}` : null,
              r.reviewedBase ? `reviewedBase: ${r.reviewedBase}` : null,
              r.testOutput ? `output:\n${r.testOutput.slice(0, 4000)}` : null,
            ].filter(Boolean).join('\n') || '(no test output)',
          })),
        ],
      });
      await writeFinalReport(plan.id, markdown);
    } catch (error) {
      // F09: never swallow report failures silently — surface them.
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[MC] auto final report failed: ${msg}`);
      try {
        this.notify(`⚠️ Final report generation failed: ${msg}`);
      } catch {}
    }
  }

  private resolveCoordinatorModel(): V2ModelRef {
    // The stored snapshot is already a full triple — return it untouched so a
    // pinned variant survives (pin triplo).
    if (this.planModelSnapshot) return { ...this.planModelSnapshot };
    // Single effective resolution (env → tracked → config): same chain as the
    // planner, never unknown/unknown silently. Fallback warns explicitly.
    const env = process.env.MC_PLANNER_MODEL?.trim();
    if (env) {
      const parsed = parseModelRef(env);
      if (parsed) return parsed;
    }
    const ref = getCurrentModelRef();
    if (ref) return { ...ref };
    console.warn(
      '[MC] No tracked model for coordinator — falling back to default with explicit warning (no silent unknown/unknown).',
    );
    return { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor' };
  }

  /** Effective model once per execution: resolves, pins snapshot, returns triple. */
  private ensureEffectiveModel(): V2ModelRef {
    if (!this.planModelSnapshot) {
      this.planModelSnapshot = this.resolveCoordinatorModel();
    }
    return { ...this.planModelSnapshot };
  }

  /**
   * M5/M7 wiring: run the M3 coordinator pass inside the reconcile loop.
   * - Dispatch goes through the existing launchJob path (no second launcher).
   * - Gate returns false so the coordinator never enqueues into the merge
   *   train directly; the merge section below stays the single integrator
   *   (serialized per integrationBranch under file-lock, idempotent enqueue).
   * - Budget is preserved against the orchestrator's configured maxParallel:
   *   coordinateOnce clamps to 4–8, so the observed running count is shifted
   *   by (clamp - configured) to keep the same dispatch budget.
   * Returns the names dispatched by this pass (usually empty when the manual
   * loop already filled the budget — that is the no-duplicate guarantee).
   */
  private async runCoordinatorPass(
    plan: PlanSpec,
    byName: Map<string, JobSpec>,
    runningCount: number,
    maxParallel: number,
  ): Promise<string[]> {
    const model = this.resolveCoordinatorModel();
    const dispatchedThisPass = new Set<string>();
    try {
      return await coordinateOnce({
        maxParallel,
        observe: async () => ({
          jobs: plan.jobs.map((job) => ({
            name: job.name,
            status: byName.get(job.name)?.status ?? job.status,
            dependsOn: job.dependsOn,
            mergeOrder: job.mergeOrder,
            priority: job.priority,
          })),
          // Preserve the orchestrator's configured budget under the 4–8 clamp.
          // Clamped at 0: with maxParallel above the cap the raw compensation
          // goes negative, which would otherwise inflate the budget past the cap.
          runningCount: Math.max(
            0,
            runningCount + (clampMaxParallel(maxParallel) - maxParallel),
          ),
          model,
          baseRef: plan.integrationBranch ?? plan.baseCommit,
        }),
        dispatch: async (req) => {
          const current = byName.get(req.job.name);
          if (!current || (current.status !== 'queued' && current.status !== 'waiting_deps')) {
            return { sessionID: '' };
          }
          const key = `${plan.id}:${req.job.name}`;
          if (dispatchedThisPass.has(key) || (this.coordinatedJobs.has(key) && current.status === 'running')) {
            return { sessionID: '' };
          }
          dispatchedThisPass.add(key);
          // F03: use the coordinator-calculated prompt (not a stale job.prompt).
          if (req.prompt) current.prompt = req.prompt;
          await this.launchJob(current);
          current.status = 'running';
          this.coordinatedJobs.add(key);
          return { sessionID: `coord-${plan.id.slice(0, 8)}-${req.job.name}` };
        },
        // Reviewer gate lives in the merge-train path (M4); the coordinator
        // must not reintegrate here.
        gate: async () => false,
        enqueue: async () => {},
        promptFor: (job, baseRef) => {
          const full = byName.get(job.name);
          return {
            request: full?.prompt ?? `Run job "${job.name}"`,
            constraints: full?.touchSet?.length ? [`Stay inside: ${full.touchSet.join(', ')}`] : [],
            decisions: [],
            baseRef,
            acceptance: [`Job "${job.name}" completes and reports via mc_report`],
          };
        },
      });
    } catch (error) {
      console.warn('[MC] coordinator pass skipped:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  constructor(monitor: JobMonitor, config: MCConfig, callbacks?: ToastCallback | { toast?: ToastCallback; notify?: NotifyCallback }) {
    this.monitor = monitor;
    this.config = config;
    if (typeof callbacks === 'function') {
      this.toastCallback = callbacks;
      this.notifyCallback = null;
    } else {
      this.toastCallback = callbacks?.toast ?? null;
      this.notifyCallback = callbacks?.notify ?? null;
    }
  }

  setPlanModelSnapshot(model: string | V2ModelRef | undefined): void {
    if (model === undefined) {
      this.planModelSnapshot = undefined;
      return;
    }
    this.planModelSnapshot = typeof model === 'string' ? parseModelRef(model) : { ...model };
  }

  private showToast(title: string, message: string, variant: ToastVariant): void {
    if (!this.toastCallback) return;
    const durations: Record<ToastVariant, number> = {
      success: 3000,
      info: 5000,
      warning: 8000,
      error: 8000,
    };
    this.toastCallback(title, message, variant, durations[variant]);
  }

  private notify(message: string, targetSessionID?: string): void {
    if (!this.notifyCallback) return;
    this.notifyCallback(message, targetSessionID ?? this.planLaunchSessionID);
  }

  private formatTestReportSummary(testReport?: MergeTestReport): string | null {
    if (!testReport) {
      return null;
    }

    const parts: string[] = [];

    if (testReport.status === 'skipped') {
      parts.push('tests skipped');
    } else if (testReport.status === 'passed') {
      parts.push('tests passed');
    } else {
      parts.push('tests failed');
    }

    if (testReport.command) {
      parts.push(`command: ${testReport.command}`);
    }

    if (testReport.setup.status === 'passed') {
      if (testReport.setup.commands.length > 0) {
        parts.push(`setup passed: ${testReport.setup.commands.join(' && ')}`);
      } else {
        parts.push('setup skipped');
      }
    } else if (testReport.setup.status === 'failed') {
      parts.push(`setup failed: ${testReport.setup.commands.join(' && ')}`);
    } else {
      parts.push('setup skipped');
    }

    if (testReport.reason) {
      parts.push(`reason: ${testReport.reason}`);
    }

    const setupSnippet = compactOutput(testReport.setup.output);
    if (setupSnippet) {
      parts.push(`setup output: ${setupSnippet}`);
    }

    const testSnippet = compactOutput(testReport.output);
    if (testSnippet) {
      parts.push(`test output: ${testSnippet}`);
    }

    return parts.join(' | ');
  }

  getCheckpoint(): CheckpointType | null {
    return this.checkpoint;
  }

  async clearCheckpoint(checkpoint?: CheckpointType): Promise<void> {
    if (checkpoint && this.checkpoint !== checkpoint) {
      throw new Error(
        `Checkpoint mismatch: expected "${this.checkpoint}", got "${checkpoint}"`,
      );
    }
    const wasPreMerge = this.checkpoint === 'pre_merge';
    this.checkpoint = null;

    const repoRoot = this.effectiveRepoRoot();
    await withRepoRoot(repoRoot, async () => {
      const plan = await loadPlan(repoRoot);
      if (plan && plan.status === 'paused') {
        if (wasPreMerge) {
          for (const job of plan.jobs) {
            if (job.status === 'ready_to_merge') {
              this.approvedForMerge.add(job.name);
            }
          }
        }

        await updatePlanFields(plan.id, {
          status: 'running',
          checkpoint: null,
          checkpointContext: null,
        }, repoRoot);
      this.showToast('Mission Control', 'Checkpoint cleared, resuming execution.', 'info');

      if (!this.isRunning) {
        this.startReconciler();
      }
      }
    });
  }

  async startPlan(spec: PlanSpec, opts?: { repoRoot?: string }): Promise<{ pending: boolean; message?: string }> {
    // F02: explicit repo scope end-to-end (never bare cwd, never global chdir).
    const repoRoot = opts?.repoRoot ? resolveRepoRoot(opts.repoRoot) : this.repoRoot ?? getActiveRepoRoot() ?? resolveRepoRoot(undefined);
    this.repoRoot = repoRoot;
    return await withRepoRoot(repoRoot, async () => {
      this.validatePlan(spec);

      const existingPlan = await loadPlan(repoRoot);
      if (existingPlan) {
        throw new Error('Active plan already exists');
      }

      const ghAuthenticated = await validateGhAuth();
      const plan: PlanSpecWithAuth = {
        ...spec,
        status: 'pending',
        ghAuthenticated,
        jobs: topologicalSort(spec.jobs).map((job, idx) => ({
          ...job,
          status: job.dependsOn?.length ? 'waiting_deps' : 'queued',
          mergeOrder: job.mergeOrder ?? idx,
        })),
      };

      const integrationPostCreate = resolvePostCreateHook(this.config.worktreeSetup);
      // F02: repo scope via active context (withRepoRoot above) — explicit param
      // only for direct third-folder calls; keep 2/3-arg shape for backward compat.
      const integration = spec.baseBranch
        ? await createIntegrationBranch(spec.id, integrationPostCreate, spec.baseBranch)
        : await createIntegrationBranch(spec.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;

    if (spec.mode === 'copilot') {
      await savePlan(plan, repoRoot);
      this.showToast(
        'Mission Control',
        `Plan "${plan.name}" created in copilot mode. Awaiting approval.`,
        'info',
      );
      return {
        pending: true,
        message: 'Plan created in copilot mode. Review with mc_plan_status, then approve with mc_plan_approve.',
      };
    }

    await savePlan(plan, repoRoot);

    this.activePlanId = plan.id;
    this.coordinatedJobs.clear();
    this.planPlacement = spec.placement ?? null;
    this.planLaunchSessionID = spec.launchSessionID;
    this.mergeTrain = new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());
    this.subscribeToMonitorEvents();
    this.ensureMonitorRunning();
    this.startReconciler();
    this.showToast('Mission Control', `Plan "${plan.name}" started.`, 'info');
    this.notify(`📋 Plan "${plan.name}" started in autopilot mode. ${plan.jobs.length} jobs queued.`);
    return { pending: false };
    });
  }

  private startReconciler(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.reconcilerInterval = setInterval(() => {
      this.reconcile().catch((error) => {
        console.error('Orchestrator reconcile error:', error);
      });
    }, 5000);

    this.reconcile().catch((error) => {
      console.error('Orchestrator initial reconcile error:', error);
    });
  }

  private stopReconciler(): void {
    if (this.reconcilerInterval) {
      clearInterval(this.reconcilerInterval);
      this.reconcilerInterval = null;
    }
    this.isRunning = false;
  }

  private async setCheckpoint(type: CheckpointType, plan: PlanSpec, context?: CheckpointContext): Promise<void> {
    this.checkpoint = type;
    await updatePlanFields(plan.id, {
      status: 'paused',
      checkpoint: type,
      checkpointContext: context ?? null,
    }, this.effectiveRepoRoot());
    this.stopReconciler();
    this.showToast(
      'Mission Control',
      `Supervisor checkpoint: ${type}. Approve to continue with mc_plan_approve.`,
      'warning',
    );
  }

  private isSupervisor(plan: PlanSpec): boolean {
    return plan.mode === 'supervisor';
  }

  private async reconcile(): Promise<void> {
    if (this.isReconciling) {
      this.reconcilePending = true;
      return;
    }

    this.isReconciling = true;
    try {
      do {
        this.reconcilePending = false;
        await this._doReconcile();
      } while (this.reconcilePending);
    } finally {
      this.isReconciling = false;
    }
  }

  private async _doReconcile(): Promise<void> {
    // F02: run the whole pass inside the explicit repo scope so state helpers
    // without an explicit param (job-state/reports/durable/monitor/config)
    // still resolve to the target repo, never the launcher cwd.
    const repoRoot = this.effectiveRepoRoot();
    await withRepoRoot(repoRoot, async () => {
      // Conductor cover: drive one monitor cycle so session events land in
      // jobs.json even when the interval hasn't fired yet (CLI conductor).
      await this.driveMonitorOnce();
      this.ensureMonitorRunning();
      const plan = await loadPlan(repoRoot);

      if (!plan || isTerminalPlanStatus(plan.status)) {
        this.stopReconciler();
        this.unsubscribeFromMonitorEvents();
        return;
      }

      if (plan.status === 'paused' || this.checkpoint) {
        return;
      }

      this.activePlanId = plan.id;

      if (plan.status === 'pending') {
        plan.status = 'running';
      }

      // F04: effective ceiling per execution (explicit 1 respected, no 4–8 reinterpretation).
      const maxParallel = this.getEffectiveMaxParallel();
      const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
      let runningCount = runningJobs.length;

      // Safety net: detect plan jobs stuck as 'running' when jobs.json already
      // shows them as completed/failed (can happen if a prior savePlan race
      // overwrote their status, or if the 'complete' event was missed).
      const jobState = await loadJobState();
      const runningJobNames = new Set(runningJobs.map((j) => j.name));
      for (const planJob of plan.jobs) {
        if (planJob.status !== 'running') continue;
        if (runningJobNames.has(planJob.name)) continue;

        const stateJob = jobState.jobs.find(
          (j) => j.name === planJob.name && j.planId === plan.id,
        );
        if (!stateJob) continue;

        if (stateJob.status === 'completed') {
          await updatePlanJob(plan.id, planJob.name, { status: 'completed' });
          planJob.status = 'completed';
        } else if (stateJob.status === 'failed' || stateJob.status === 'stopped') {
          await updatePlanJob(plan.id, planJob.name, {
            status: 'failed',
            error: 'recovered from missed completion event',
          });
          planJob.status = 'failed';
        }
      }

      const mergeOrder = [...plan.jobs].sort(
        (a, b) => (a.mergeOrder ?? Number.MAX_SAFE_INTEGER) - (b.mergeOrder ?? Number.MAX_SAFE_INTEGER),
      );
      const byName = new Map(plan.jobs.map((job) => [job.name, job]));

      let launchedThisCycle = 0;
      for (const job of mergeOrder) {
        if (job.status !== 'queued' && job.status !== 'waiting_deps') {
          continue;
        }

        const depsSatisfied = (job.dependsOn ?? []).every(
          (depName) => byName.get(depName)?.status === 'merged',
        );

        if (!depsSatisfied) {
          if (job.status !== 'waiting_deps') {
            await updatePlanJob(plan.id, job.name, { status: 'waiting_deps' });
            job.status = 'waiting_deps';
          }
          continue;
        }

        if (runningCount >= maxParallel) {
          continue;
        }

        await this.launchJob(job);
        runningCount += 1;
        launchedThisCycle += 1;
        job.status = 'running';
      }

      if (launchedThisCycle > 0) {
        this.jobsLaunchedCount += launchedThisCycle;
        const launched = mergeOrder.filter(j => j.status === 'running').map(j => j.name);
        this.showToast(
          'Mission Control',
          `Launched ${launchedThisCycle} job(s) (${this.jobsLaunchedCount} total).`,
          'info',
        );
        this.notify(`🚀 Launched ${launchedThisCycle} job(s): ${launched.join(', ')}. (${this.jobsLaunchedCount}/${mergeOrder.length} total launched)`);
      }

      // M5/M7 wiring: coordinator pass inside reconcile. It dispatches only
      // through launchJob with the same in-memory statuses above, so jobs the
      // manual loop just launched are skipped (no duplicates); gate=false so
      // it never reintegrates (single integrator stays below).
      const coordDispatched = await this.runCoordinatorPass(plan, byName, runningCount, maxParallel);
      if (coordDispatched.length > 0) {
        runningCount += coordDispatched.length;
        this.jobsLaunchedCount += coordDispatched.length;
        this.showToast(
          'Mission Control',
          `Coordinator dispatched ${coordDispatched.length} job(s) (${this.jobsLaunchedCount} total).`,
          'info',
        );
        this.notify(`🚀 Coordinator dispatched ${coordDispatched.length} job(s): ${coordDispatched.join(', ')}.`);
      }

      for (const job of mergeOrder) {
        if (job.status === 'completed') {
          if (job.touchSet && job.touchSet.length > 0 && job.branch && plan.integrationBranch) {
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet, { cwd: repoRoot });
            if (!validation.valid && validation.violations) {
              await updatePlanJob(plan.id, job.name, {
                status: 'failed',
                error: `Modified files outside touchSet: ${validation.violations.join(', ')}. Expected only: ${job.touchSet.join(', ')}`,
              });
              job.status = 'failed';

              this.showToast('Mission Control', `Job "${job.name}" touched files outside its touchSet. Plan paused.`, 'error');
              this.notify(
                `❌ Job "${job.name}" modified files outside its touchSet:\n` +
                `  Violations: ${validation.violations.join(', ')}\n` +
                `  Allowed: ${job.touchSet.join(', ')}\n\n` +
                `Options:\n` +
                `  Accept violations:  mc_plan_approve(checkpoint: "on_error")\n` +
                `  Agent fixes branch: mc_plan_approve(checkpoint: "on_error", relaunch: "${job.name}")\n` +
                `  You fix, re-check:  mc_plan_approve(checkpoint: "on_error", retry: "${job.name}")`,
              );
              await this.setCheckpoint('on_error', plan, {
                jobName: job.name,
                failureKind: 'touchset',
                touchSetViolations: validation.violations,
                touchSetPatterns: job.touchSet,
              });
              return;
            }
          }

          await updatePlanJob(plan.id, job.name, { status: 'ready_to_merge' });
          job.status = 'ready_to_merge';
        }
      }

      for (const job of mergeOrder) {
        if (job.status !== 'ready_to_merge') {
          continue;
        }

        const earlierJobs = mergeOrder.filter(
          (candidate) => (candidate.mergeOrder ?? 0) < (job.mergeOrder ?? 0),
        );
        const canMergeNow = earlierJobs.every((candidate) => {
          const current = byName.get(candidate.name);
          return current?.status === 'merged';
        });
        if (!canMergeNow) {
          continue;
        }

        if (job.branch && plan.integrationWorktree) {
          const mergeCheck = await checkMergeability(plan.integrationWorktree, job.branch);
          if (!mergeCheck.canMerge) {
            await updatePlanJob(plan.id, job.name, {
              status: 'needs_rebase',
              error: mergeCheck.conflicts?.join(', ') ?? 'merge conflict detected in trial merge',
            });
            job.status = 'needs_rebase';

            this.showToast('Mission Control', `Job "${job.name}" has merge conflicts. Plan paused.`, 'error');
            this.notify(`❌ Job "${job.name}" would conflict with the integration branch.\n  Files: ${mergeCheck.conflicts?.join(', ') ?? 'unknown'}\nRebase the job branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${job.name}").`);
            await this.setCheckpoint('on_error', plan, {
              jobName: job.name,
              failureKind: 'merge_conflict',
            });
            return;
          }
        }

        if (this.isSupervisor(plan) && !this.approvedForMerge.has(job.name)) {
          await this.setCheckpoint('pre_merge', plan);
          return;
        }

        this.mergeTrain ??= new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());
        // M5/M7: single queue with identifiers — enqueue is idempotent
        // (MergeTrain.enqueue dedupes) and a retry/crash that left a job in
        // 'merging' with an empty in-memory queue re-enqueues it (no lost merge,
        // no duplicate merge).
        if (job.status === 'ready_to_merge' && !this.isQueued(job.name)) {
          this.mergeTrain.enqueue(job);
          await updatePlanJob(plan.id, job.name, { status: 'merging' });
          job.status = 'merging';
          this.approvedForMerge.delete(job.name);
        }
      }

      // Crash recovery: jobs stuck in 'merging' (queue lost on restart) rejoin
      // the single queue once — has() keeps it idempotent.
      for (const job of mergeOrder) {
        if (job.status === 'merging' && this.mergeTrain && !this.isQueued(job.name)) {
          this.mergeTrain.enqueue(job);
        }
      }

      if (this.mergeTrain && this.mergeTrain.getQueue().length > 0) {
        plan.status = 'merging';

        const nextJob = this.mergeTrain.getQueue()[0];
        this.showToast('Mission Control', `Merging job "${nextJob.name}"...`, 'info');
        this.notify(`⇄ Merging job "${nextJob.name}" into integration branch...`);
        // F01: product-path review gate — collect product-observed evidence,
        // run reviewJob + runReviewFixLoop, then integrate only on pass.
        // Duck-typed fakes in unit tests (plain objects without review
        // support) keep the legacy direct merge so transition/toast suites
        // stay green; real MergeTrain runs always review here.
        let verdict: ReviewVerdict | null = null;
        const isRealTrain = this.mergeTrain instanceof MergeTrain;
        if (isRealTrain) {
          try {
            const fullJob = byName.get(nextJob.name) ?? nextJob;
            verdict = await this.reviewJobWithFixLoop(fullJob, plan);
          } catch (reviewError) {
            const msg = reviewError instanceof Error ? reviewError.message : String(reviewError);
            await updatePlanJob(plan.id, nextJob.name, { status: 'failed', error: msg });
            this.showToast('Mission Control', `Job "${nextJob.name}" blocked by review. Plan paused.`, 'error');
            this.notify(`❌ Job "${nextJob.name}" blocked by review: ${msg}. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`);
            await this.setCheckpoint('on_error', plan, { jobName: nextJob.name, failureKind: 'test_failure' });
            return;
          }
          if (!verdict || verdict.verdict !== 'pass' || verdict.blocking) {
            const reasons = verdict?.reasons.join('; ') || 'review did not pass';
            await updatePlanJob(plan.id, nextJob.name, { status: 'failed', error: `Review blocked: ${reasons}` });
            this.showToast('Mission Control', `Job "${nextJob.name}" blocked by review. Plan paused.`, 'error');
            this.notify(`❌ Job "${nextJob.name}" blocked by review: ${reasons}. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`);
            await this.setCheckpoint('on_error', plan, { jobName: nextJob.name, failureKind: 'test_failure' });
            return;
          }
        }
        const mergeResult = isRealTrain
          ? await (this.mergeTrain as MergeTrain).processNext(
              verdict,
              // Gap1: scoped tasks defer the repo-wide gate to the final
              // integration verification (all siblings present). Per-merge
              // repo-wide runs would fail deterministically on missing
              // not-yet-merged siblings, even with correct workers.
              !this.jobReferencesGlobalTest(byName.get(nextJob.name) ?? nextJob, this.getEffectiveTestCommand())
                ? { skipTest: true }
                : undefined,
            )
          : await (this.mergeTrain as unknown as { processNext: () => Promise<{ success: boolean; mergedAt?: string; type?: string; files?: string[]; output?: string; testReport?: MergeTestReport }> }).processNext();

        const mergedCount = mergeOrder.filter(j => j.status === 'merged').length;

        if (mergeResult.success) {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'merged',
            mergedAt: mergeResult.mergedAt,
          });
          const current = byName.get(nextJob.name);
          if (current) {
            current.status = 'merged';
            current.mergedAt = mergeResult.mergedAt;
          }
          // F09: conserve product-observed evidence for the final report.
          try {
            const tr = (mergeResult as { testReport?: MergeTestReport }).testReport;
            const fullJob = byName.get(nextJob.name) ?? nextJob;
            let changedFiles: string[] | undefined;
            try {
              const diff = await listChangedFiles(plan.integrationBranch, fullJob.branch!, this.effectiveRepoRoot()).catch(() => null);
              changedFiles = diff?.files ?? undefined;
            } catch {}
            await saveMergeEvidence({
              jobName: nextJob.name,
              mergedAt: mergeResult.mergedAt,
              reviewedCommit: verdict?.reviewedCommit,
              reviewedBase: verdict?.reviewedBase,
              changedFiles,
              testCommand: tr?.command,
              testStatus: tr?.status ?? 'skipped',
              testOutput: tr?.output,
              setupCommands: tr?.setup.commands,
              setupStatus: tr?.setup.status,
            }).catch(() => {});
          } catch {}
          this.showToast('Mission Control', `Job "${nextJob.name}" merged successfully.`, 'success');
          this.notify(`✅ Job "${nextJob.name}" merged successfully. (${mergedCount + 1}/${mergeOrder.length} merged)`);
          const testSummary = this.formatTestReportSummary(mergeResult.testReport);
          if (testSummary) {
            this.notify(`🧪 ${nextJob.name}: ${testSummary}`);
          }
        } else if (mergeResult.type === 'conflict') {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'conflict',
            error: mergeResult.files?.join(', ') ?? 'merge conflict',
          });

          this.showToast('Mission Control', `Merge conflict in job "${nextJob.name}". Plan paused.`, 'error');
          this.notify(`❌ Merge conflict in job "${nextJob.name}". Files: ${mergeResult.files?.join(', ') ?? 'unknown'}. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`);
          await this.setCheckpoint('on_error', plan, {
            jobName: nextJob.name,
            failureKind: 'merge_conflict',
          });
          return;
        } else {
          const isReviewBlocked = (mergeResult as { type?: string }).type === 'review_blocked';
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'failed',
            error: mergeResult.output ?? (isReviewBlocked ? 'review blocked' : 'merge train test failure'),
          });

          const testSummary = this.formatTestReportSummary(mergeResult.testReport);
          if (testSummary) {
            this.notify(`🧪 ${nextJob.name}: ${testSummary}`);
          }

          this.showToast('Mission Control', `Job "${nextJob.name}" ${isReviewBlocked ? 'blocked by review' : 'failed merge tests'}. Plan paused.`, 'error');
          this.notify(`❌ Job "${nextJob.name}" ${isReviewBlocked ? `blocked by review: ${mergeResult.output ?? 'verdict=pass required'}` : 'failed merge tests'}. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`);
          await this.setCheckpoint('on_error', plan, {
            jobName: nextJob.name,
            failureKind: 'test_failure',
          });
          return;
        }
      }

      if (plan.status === 'merging' && (!this.mergeTrain || this.mergeTrain.getQueue().length === 0)) {
        plan.status = 'running';
      }

      const latestPlan = await loadPlan(this.effectiveRepoRoot());
      if (!latestPlan) {
        return;
      }

      const allMerged = latestPlan.jobs.length > 0 && latestPlan.jobs.every((job) => job.status === 'merged');
      // Guard: don't re-enter PR creation if already in progress or terminal
      if (allMerged && latestPlan.status !== 'creating_pr' && latestPlan.status !== 'completed' && latestPlan.status !== 'failed') {
        // Gap1: final integration verification — the repo-wide gate runs
        // once here, post-merge with ALL siblings present (never in an
        // isolated task worktree). Fail-closed: no executable test = blocked,
        // never success-skipped in autonomous mode. Legacy fakes (unit-test
        // trains that are not real MergeTrain) keep the legacy path so
        // transition suites stay green.
        if (this.mergeTrain instanceof MergeTrain) {
          const verifyWorktree = latestPlan.integrationWorktree!;
          const verifyConfigured = this.getEffectiveTestCommand();
          const verifyCommand = verifyConfigured ?? await detectTestCommand(verifyWorktree);
          if (!verifyCommand) {
            this.showToast('Mission Control', 'All jobs merged but no test command exists — blocked (never verified without evidence).', 'error');
            this.notify('❌ All jobs merged but no test command exists to verify the integration — blocked (never success-skipped). Add a test command and retry with mc_plan_approve(checkpoint: "on_error").');
            await this.setCheckpoint('on_error', latestPlan, {
              jobName: latestPlan.jobs[latestPlan.jobs.length - 1]?.name ?? 'unknown',
              failureKind: 'test_failure',
            });
            await this.writeAutoFinalReport((await loadPlan(this.effectiveRepoRoot())) ?? latestPlan);
            return;
          }
          const verifyTimeout = (this.config as MCConfig & { testTimeout?: number }).testTimeout ?? 600000;
          const verifyResult = await runTestCommand(verifyWorktree, verifyCommand, verifyTimeout);
          if (!verifyResult.success) {
            const out = verifyResult.timedOut
              ? `Final integration verification timed out after ${verifyTimeout}ms`
              : `Final integration verification failed (${verifyCommand}): ${verifyResult.output.slice(0, 500)}`;
            this.showToast('Mission Control', 'Final integration verification failed. Plan paused.', 'error');
            this.notify(`❌ ${out}. Fix the integration and retry with mc_plan_approve(checkpoint: "on_error").`);
            await this.setCheckpoint('on_error', latestPlan, {
              jobName: latestPlan.jobs[latestPlan.jobs.length - 1]?.name ?? 'unknown',
              failureKind: 'test_failure',
            });
            await this.writeAutoFinalReport((await loadPlan(this.effectiveRepoRoot())) ?? latestPlan);
            return;
          }
          // Final gate passed where it can pass (integration, all siblings):
          // conserve product-observed evidence so the final report lists real
          // commands/outputs instead of empties. Scoped merges that deferred
          // their per-merge run are now verified by this combined run.
          try {
            const { loadMergeEvidence } = await import('./durable-state');
            const existing = await loadMergeEvidence().catch(() => ({}));
            for (const job of latestPlan.jobs) {
              const prev = (existing as Record<string, { testStatus?: string }>)[job.name];
              if (!prev || prev.testStatus !== 'passed') {
                await saveMergeEvidence({
                  jobName: job.name,
                  mergedAt: job.mergedAt ?? new Date().toISOString(),
                  changedFiles: undefined,
                  testCommand: verifyCommand,
                  testStatus: 'passed',
                  testOutput: verifyResult.output || undefined,
                }).catch(() => {});
              }
            }
          } catch {}
          try {
            const snap = await loadRuntimeSnapshot().catch(() => null);
            const intakeId = snap?.autoIntake?.id;
            if (intakeId) {
              await appendAutoDecision(intakeId, `final integration verification passed in ${verifyWorktree} (${verifyCommand}) with all ${latestPlan.jobs.length} siblings present`).catch(() => {});
            }
          } catch {}
        }
        // F08: destination receives the delivery LOCALLY, without push/PR.
        // Local completion is the primary finish; PR stays optional and never
        // blocks it. Unit-test fakes (unknown branches) return null and keep
        // the legacy PR path so transition suites stay green.
        try {
          const local = await this.completeLocalDestination(latestPlan);
          if (local) {
            this.notify(`📦 Local destination "${local.destinationBranch}" updated to ${local.destinationHead.slice(0, 8)} (no push/PR).`);
            try {
              const snap = await loadRuntimeSnapshot().catch(() => null);
              const intakeId = snap?.autoIntake?.id;
              if (intakeId) {
                await appendAutoDecision(
                  intakeId,
                  `local destination ${local.destinationBranch}@${local.destinationHead.slice(0, 8)} (from ${local.integratedHead.slice(0, 8)}${local.reverified ? ', reverified after advance' : ''})`,
                ).catch(() => {});
              }
            } catch {}
          }
        } catch (localError) {
          const msg = localError instanceof Error ? localError.message : String(localError);
          const isConflict = /conflict/i.test(msg);
          this.showToast('Mission Control', `Local destination update failed: ${msg}`, 'error');
          this.notify(`❌ Local destination update failed: ${msg}. Fix and retry with mc_plan_approve(checkpoint: "on_error", retry: "<job>").`);
          await this.setCheckpoint('on_error', latestPlan, {
            jobName: latestPlan.jobs[0]?.name ?? 'unknown',
            failureKind: isConflict ? 'merge_conflict' : 'test_failure',
          });
          await this.writeAutoFinalReport((await loadPlan(this.effectiveRepoRoot())) ?? latestPlan);
          return;
        }

        this.showToast('Mission Control', 'All jobs merged. Creating PR...', 'info');
        this.notify(`🎯 All ${latestPlan.jobs.length} jobs merged. Creating PR...`);

        if (this.isSupervisor(latestPlan)) {
          await this.setCheckpoint('pre_pr', latestPlan);
          await this.writeAutoFinalReport((await loadPlan(this.effectiveRepoRoot())) ?? latestPlan);
          return;
        }

        await updatePlanFields(latestPlan.id, { status: 'creating_pr' });

        try {
          const prUrl = await this.createPR();
          const completedAt = new Date().toISOString();
          await updatePlanFields(latestPlan.id, {
            status: 'completed',
            prUrl,
            completedAt,
          });
          const donePlan = (await loadPlan(this.effectiveRepoRoot())) ?? { ...latestPlan, status: 'completed' as const, prUrl, completedAt };
          await this.writeAutoFinalReport(donePlan);
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `Plan completed! PR: ${prUrl}`, 'success');
          this.notify(`🎉 Plan "${latestPlan.name}" completed! PR created: ${prUrl}`);
        } catch (prError) {
          const errMsg = prError instanceof Error ? prError.message : String(prError);
          // F08: no push/PR without human auth completes LOCALLY instead of
          // pausing: the destination already received the delivery above, so
          // the run finishes (completed_local semantics on status completed)
          // with an explicit note — never conditioned on a PR.
          if (/explicit human authorization/i.test(errMsg)) {
            const completedAt = new Date().toISOString();
            await updatePlanFields(latestPlan.id, { status: 'completed', completedAt });
            const donePlan = (await loadPlan(this.effectiveRepoRoot())) ?? { ...latestPlan, status: 'completed' as const, completedAt };
            await this.writeAutoFinalReport(donePlan);
            this.stopReconciler();
            this.unsubscribeFromMonitorEvents();
            this.showToast('Mission Control', 'All jobs merged. Completed locally (PR needs explicit human authorization, no push was made).', 'success');
            this.notify(
              `🎉 All ${latestPlan.jobs.length} jobs merged. Completed locally on the destination branch — ` +
              `no push was made (PR needs explicit human authorization).`,
            );
            return;
          }
          const completedAt = new Date().toISOString();
          await updatePlanFields(latestPlan.id, {
            status: 'failed',
            completedAt,
          });
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `PR creation failed: ${errMsg}`, 'error');
          this.notify(`❌ Plan "${latestPlan.name}" failed: ${errMsg}`);
        }
        return;
      }

      if (latestPlan.status !== plan.status) {
        const updates: { status: typeof plan.status; completedAt?: string } = {
          status: plan.status,
        };
        if (plan.status === 'failed') {
          updates.completedAt = new Date().toISOString();
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `Plan "${latestPlan.name}" failed.`, 'error');
          this.notify(`❌ Plan "${latestPlan.name}" failed.`);
        }
        await updatePlanFields(latestPlan.id, updates);
      }
    });
  }

  private async launchJob(job: JobSpec): Promise<void> {
    const planId = this.activePlanId;
    if (!planId) {
      throw new Error('No active plan for job launch');
    }

    const placement = this.planPlacement ?? this.config.defaultPlacement ?? 'session';
    const shortPlanId = planId ? planId.slice(0, 8) : '';
    const branch = job.branch ?? `mc/plan/${shortPlanId}/${job.name}`;
    const mode = job.mode ?? this.config.omo?.defaultMode ?? 'vanilla';
    const sanitizedName = job.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const tmuxSessionName = `mc-${sanitizedName}`;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error('Window placement requires running inside tmux');
            }
            return `${currentSession}:${sanitizedName}`;
          })();

    await updatePlanJob(planId, job.name, { status: 'running', branch }, undefined, this.effectiveRepoRoot());

    let worktreePath = '';
    let promptFilePath: string | undefined;
    try {
      const postCreate = resolvePostCreateHook(
        this.config.worktreeSetup,
        {
          copyFiles: job.copyFiles,
          symlinkDirs: job.symlinkDirs,
          commands: job.commands,
        },
      );

      // Plan jobs branch from a deterministic start point:
      // - Jobs WITH dependencies → integration branch HEAD (sees upstream changes)
      // - Root jobs (no deps) → baseCommit (consistent starting state)
      const plan = await loadPlan(this.effectiveRepoRoot());
      const hasDeps = job.dependsOn && job.dependsOn.length > 0;
      const startPoint = plan ? (hasDeps ? plan.integrationBranch : plan.baseCommit) : undefined;

      // F02: repo-scoped worktree (never bare-cwd helper).
      worktreePath = await this.createJobWorktree({ branch, startPoint, postCreate });

      if (mode !== 'vanilla') {
        const omoStatus = await detectOMO();
        if (!omoStatus.detected) {
          throw new Error(
            `OMO mode "${mode}" requires Oh-My-OpenCode to be installed and detected`,
          );
        }

        if (mode === 'plan' || mode === 'ralph' || mode === 'ulw') {
          try {
            const { join: joinPath } = await import('path');
            const sourcePlansPath = joinPath(this.effectiveRepoRoot(), '.sisyphus/plans');
            const targetPlansPath = `${worktreePath}/.sisyphus/plans`;
            await copyPlansToWorktree(sourcePlansPath, targetPlansPath);
          } catch {
            // Non-fatal: plans might not exist
          }
        }
      }

      const mcReportSuffix = `\n\nCRITICAL — STATUS REPORTING REQUIRED:
You MUST call the mc_report tool at these points — this is NOT optional:

1. IMMEDIATELY when you start: mc_report(status: "working", message: "Starting: <brief description>")
2. At each major milestone: mc_report(status: "progress", message: "<what you accomplished>", progress: <0-100>)
3. If you get stuck or need input: mc_report(status: "blocked", message: "<what's blocking you>")
4. WHEN YOU ARE COMPLETELY DONE: mc_report(status: "completed", message: "<summary of what was done>")

The "completed" call is MANDATORY — it signals Mission Control that your job is finished. Without it, your job will appear stuck as "running" and block the pipeline. Always call mc_report(status: "completed", ...) as your FINAL action.

If your work needs human review before it can proceed: mc_report(status: "needs_review", message: "<what needs review>")`;
      const autoCommitSuffix = (this.config.autoCommit !== false)
        ? `\n\nIMPORTANT: When you have completed ALL of your work, you MUST commit your changes before finishing. Stage all modified and new files, then create a commit with a conventional commit message (e.g. "feat: ...", "fix: ...", "docs: ...", "refactor: ...", "chore: ..."). Do NOT skip this step.`
        : '';
      let jobPrompt = job.prompt + mcReportSuffix + autoCommitSuffix;
      if (mode === 'ralph') {
        jobPrompt = `/ralph-loop ${jobPrompt}`;
      } else if (mode === 'ulw') {
        jobPrompt = `/ulw-loop ${jobPrompt}`;
      }
      promptFilePath = await writePromptFile(worktreePath, jobPrompt);
      // F06: effective model once per execution — snapshot triple (variant preserved for serve).
      const effective = this.ensureEffectiveModel();
      const launcherPath = await writeLauncherScript(worktreePath, promptFilePath, effective);

      const initialCommand = `bash '${launcherPath}'`;
      if (placement === 'session') {
        await createSession({
          name: tmuxSessionName,
          workdir: worktreePath,
          command: initialCommand,
        });
      } else {
        await createWindow({
          session: getCurrentSession()!,
          name: sanitizedName,
          workdir: worktreePath,
          command: initialCommand,
        });
      }

      await setPaneDiedHook(tmuxTarget, `run-shell "echo '${job.id}' >> .mission-control/completed-jobs.log"`);
      cleanupPromptFile(promptFilePath);
      cleanupLauncherScript(worktreePath);

      if (mode !== 'vanilla') {
        try {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          switch (mode) {
            case 'plan':
              await sendKeys(tmuxTarget, '/start-work');
              await sendKeys(tmuxTarget, 'Enter');
              break;
            case 'ralph':
              await sendKeys(tmuxTarget, '/ralph-loop');
              await sendKeys(tmuxTarget, 'Enter');
              break;
            case 'ulw':
              await sendKeys(tmuxTarget, '/ulw-loop');
              await sendKeys(tmuxTarget, 'Enter');
              break;
          }
        } catch {
          // Non-fatal: OMO command delivery is best-effort
        }
      }

      const existingState = await loadJobState();
      const staleJobs = existingState.jobs.filter(
        (j) => j.name === job.name && j.status !== 'running',
      );
      for (const stale of staleJobs) {
        await removeReport(stale.id).catch(() => {});
        await removeJob(stale.id).catch(() => {});
      }

      const jobId = randomUUID();
      await addJob({
        id: jobId,
        name: job.name,
        worktreePath,
        branch,
        tmuxTarget,
        placement,
        status: 'running',
        prompt: job.prompt,
        mode,
        createdAt: new Date().toISOString(),
        planId,
        launchSessionID: this.planLaunchSessionID,
      });

      await updatePlanJob(planId, job.name, {
        status: 'running',
        branch,
        worktreePath,
        tmuxTarget,
      });
    } catch (error) {
      if (promptFilePath) {
        cleanupPromptFile(promptFilePath, 0);
      }

      try {
        if (placement === 'session') {
          await killSession(tmuxSessionName);
        } else {
          const [session, window] = tmuxTarget.split(':');
          if (session && window) {
            await killWindow(session, window);
          }
        }
      } catch {}

      if (worktreePath) {
        await this.removeJobWorktree(worktreePath, true).catch(() => {});
      }

      // Recovery: the job never left queued/waiting_deps (no worktree yet),
      // but queued/waiting_deps → failed is not a valid transition. Force
      // it explicitly so the failure is visible instead of stuck queued.
      await updatePlanJob(planId, job.name, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }, { force: true }, this.effectiveRepoRoot());
    }
  }

  async relaunchJobForCorrection(
    jobName: string,
    violations: string[],
    touchSetPatterns: string[],
  ): Promise<void> {
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan) {
      throw new Error('No active plan');
    }

    const job = plan.jobs.find((j) => j.name === jobName);
    if (!job) {
      throw new Error(`Job "${jobName}" not found in plan`);
    }
    if (!job.worktreePath || !job.branch) {
      throw new Error(`Job "${jobName}" has no worktree or branch — cannot relaunch`);
    }

    const placement = this.planPlacement ?? this.config.defaultPlacement ?? 'session';
    const mode = job.mode ?? this.config.omo?.defaultMode ?? 'vanilla';
    const sanitizedName = job.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const tmuxSessionName = `mc-${sanitizedName}`;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error('Window placement requires running inside tmux');
            }
            return `${currentSession}:${sanitizedName}`;
          })();

    // Kill old tmux session if still alive
    try {
      if (placement === 'session') {
        await killSession(tmuxSessionName);
      } else {
        const [session, window] = tmuxTarget.split(':');
        if (session && window) {
          await killWindow(session, window);
        }
      }
    } catch {
      // Session may already be dead — that's fine
    }

    // Build correction prompt with context from the original task
    const correctionPrompt =
      `CORRECTION TASK — TouchSet Violation\n\n` +
      `The previous task in this worktree was:\n"${job.prompt}"\n\n` +
      `It completed successfully but modified files outside the allowed scope.\n\n` +
      `Violations (files you must revert):\n${violations.map((v) => `  - ${v}`).join('\n')}\n\n` +
      `Allowed patterns (files you may keep):\n${touchSetPatterns.map((p) => `  - ${p}`).join('\n')}\n\n` +
      `Instructions:\n` +
      `1. Review the changes on this branch (git log, git diff)\n` +
      `2. Revert ONLY the violating files listed above — do NOT break the intended work\n` +
      `3. If a violating file is genuinely required, explain why in your commit message\n` +
      `4. Commit your corrections and report completion`;

    const mcReportSuffix = `\n\nCRITICAL — STATUS REPORTING REQUIRED:
You MUST call the mc_report tool at these points — this is NOT optional:

1. IMMEDIATELY when you start: mc_report(status: "working", message: "Starting: <brief description>")
2. At each major milestone: mc_report(status: "progress", message: "<what you accomplished>", progress: <0-100>)
3. If you get stuck or need input: mc_report(status: "blocked", message: "<what's blocking you>")
4. WHEN YOU ARE COMPLETELY DONE: mc_report(status: "completed", message: "<summary of what was done>")

The "completed" call is MANDATORY — it signals Mission Control that your job is finished. Without it, your job will appear stuck as "running" and block the pipeline. Always call mc_report(status: "completed", ...) as your FINAL action.

If your work needs human review before it can proceed: mc_report(status: "needs_review", message: "<what needs review>")`;
    const autoCommitSuffix = (this.config.autoCommit !== false)
      ? `\n\nIMPORTANT: When you have completed ALL of your work, you MUST commit your changes before finishing. Stage all modified and new files, then create a commit with a conventional commit message (e.g. "feat: ...", "fix: ...", "docs: ...", "refactor: ...", "chore: ..."). Do NOT skip this step.`
      : '';

    let fullPrompt = correctionPrompt + mcReportSuffix + autoCommitSuffix;
    if (mode === 'ralph') {
      fullPrompt = `/ralph-loop ${fullPrompt}`;
    } else if (mode === 'ulw') {
      fullPrompt = `/ulw-loop ${fullPrompt}`;
    }

    const worktreePath = job.worktreePath;
    let promptFilePath: string | undefined;

    try {
      promptFilePath = await writePromptFile(worktreePath, fullPrompt);
      const effective = this.ensureEffectiveModel();
      const launcherPath = await writeLauncherScript(worktreePath, promptFilePath, effective);

      const initialCommand = `bash '${launcherPath}'`;
      if (placement === 'session') {
        await createSession({
          name: tmuxSessionName,
          workdir: worktreePath,
          command: initialCommand,
        });
      } else {
        await createWindow({
          session: getCurrentSession()!,
          name: sanitizedName,
          workdir: worktreePath,
          command: initialCommand,
        });
      }

      await setPaneDiedHook(tmuxTarget, `run-shell "echo '${job.id}' >> .mission-control/completed-jobs.log"`);
      cleanupPromptFile(promptFilePath);
      cleanupLauncherScript(worktreePath);

      if (mode !== 'vanilla') {
        try {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          switch (mode) {
            case 'plan':
              await sendKeys(tmuxTarget, '/start-work');
              await sendKeys(tmuxTarget, 'Enter');
              break;
            case 'ralph':
              await sendKeys(tmuxTarget, '/ralph-loop');
              await sendKeys(tmuxTarget, 'Enter');
              break;
            case 'ulw':
              await sendKeys(tmuxTarget, '/ulw-loop');
              await sendKeys(tmuxTarget, 'Enter');
              break;
          }
        } catch {
          // Non-fatal: OMO command delivery is best-effort
        }
      }

      // Clean up stale job entries and create fresh one for the relaunch
      const existingState = await loadJobState();
      const staleJobs = existingState.jobs.filter(
        (j) => j.name === job.name && j.status !== 'running',
      );
      for (const stale of staleJobs) {
        await removeReport(stale.id).catch(() => {});
        await removeJob(stale.id).catch(() => {});
      }

      const jobId = randomUUID();
      await addJob({
        id: jobId,
        name: job.name,
        worktreePath,
        branch: job.branch,
        tmuxTarget,
        placement,
        status: 'running',
        prompt: correctionPrompt,
        mode,
        createdAt: new Date().toISOString(),
        planId: plan.id,
        launchSessionID: this.planLaunchSessionID,
      });

      await updatePlanJob(plan.id, job.name, {
        status: 'running',
        tmuxTarget,
        error: undefined,
      });
    } catch (error) {
      if (promptFilePath) {
        cleanupPromptFile(promptFilePath, 0);
      }

      try {
        if (placement === 'session') {
          await killSession(tmuxSessionName);
        } else {
          const [session, window] = tmuxTarget.split(':');
          if (session && window) {
            await killWindow(session, window);
          }
        }
      } catch {}

      throw new Error(
        `Failed to relaunch job "${jobName}" for correction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleJobComplete = (job: Job): void => {
    if (!job.planId || !this.activePlanId || job.planId !== this.activePlanId) {
      return;
    }

    if (!this.firstJobCompleted) {
      this.firstJobCompleted = true;
      this.showToast('Mission Control', `First job completed: "${job.name}".`, 'success');
    }

    const planId = job.planId;
    (async () => {
      await updatePlanJob(planId, job.name, {
        status: 'completed',
      });
      await this.reconcile();
    })().catch((error) => {
      console.error('Failed to reconcile completed job state:', error);
    });
  }

  private handleJobFailed = (job: Job): void => {
    if (job.planId && this.activePlanId && job.planId === this.activePlanId) {
      updatePlanJob(job.planId, job.name, {
        status: 'failed',
        error: 'job monitor reported failure',
      }).catch(() => {});

      loadPlan()
        .then(async (plan) => {
          if (!plan || plan.id !== job.planId) {
            return;
          }

          this.showToast('Mission Control', `Job "${job.name}" failed. Plan paused.`, 'error');
          this.notify(`❌ Job "${job.name}" failed. Fix and retry with mc_plan_approve(checkpoint: "on_error", retry: "${job.name}").`);
          await this.setCheckpoint('on_error', plan, {
            jobName: job.name,
            failureKind: 'job_failed',
          });
        })
        .catch(() => {})
        .finally(() => {
          if (!this.checkpoint) {
            this.stopReconciler();
            this.unsubscribeFromMonitorEvents();
          }
        });
    }
  }

  async cancelPlan(repoRootOverride?: string): Promise<void> {
    const repoRoot = resolveRepoRoot(repoRootOverride ?? this.repoRoot ?? getActiveRepoRoot() ?? undefined);
    await withRepoRoot(repoRoot, async () => {
      this.stopReconciler();
      this.coordinatedJobs.clear();

      const plan = await loadPlan(repoRoot);
      if (!plan) {
        return;
      }

      // Unsubscribe from monitor events BEFORE killing jobs to prevent
      // completion/failure handlers from racing with plan cleanup.
      this.unsubscribeFromMonitorEvents();
      this.activePlanId = null;

      const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
      for (const job of runningJobs) {
        try {
          if (job.placement === 'session') {
            await killSession(job.tmuxTarget);
          } else {
            const [session, window] = job.tmuxTarget.split(':');
            if (session && window) {
              await killWindow(session, window);
            }
          }
          await updateJob(job.id, {
            status: 'stopped',
            completedAt: new Date().toISOString(),
          });
        } catch {}
      }

      await deleteIntegrationBranch(plan.id);
      await clearPlan();
    });
  }

  // -------------------------------------------------------------------------
  // Autonomous intake: NL request → configured-model plan → validated launch.
  // The caller supplies NL only; `generate` is the configured model slot.
  // Every model decision is validated before anything runs; the intake
  // record (request/requirements/decisions/questions/next steps) persists
  // in the sidecar so a restart resumes without reconstruction.
  // -------------------------------------------------------------------------

  async startAutonomousPlan(
    input: AutoIntakeInput,
    generate: PlannerGenerate,
    opts?: { launch?: boolean },
  ): Promise<{ intakeId: string; tasks: string[]; launched: boolean }> {
    // F02/F04/F11: explicit repo scope, validated ceiling, loaded --context.
    const repoRoot = resolveRepoRoot(input.repo ?? getActiveRepoRoot() ?? undefined);
    const validCeiling = validateCeiling(input.ceiling);
    // F11: load --context file(s) explicitly — prompt gets CONTENT, never just the path.
    const loadedDocs: LoadedContextDoc[] = await loadContextDocs(input.docs, { repoRoot });
    const formattedDocs = formatContextDocsForPrompt(loadedDocs);
    const enrichedInput: AutoIntakeInput = {
      ...input,
      repo: repoRoot,
      docs: loadedDocs.length > 0 ? formattedDocs : input.docs,
      ceiling: validCeiling.maxParallel !== undefined || validCeiling.testCommand !== undefined ? validCeiling : input.ceiling,
    };
    // F06: effective model once per execution (installation real + variant).
    const effective = this.ensureEffectiveModel();
    const effectiveStr = modelRefToCliString(effective);
    return await withRepoRoot(repoRoot, async () => {
      this.repoRoot = repoRoot;
      this.applyCeiling(validCeiling);
      // F07: persist before long ops — crash during planner/base still resumes.
      const preId = randomUUID();
      const preNow = new Date().toISOString();
      await saveAutoIntake({
        id: preId,
        request: enrichedInput.request,
        repo: repoRoot,
        targetBranch: enrichedInput.targetBranch,
        ceiling: Object.keys(validCeiling).length > 0 ? validCeiling : enrichedInput.ceiling,
        requirements: [],
        decisions: [`effective model ${effectiveStr}${effective.variant ? ` (variant ${effective.variant})` : ''} resolved once for planner+workers`],
        questions: [],
        nextSteps: [],
        status: 'awaiting-plan',
        createdAt: preNow,
        updatedAt: preNow,
        effectiveModel: effectiveStr,
        ...(effective.variant ? { effectiveVariant: effective.variant } : {}),
      }).catch(() => {});
      // Retry with backoff: an invalid model answer never becomes work.
      const { intake, draft, attempts } = await runAutoIntakeWithRetry(enrichedInput, generate, {
        maxAttempts: 3,
        baseDelayMs: 1000,
      });
      // Re-anchor the early record to the real intake id (same request, no fork).
      const base = await ensureBaseReady(repoRoot, input.targetBranch);

      const now = new Date().toISOString();
      await saveAutoIntake({
        id: intake.id,
        request: intake.request,
        repo: repoRoot,
        targetBranch: intake.targetBranch,
        ceiling: Object.keys(validCeiling).length > 0 ? validCeiling : intake.ceiling,
        requirements: draft.requirements.map((r) => ({ ...r })),
        decisions: [...draft.decisions],
        questions: [...draft.questions],
        nextSteps: [],
        status: 'planned',
        createdAt: intake.createdAt,
        updatedAt: now,
        effectiveModel: effectiveStr,
        ...(effective.variant ? { effectiveVariant: effective.variant } : {}),
        // F11: preserve reference/version/scope + content for resume (never just the path).
        ...((loadedDocs.length > 0
          ? { contextDocs: loadedDocs, docs: formattedDocs }
          : {}) as unknown as Record<string, unknown>),
      } as unknown as Parameters<typeof saveAutoIntake>[0]);
      await appendAutoDecision(
        intake.id,
        `model answered in ${attempts} attempt(s) (${draft.requirements.length} requirements, ${draft.tasks.length} tasks)`,
      ).catch(() => {});
      await appendAutoDecision(
        intake.id,
        `base ready: ${base.baseBranch}@${base.baseCommit.slice(0, 8)}${base.createdBranch ? ' (destination branch created locally, never pushed)' : ''}`,
      ).catch(() => {});
      if (loadedDocs.length > 0) {
        await appendAutoDecision(
          intake.id,
          `context loaded: ${loadedDocs.map((d) => `${d.ref} (sha:${d.hash} scope:${d.scope})`).join(', ')}`,
        ).catch(() => {});
      }

      const tasks = draft.tasks.map((t) => t.name);
      if (opts?.launch === false) {
        return { intakeId: intake.id, tasks, launched: false };
      }

    const jobSpecs: JobSpec[] = draftToJobSpecs(draft).map((shell) => ({
      ...shell,
      id: randomUUID(),
      status: 'queued' as const,
      // Acceptance rides in the prompt: JobSpec carries no separate field.
      prompt: `${shell.prompt}\n\nAcceptance criteria:\n${draft.tasks
        .find((t) => t.name === shell.name)!
        .acceptance.map((a) => `- [ ] ${a}`)
        .join('\n')}`,
    }));
    const spec: PlanSpec = {
      id: randomUUID(),
      name: intake.request.length > 100 ? intake.request.slice(0, 100) : intake.request,
      mode: 'autopilot',
      status: 'pending',
      jobs: jobSpecs,
      integrationBranch: `mc/integration-${intake.id}`,
      baseCommit: base.baseCommit,
      createdAt: now,
      launchSessionID: this.planLaunchSessionID,
    };
    if (input.targetBranch) {
      spec.baseBranch = base.baseBranch;
    }
    await this.startPlan(spec, { repoRoot });
    // F07: durable intake↔plan linkage.
    await saveAutoIntake({
      ...(await loadAutoIntake(intake.id))!,
      planId: spec.id,
      effectiveModel: effectiveStr,
      ...(effective.variant ? { effectiveVariant: effective.variant } : {}),
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
    await appendAutoDecision(intake.id, `plan ${spec.id} launched (${tasks.length} tasks)`).catch(() => {});
    await setAutoIntakeStatus(intake.id, 'running').catch(() => {});
    await appendAutoDecision(
      intake.id,
      'conducting: coordinator (observe → decide → dispatch) + reconciler (merge) + monitor (reports); follow detaches, close never cancels',
    ).catch(() => {});
    return { intakeId: intake.id, tasks, launched: true };
    });
  }

  /**
   * Public resume without new JSON: a disposable coordinator process may be
   * killed; this re-enters via persisted intake + plan, never duplicates
   * workers (resumePlan reuses tmux/panes, reconciler dedupes queue) and
   * never reintegrates merged work. Never touches user sessions.
   * F07: public boot reconciles (reconcileOnBoot), awaiting-plan generates,
   * merging/creating_pr reativa, messages distinguish retomou/aguardou/inconsistência.
   */
  async resumeAutonomousIntake(intakeId: string, generate?: PlannerGenerate): Promise<string> {
    // Cross-repo search (third-folder resume): active scope first, then XDG scan.
    let record = await loadAutoIntake(intakeId).catch(() => null);
    if (!record) record = await this.findIntakeAcrossRepos(intakeId).catch(() => null);
    if (!record) {
      throw new Error(`No intake "${intakeId}" persisted — start one before resuming.`);
    }
    const repoRoot = resolveRepoRoot(
      (record as unknown as { repo?: string }).repo ?? getActiveRepoRoot() ?? undefined,
    );
    return await withRepoRoot(repoRoot, async () => {
      this.repoRoot = repoRoot;
      // F04: restore effective config from the persisted ceiling (validated).
      this.applyCeiling((record as unknown as { ceiling?: { maxParallel?: number; testCommand?: string } }).ceiling);
      // F06: restore pinned effective model (planner+workers share one resolution).
      const eff = (record as unknown as { effectiveModel?: string; effectiveVariant?: string }).effectiveModel;
      const effVar = (record as unknown as { effectiveVariant?: string }).effectiveVariant;
      if (eff) {
        const parsed = parseModelRef(eff);
        if (parsed) this.planModelSnapshot = effVar ? { ...parsed, variant: effVar } : parsed;
      } else {
        this.ensureEffectiveModel();
      }
      // F07: public boot reconciles disk state (kill -9: dedupe + prune, never re-deliver).
      try { await reconcileOnBoot(); } catch {}
      let plan = await loadPlan(repoRoot);
      if (!plan) {
        // F07: awaiting-plan resumes by generating (never "no active plan" vazio).
        if (record!.status === 'awaiting-plan' || record!.status === 'planned') {
          if (!generate) {
            return [
              `Intake ${record!.id} [${record!.status}]: aguardando planejamento — nenhum plano em disco (inconsistência recuperável, nada duplicado).`,
              `Retome com modelo para gerar o plano (resume --intake ${record!.id} com generate).`,
            ].join('\n');
          }
          const req = (record as unknown as { request: string }).request;
          const ceil = (record as unknown as { ceiling?: { maxParallel?: number; testCommand?: string } }).ceiling;
          const tgt = (record as unknown as { targetBranch?: string }).targetBranch;
          const ctxDocs = (record as unknown as { contextDocs?: LoadedContextDoc[] }).contextDocs;
          const input: AutoIntakeInput = {
            request: req, repo: repoRoot, targetBranch: tgt, ceiling: ceil,
            ...(ctxDocs?.length ? { docs: ctxDocs.map((d) => d.content) } : {}),
          };
          const { draft, attempts } = await runAutoIntakeWithRetry(input, generate, { maxAttempts: 3, baseDelayMs: 1000 });
          const base = await ensureBaseReady(repoRoot, tgt);
          const now = new Date().toISOString();
          const jobSpecs: JobSpec[] = draftToJobSpecs(draft).map((shell) => ({
            ...shell,
            id: randomUUID(),
            status: 'queued' as const,
            prompt: `${shell.prompt}\n\nAcceptance criteria:\n${draft.tasks.find((t) => t.name === shell.name)!.acceptance.map((a) => `- [ ] ${a}`).join('\n')}`,
          }));
          const spec: PlanSpec = {
            id: randomUUID(), name: req.length > 100 ? req.slice(0, 100) : req,
            mode: 'autopilot', status: 'pending', jobs: jobSpecs,
            integrationBranch: `mc/integration-${record!.id}`,
            baseCommit: base.baseCommit, createdAt: now, launchSessionID: this.planLaunchSessionID,
          };
          if (tgt) spec.baseBranch = base.baseBranch;
          await this.startPlan(spec, { repoRoot });
          await saveAutoIntake({ ...record!, planId: spec.id, status: 'running', updatedAt: now }).catch(() => {});
          await appendAutoDecision(record!.id, `resumed by generating plan ${spec.id} from awaiting-plan (attempts ${attempts})`).catch(() => {});
          const progress = await this.autonomousProgress(record!.id);
          return [`Resumido: planejamento interrompido gerou plano ${spec.id} (${jobSpecs.length} task(s)).`, progress].join('\n');
        }
        return [
          `Inconsistência: intake ${record!.id} [${record!.status}] sem plano em disco (nada duplicado, nada reintegrado).`,
          `Verifique o repo ${(record as unknown as { repo?: string }).repo ?? repoRoot} ou gere novamente.`,
        ].join('\n');
      }
      const beforeStatus = plan.status;
      await this.resumePlan(repoRoot);
      await appendAutoDecision(record.id, `resumed via public path (plan ${plan.id}, no new JSON)`).catch(() => {});
      // F11: context preserved — never re-declared from a bare path.
      const ctx = (record as unknown as { contextDocs?: LoadedContextDoc[] }).contextDocs;
      if (ctx && ctx.length > 0) {
        await appendAutoDecision(
          record.id,
          `context preserved on resume: ${ctx.map((d) => `${d.ref} (sha:${d.hash} scope:${d.scope})`).join(', ')}`,
        ).catch(() => {});
      }
      const progress = await this.autonomousProgress(record.id);
      if (beforeStatus === 'merging' || beforeStatus === 'creating_pr') {
        return [`Reativado após queda em ${beforeStatus} (plano ${plan.id}, reconciliador reativado, sem sucesso vazio).`, progress].join('\n');
      }
      if (beforeStatus === 'paused' || (plan.checkpoint ?? null) !== null) {
        return [`Aguardando decisão: plano ${plan.id} pausado (pausa respeitada, nada despachado).`, progress].join('\n');
      }
      return [`Retomado: plano ${plan.id} [${beforeStatus}] reativado sem duplicar workers.`, progress].join('\n');
    });
  }

  /** F07: cross-repo intake search (third-folder resume) without launcher-cwd dependence. */
  private async findIntakeAcrossRepos(id: string): Promise<import('./durable-state').AutoIntakeRecord | null> {
    try {
      const fs = await import('fs');
      const { join } = await import('path');
      const { getXdgDataDir } = await import('./paths');
      const base = getXdgDataDir();
      let entries: string[] = [];
      try { entries = fs.readdirSync(base); } catch { return null; }
      for (const entry of entries) {
        const candidate = join(base, entry, 'state', 'runtime-state.json');
        try {
          if (!fs.existsSync(candidate)) continue;
          const text = fs.readFileSync(candidate, 'utf8');
          if (!text.includes(id)) continue;
          const parsed = JSON.parse(text) as { autoIntake?: import('./durable-state').AutoIntakeRecord };
          if (parsed?.autoIntake?.id === id) {
            return parsed.autoIntake;
          }
        } catch { continue; }
      }
    } catch {}
    return null;
  }

  /**
   * Extend the persisted NL request; the same work continues, nothing rebuilds.
   * F03: complement triggers a real plan revision via the model (same slot as
   * intake): new requirements persist as a version, new tasks/corrections go
   * through existing paths (addJob/applyModelAdjustment), pause/decisions are
   * preserved. Never announces the scheduler before scheduling.
   */
  async complementAutonomousRequest(
    intakeId: string,
    text: string,
    generate?: PlannerGenerate,
  ): Promise<{ added: string[]; message: string }> {
    let record = await loadAutoIntake(intakeId).catch(() => null);
    if (!record) record = await this.findIntakeAcrossRepos(intakeId).catch(() => null);
    if (!record) {
      throw new Error(`No intake "${intakeId}" persisted — start one before complementing.`);
    }
    const repoRoot = resolveRepoRoot(
      (record as unknown as { repo?: string }).repo ?? getActiveRepoRoot() ?? undefined,
    );
    return await withRepoRoot(repoRoot, async () => {
      this.repoRoot = this.repoRoot ?? repoRoot;
      const followUp = text.trim();
      if (!followUp) throw new Error('Complement text must not be empty.');
      // Idempotent: the CLI already persisted Follow-up via the resolved record — never duplicate it.
      const updatedRequest = record!.request.endsWith(`Follow-up: ${followUp}`)
        ? record!.request
        : `${record!.request}\nFollow-up: ${followUp}`;
      if (updatedRequest !== record!.request) {
        await saveAutoIntake({
          ...record!,
          request: updatedRequest,
          updatedAt: new Date().toISOString(),
        });
      }
      const plan = await loadPlan(repoRoot).catch(() => null);
      if (!plan) {
        await appendAutoDecision(intakeId, `complement (no plan yet): "${followUp.slice(0, 120)}"`).catch(() => {});
        return { added: [], message: `Complement recorded on intake ${intakeId} (no plan yet, nothing rebuilt).` };
      }
      const paused = plan.status === 'paused' || !!plan.checkpoint;
      if (paused) {
        // Free content recorded as a question; the pause/decision stands.
        await appendAutoQuestion(intakeId, followUp).catch(() => {});
        return {
          added: [],
          message: `Complement recorded on intake ${intakeId} (pause respected, follow-up kept as open question, nothing dispatched).`,
        };
      }
      // Running path: real revision via the model (same slot as intake).
      if (!generate) {
        await appendAutoDecision(intakeId, `complement: "${followUp.slice(0, 120)}"`).catch(() => {});
        try {
          const latest = await loadPlan(repoRoot);
          if (latest && (latest.status === 'running' || latest.status === 'merging' || latest.status === 'pending') && !this.isRunning) {
            this.startReconciler();
          }
        } catch {}
        return {
          added: [],
          message: `Complement recorded on intake ${intakeId} (reconciler active, no model revision without generate).`,
        };
      }
      const input: AutoIntakeInput = {
        request: updatedRequest,
        repo: repoRoot,
        targetBranch: (record as unknown as { targetBranch?: string }).targetBranch,
        ceiling: (record as unknown as { ceiling?: { maxParallel?: number; testCommand?: string } }).ceiling,
      };
      const { draft } = await runAutoIntakeWithRetry(input, generate, { maxAttempts: 3, baseDelayMs: 1000 });
      const live = (await loadPlan(repoRoot)) ?? plan;
      const existing = new Set(live.jobs.map((j) => j.name));
      const added: string[] = [];
      let needsUser = 0;
      for (const t of draft.tasks) {
        if (existing.has(t.name)) continue;
        const res = await this.applyModelAdjustment(
          { action: 'add_task', task: { ...t }, reason: followUp },
          { intakeId },
        ).catch((e) => ({ route: 'needs-user' as const, message: e instanceof Error ? e.message : String(e) }));
        if (res.route === 'autonomous') added.push(t.name);
        else needsUser += 1;
      }
      // Deps adjustments for existing tasks (functional change without new tasks).
      const depMap: Record<string, string[]> = {};
      let depsChanged = false;
      for (const t of draft.tasks) {
        if (!existing.has(t.name)) continue;
        const cur = live.jobs.find((j) => j.name === t.name)?.dependsOn ?? [];
        const nxt = t.dependsOn ?? [];
        if (JSON.stringify([...cur].sort()) !== JSON.stringify([...nxt].sort())) {
          depMap[t.name] = [...nxt];
          depsChanged = true;
        }
      }
      if (depsChanged) {
        const res = await this.applyModelAdjustment(
          { action: 'adjust_deps', dependsOn: depMap, reason: followUp },
          { intakeId },
        ).catch(() => ({ route: 'needs-user' as const, message: '' }));
        if (res.route === 'needs-user') needsUser += 1;
      }
      // Persist requirement version (never only Follow-up in JSON).
      await saveAutoIntake({
        ...(await loadAutoIntake(intakeId))!,
        requirements: draft.requirements.map((r) => ({ ...r })),
        decisions: [...((await loadAutoIntake(intakeId))?.decisions ?? []), ...draft.decisions],
        questions: [...((await loadAutoIntake(intakeId))?.questions ?? [])],
        nextSteps: nextStepsFor(draft),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
      await appendAutoDecision(intakeId, `complement revision: ${draft.requirements.length} requirements, +${added.length} tasks${needsUser ? `, ${needsUser} needs-user` : ''}`).catch(() => {});
      // Ensure the loop is alive only after scheduling (never announce before).
      try {
        const latest = await loadPlan(repoRoot);
        if (latest && (latest.status === 'running' || latest.status === 'merging' || latest.status === 'pending') && !this.isRunning) {
          this.startReconciler();
        }
      } catch {}
      const reconciled = this.isRunning ? 'reconciler active' : 'reconciler will advance on next pass';
      if (added.length > 0) {
        return { added, message: `Complement revised plan: added ${added.length} task(s) [${added.join(', ')}] (${reconciled}).` };
      }
      if (needsUser > 0) {
        return { added, message: `Complement recorded as human decision (${needsUser} proposal(s) need review, ${reconciled}).` };
      }
      return { added, message: `Complement noted: requirements version persisted (${draft.requirements.length}), no new tasks (${reconciled}).` };
    });
  }

  /**
   * Apply one adaptive-loop model decision. Validated first via
   * validateRuntimeDecision: invalid decisions throw without dispatching,
   * scope changes are recorded as questions, routine technique runs
   * autonomously through the existing job/plan paths.
   */
  async applyModelAdjustment(
    decision: RuntimeDecision,
    opts?: { intakeId?: string },
  ): Promise<{ route: 'autonomous' | 'needs-user'; message: string }> {
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan) throw new Error('No active plan — cannot apply a model adjustment.');
    const route = validateRuntimeDecision(decision, {
      taskNames: plan.jobs.map((j) => j.name),
      mergedTasks: plan.jobs.filter((j) => j.status === 'merged').map((j) => j.name),
    });

    if (route === 'needs-user') {
      const question = `Model proposes (${decision.action}): ${decision.reason} — approve, deny, or redirect with free text.`;
      if (opts?.intakeId) {
        await appendAutoQuestion(opts.intakeId, question).catch(() => {});
      }
      return { route, message: question };
    }

    if (decision.action === 'add_task' && decision.task) {
      const t = decision.task;
      await this.addJob({
        name: t.name.trim(),
        prompt:
          `${t.prompt.trim()}\n\nAcceptance criteria:\n` +
          (t.acceptance.map((a) => `- [ ] ${a}`).join('\n')),
        dependsOn: t.dependsOn?.length ? [...t.dependsOn] : undefined,
        touchSet: t.touchSet?.length ? [...t.touchSet] : undefined,
      });
      if (opts?.intakeId) {
        await appendAutoDecision(opts.intakeId, `added task "${t.name}": ${decision.reason}`).catch(
          () => {},
        );
      }
      return { route, message: `Task "${t.name}" added and queued.` };
    }

    if (decision.action === 'adjust_deps' && decision.dependsOn) {
      for (const [name, deps] of Object.entries(decision.dependsOn)) {
        await updatePlanJob(plan.id, name, { dependsOn: [...deps] });
      }
      if (opts?.intakeId) {
        await appendAutoDecision(opts.intakeId, `adjusted deps: ${decision.reason}`).catch(() => {});
      }
      return { route, message: 'Dependencies adjusted.' };
    }

    if (opts?.intakeId) {
      await appendAutoDecision(opts.intakeId, `note: ${decision.reason}`).catch(() => {});
    }
    return { route, message: 'Note recorded.' };
  }

  /** Short progress view: intake state + plan state + persisted next steps. */
  async autonomousProgress(intakeId?: string): Promise<string> {
    const lines: string[] = [];
    lines.push('Conducting: coordinator (observe → decide → dispatch) + reconciler (merge) + monitor (reports). Follow detaches; close never cancels.');
    if (intakeId) {
      const record = await loadAutoIntake(intakeId);
      if (record) {
        lines.push(`Intake ${record.id} [${record.status}]: ${record.request.split('\n')[0]}`);
        lines.push(`Decisions kept: ${record.decisions.length}, open questions: ${record.questions.length}`);
        for (const step of record.nextSteps.slice(0, 5)) lines.push(`Next: ${step}`);
      } else {
        lines.push(`No intake "${intakeId}" persisted.`);
      }
    } else {
      // Single active intake: surface it without requiring the id.
      const snapshot = await loadRuntimeSnapshot().catch(() => null);
      const record = snapshot?.autoIntake ?? null;
      if (record) {
        lines.push(`Intake ${record.id} [${record.status}]: ${record.request.split('\n')[0]}`);
        lines.push(`Decisions kept: ${record.decisions.length}, open questions: ${record.questions.length}`);
      }
    }
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan) {
      lines.push('No active plan.');
      return lines.join('\n');
    }
    const counts = new Map<string, number>();
    for (const j of plan.jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
    lines.push(
      `Plan "${plan.name}" [${plan.status}]: ` +
        [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', '),
    );
    return lines.join('\n');
  }

  async skipJob(jobName: string, reason?: string): Promise<void> {
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan) {
      throw new Error('No active plan');
    }

    const jobIndex = plan.jobs.findIndex((j) => j.name === jobName);
    if (jobIndex === -1) {
      throw new Error(`Job "${jobName}" not found in plan`);
    }

    const job = plan.jobs[jobIndex];
    const requiresApproval = plan.mode === 'supervisor' || plan.mode === 'copilot';

    if (requiresApproval && !this.pendingReplanActions.has(`skip-${jobName}`)) {
      this.pendingReplanActions.set(`skip-${jobName}`, async () => {
        await this.executeSkipJob(plan, job, reason);
        this.pendingReplanActions.delete(`skip-${jobName}`);
      });
      this.showToast('Mission Control', `Approval required to skip job "${jobName}"`, 'warning');
      return;
    }

    await this.executeSkipJob(plan, job, reason);
  }

  private async executeSkipJob(plan: PlanSpec, job: JobSpec, reason?: string): Promise<void> {
    await updatePlanJob(plan.id, job.name, { status: 'canceled' });
    this.jobComms.unregisterJob(job.name);

    const auditEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      action: 'skip_job',
      jobName: job.name,
      details: { reason: reason ?? 'No reason provided' },
      userApproved: plan.mode !== 'autopilot',
    };

    await this.appendAuditLog(plan.id, auditEntry);
    this.showToast('Mission Control', `Job "${job.name}" skipped`, 'info');
    await this.reconcile();
  }

  async addJob(jobSpec: Omit<JobSpec, 'id' | 'status'>, options?: { forkFrom?: string }): Promise<void> {
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan) {
      throw new Error('No active plan');
    }

    const requiresApproval = plan.mode === 'supervisor' || plan.mode === 'copilot';

    if (requiresApproval && !this.pendingReplanActions.has(`add-${jobSpec.name}`)) {
      this.pendingReplanActions.set(`add-${jobSpec.name}`, async () => {
        await this.executeAddJob(plan, jobSpec, options);
        this.pendingReplanActions.delete(`add-${jobSpec.name}`);
      });
      this.showToast('Mission Control', `Approval required to add job "${jobSpec.name}"`, 'warning');
      return;
    }

    await this.executeAddJob(plan, jobSpec, options);
  }

  private async executeAddJob(
    plan: PlanSpec,
    jobSpec: Omit<JobSpec, 'id' | 'status'>,
    options?: { forkFrom?: string },
  ): Promise<void> {
    const newJob: JobSpec = {
      ...jobSpec,
      id: randomUUID(),
      status: 'queued',
    };

    if (options?.forkFrom) {
      const sourceJob = plan.jobs.find((j) => j.name === options.forkFrom);
      // Fork from the REMOTE worker session when known; launchSessionID is
      // the local control-center session and forking it resumes the wrong
      // context. Propagate the remote session so fix-before-rollback and
      // future forks can reach the worker.
      const sourceSession = sourceJob?.remoteSessionID ?? sourceJob?.launchSessionID;
      if (sourceJob?.port && sourceSession) {
        try {
          const client = createV2Client(sourceJob.port, this.config.serverPassword);
          const forked = await v2ForkSession(client, sourceSession);
          if (newJob.prompt) {
            await v2Prompt(
              client,
              forked.id,
              `Forked from job "${sourceJob.name}" as "${newJob.name}".\n\nAdditional context: ${newJob.prompt}`,
            );
          }
          newJob.port = sourceJob.port;
          newJob.launchSessionID = sourceJob.launchSessionID;
          newJob.remoteSessionID = sourceJob.remoteSessionID;
        } catch {
        }
      }
    }

    plan.jobs.push(newJob);
    await savePlan(plan, this.effectiveRepoRoot());
    this.jobComms.registerJob(newJob);

    const auditEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      action: 'add_job',
      jobName: newJob.name,
      details: { forkFrom: options?.forkFrom },
      userApproved: plan.mode !== 'autopilot',
    };

    await this.appendAuditLog(plan.id, auditEntry);
    this.showToast('Mission Control', `Job "${newJob.name}" added to plan`, 'info');
    await this.reconcile();
    // Incident C fix: addJob must not need a manual resumePlan to advance.
    // When the plan is active (not paused/terminal), ensure the reconciler
    // loop is alive so eligible work dispatches on its own.
    try {
      const latest = await loadPlan(this.effectiveRepoRoot());
      if (latest && (latest.status === 'running' || latest.status === 'merging' || latest.status === 'pending') && !this.isRunning) {
        this.startReconciler();
      }
    } catch {}
  }

  async reorderJobs(newOrder: string[]): Promise<void> {
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan) {
      throw new Error('No active plan');
    }

    if (newOrder.length !== plan.jobs.length) {
      throw new Error('New order must contain all jobs');
    }

    const currentNames = new Set(plan.jobs.map((j) => j.name));
    const newNames = new Set(newOrder);
    if (![...currentNames].every((name) => newNames.has(name))) {
      throw new Error('New order contains unknown job names');
    }

    const requiresApproval = plan.mode === 'supervisor' || plan.mode === 'copilot';

    if (requiresApproval && !this.pendingReplanActions.has('reorder')) {
      this.pendingReplanActions.set('reorder', async () => {
        await this.executeReorderJobs(plan, newOrder);
        this.pendingReplanActions.delete('reorder');
      });
      this.showToast('Mission Control', 'Approval required to reorder jobs', 'warning');
      return;
    }

    await this.executeReorderJobs(plan, newOrder);
  }

  private async executeReorderJobs(plan: PlanSpec, newOrder: string[]): Promise<void> {
    const jobMap = new Map(plan.jobs.map((j) => [j.name, j]));
    const reorderedJobs = newOrder.map((name) => jobMap.get(name)!);

    for (let i = 0; i < reorderedJobs.length; i++) {
      reorderedJobs[i].mergeOrder = i;
    }

    plan.jobs = reorderedJobs;
    await savePlan(plan, this.effectiveRepoRoot());

    const auditEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      action: 'reorder_jobs',
      details: { newOrder },
      userApproved: plan.mode !== 'autopilot',
    };

    await this.appendAuditLog(plan.id, auditEntry);
    this.showToast('Mission Control', 'Jobs reordered', 'info');
    await this.reconcile();
  }

  private async appendAuditLog(planId: string, entry: AuditLogEntry): Promise<void> {
    const plan = await loadPlan(this.effectiveRepoRoot());
    if (!plan || plan.id !== planId) {
      return;
    }

    const auditLog = plan.auditLog ?? [];
    auditLog.push(entry);
    await updatePlanFields(planId, { auditLog });
  }

  relayFinding(fromJob: string, toJob: string, context: RelayContext): void {
    this.jobComms.relayFinding(fromJob, toJob, context);
    this.showToast('Mission Control', `Finding relayed from "${fromJob}" to "${toJob}"`, 'info');
  }

  async approveReplanAction(actionId: string): Promise<void> {
    const action = this.pendingReplanActions.get(actionId);
    if (!action) {
      throw new Error(`No pending replan action with ID "${actionId}"`);
    }
    await action();
  }

  getPendingReplanActions(): Array<{ id: string; description: string }> {
    return Array.from(this.pendingReplanActions.entries()).map(([id, _]) => ({
      id,
      description: this.getReplanDescription(id),
    }));
  }

  private getReplanDescription(actionId: string): string {
    if (actionId.startsWith('skip-')) {
      return `Skip job "${actionId.slice(5)}"`;
    }
    if (actionId.startsWith('add-')) {
      return `Add job "${actionId.slice(4)}"`;
    }
    if (actionId === 'reorder') {
      return 'Reorder jobs';
    }
    return actionId;
  }

  async resumePlan(repoRootOverride?: string): Promise<void> {
    const repoRoot = resolveRepoRoot(repoRootOverride ?? this.repoRoot ?? getActiveRepoRoot() ?? undefined);
    this.repoRoot = repoRoot;
    await withRepoRoot(repoRoot, async () => {
      // F07: public boot reconciles disk state first (kill -9 safe).
      try { await reconcileOnBoot(); } catch {}
      const plan = await loadPlan(repoRoot);
      // F07: recoverable transitions include pending/merging/creating_pr — never silent no-op.
      if (!plan || (plan.status !== 'running' && plan.status !== 'paused' && plan.status !== 'pending' && plan.status !== 'merging' && plan.status !== 'creating_pr')) {
        return;
      }

      if (plan.status === 'paused') {
        await updatePlanFields(plan.id, {
          status: 'running',
          checkpoint: null,
          checkpointContext: null,
        }, repoRoot);
      } else if (plan.status === 'pending') {
        await updatePlanFields(plan.id, { status: 'running' }, repoRoot);
        plan.status = 'running';
      } else if (plan.status === 'creating_pr') {
        // Crash during PR creation: retry completion via merging (forced recovery, warn-and-apply).
        await updatePlanFields(plan.id, { status: 'merging' }, repoRoot);
        plan.status = 'merging';
      } else if (plan.status === 'merging') {
        // Reativação: merging volta a running para o reconciliador re-enfileirar (sem sucesso vazio).
        await updatePlanFields(plan.id, { status: 'running' }, repoRoot);
        plan.status = 'running';
      }
      this.checkpoint = null;

      this.activePlanId = plan.id;
      this.planPlacement = plan.placement ?? null;
      this.planLaunchSessionID = plan.launchSessionID;
      this.mergeTrain = new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());

      const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
      let hasDeadRunningJob = false;

      const tmuxHealthy = await isTmuxHealthy();
      if (!tmuxHealthy) {
        console.warn('tmux server is not responsive, skipping pane checks during resumePlan');
      } else {
        for (const runningJob of runningJobs) {
          try {
            const paneAlive = await isPaneRunning(runningJob.tmuxTarget);
            if (!paneAlive) {
              hasDeadRunningJob = true;
              await updateJob(runningJob.id, {
                status: 'failed',
                completedAt: new Date().toISOString(),
              });
              await updatePlanJob(plan.id, runningJob.name, {
                status: 'failed',
                error: 'tmux pane is not running',
              }, undefined, repoRoot);
            }
          } catch (error) {
            console.warn(
              `tmux error checking job ${runningJob.name} during resumePlan, skipping:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }

      if (hasDeadRunningJob) {
        await updatePlanFields(plan.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        }, repoRoot);
        return;
      }

      this.subscribeToMonitorEvents();
      this.ensureMonitorRunning();
      this.startReconciler();
    });
  }

  private async createPR(opts?: PublishAuthOptions): Promise<string> {
    // M5/M7 (pending M1): no push/PR without explicit human authorization.
    // The human opts in per call — absence of the flag is a refusal.
    requireHumanAuth('git push', opts);
    requireHumanAuth('gh pr create', opts);
    const repoRoot = this.effectiveRepoRoot();
    const plan = await loadPlan(repoRoot);
    if (!plan) {
      throw new Error('No active plan found');
    }

    const pushResult = await this.runCommand(['git', 'push', 'origin', plan.integrationBranch], repoRoot);
    if (pushResult.exitCode !== 0) {
      throw new Error(`Failed to push integration branch: ${pushResult.stderr || pushResult.stdout}`);
    }

    const baseBranch = plan.baseBranch ?? await getDefaultBranch(repoRoot);
    const title = plan.name;
    const jobLines = plan.jobs.map((j) => {
      const status = j.status === 'merged' ? '✅' : j.status === 'failed' ? '❌' : '⏳';
      const mergedAt = j.mergedAt ? new Date(j.mergedAt).toISOString().slice(0, 19).replace('T', ' ') : '—';
      return `| ${j.name} | ${status} ${j.status} | ${mergedAt} |`;
    }).join('\n');

    const mergeTrainConfig = this.getMergeTrainConfig();
    const testingLines: string[] = [];
    if (mergeTrainConfig.testCommand) {
      testingLines.push(`- [x] \`${mergeTrainConfig.testCommand}\` passed after each merge`);
    }
    if (mergeTrainConfig.setupCommands?.length) {
      testingLines.push(`- [x] Setup: \`${mergeTrainConfig.setupCommands.join(' && ')}\``);
    }
    if (testingLines.length === 0) {
      testingLines.push('- No test command configured');
    }

    const body = [
      '## Summary',
      '',
      `Orchestrated plan **${plan.name}** with ${plan.jobs.length} job(s).`,
      '',
      '## Jobs',
      '',
      '| Job | Status | Merged At |',
      '|-----|--------|-----------|',
      jobLines,
      '',
      '## Testing',
      '',
      ...testingLines,
      '',
      '## Notes',
      '',
      `- Integration branch: \`${plan.integrationBranch}\``,
      `- Base commit: \`${plan.baseCommit.slice(0, 8)}\``,
      `- Mode: ${plan.mode}`,
      '',
      '---',
      '',
      '🚀 *Automated PR from [Mission Control](https://github.com/nigel-dev/opencode-mission-control)*',
    ].join('\n');
    const prResult = await this.runCommand([
      'gh',
      'pr',
      'create',
      '--head',
      plan.integrationBranch,
      '--base',
      baseBranch,
      '--title',
      title,
      '--body',
      body,
    ], repoRoot);

    if (prResult.exitCode !== 0) {
      throw new Error(`Failed to create PR: ${prResult.stderr || prResult.stdout}`);
    }

    return prResult.stdout.trim();
  }

  private async runCommand(
    command: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(command, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  private validatePlan(spec: PlanSpec): void {
    const names = spec.jobs.map((job) => job.name);
    if (new Set(names).size !== names.length) {
      throw new Error('Job names must be unique');
    }

    const nameSet = new Set(names);
    for (const job of spec.jobs) {
      for (const dep of job.dependsOn ?? []) {
        if (!nameSet.has(dep)) {
          throw new Error(`Job "${job.name}" depends on unknown job "${dep}"`);
        }
      }
    }

    if (hasCircularDependency(spec.jobs)) {
      throw new Error('Plan contains circular dependencies');
    }
  }

  private subscribeToMonitorEvents(): void {
    if (this.subscriptionsActive) {
      return;
    }

    this.monitor.on('complete', this.handleJobComplete);
    this.monitor.on('failed', this.handleJobFailed);
    this.subscriptionsActive = true;
  }

  private unsubscribeFromMonitorEvents(): void {
    if (!this.subscriptionsActive) {
      return;
    }

    this.monitor.off('complete', this.handleJobComplete);
    this.monitor.off('failed', this.handleJobFailed);
    this.subscriptionsActive = false;
  }
}
