import { randomUUID } from 'crypto';
import type { MCConfig } from './config';
import type { PlanSpec, JobSpec, PlanStatus, CheckpointType, CheckpointContext, AuditLogEntry } from './plan-types';
import { loadPlan, savePlan, updatePlanJob, updatePlanFields, clearPlan, validateGhAuth, claimJobForDispatch, claimConductorLease, recordHeartbeat, recordProgress, verifyConductorLease, DEFAULT_CONDUCTOR_MAX_HEARTBEAT_MS, DEFAULT_CONDUCTOR_MAX_PROGRESS_MS, withPlanLock } from './plan-state';
import { getDefaultBranch, gitCommand } from './git';
import { createIntegrationBranch, deleteIntegrationBranch, requireHumanAuth, type PublishAuthOptions } from './integration';
import { coordinateOnce, clampMaxParallel, isDispatchInfraError, parseDispatchAttempt, formatDispatchInfraError, MAX_DISPATCH_ATTEMPTS } from './coordinator';
import { MergeTrain, checkMergeability, detectTestCommand, detectInstallCommand, runTestCommand, type MergeTestReport, validateTouchSet, isSameCommit } from './merge-train';
import { type ReviewVerdict, reviewJob, runReviewFixLoop, requirementsFromAcceptance, hasAcceptanceCriteria, type EssentialRequirement, type ReviewInput, type SufficiencyDecision, type TestEvidence } from './reviewer';
import { reviewFunctionallyViaOpenCode, toSufficiencyDecision, type FunctionalCriterionInput } from './opencode-reviewer';
import { protectInputsDuringRun, decideIdentityVerdict, runTestsOnImmutableSnapshot, type FileIdentity } from './candidate-identity';
import { getBranchHead, listChangedFiles } from './git';
import { addJob, getRunningJobs, updateJob, loadJobState, removeJob, resolveJobPassword, type Job } from './job-state';
import { JobMonitor } from './monitor';
import { removeReport, readAllReports, buildFinalReportMarkdown, writeFinalReport, describeOmoLimitation } from './reports';
import { getXdgDataDir, getProjectId } from './paths';
import { resolvePostCreateHook } from './worktree-setup';
import { writePromptFile, cleanupPromptFile, writeLauncherScript, cleanupLauncherScript, writeServeLauncherScript, resolveServePassword, describeTuiModelPin } from './prompt-file';
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
  sessionExists,
  setPaneDiedHook,
  windowExists,
  buildOwnedKillList,
  filterOwnedKillTargets,
  formatExecTag,
  sessionNameForJob,
} from './tmux';
import { JobComms, type RelayContext } from './job-comms';
import { createV2Client, v2ForkSession, v2Prompt, v2RunCommand, launchWorkerViaServe, v2WaitForServer, type V2ModelRef } from './sdk-client';
import { allocatePort, releasePort } from './port-allocator';
import { buildWorktreePermissions } from './permission-policy';
import {
  runAutoIntakeWithRetry,
  ensureBaseReady,
  draftToJobSpecs,
  validateRuntimeDecision,
  requiresUserReview,
  loadContextDocs,
  formatContextDocsForPrompt,
  formatModelRefForArgv,
  nextStepsFor,
  validateTaskCoherence,
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
 * Parse a "provider/model[#variant]" snapshot string into a model ref.
 * The `#variant` suffix is the `opencode run --model` pin form (preserved
 * end to end by the planner slot); a bare "provider/model" simply yields no
 * variant. String snapshots without a slash keep provider "unknown".
 */
export function parseModelRef(raw: string): V2ModelRef | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const hash = trimmed.indexOf('#');
  const base = hash > 0 ? trimmed.slice(0, hash) : trimmed;
  const variant = hash > 0 ? trimmed.slice(hash + 1).trim() : undefined;
  const slash = base.indexOf('/');
  const ref = slash > 0
    ? { providerID: base.slice(0, slash), id: base.slice(slash + 1) }
    : { providerID: 'unknown', id: base };
  return variant ? { ...ref, variant } : ref;
}

/**
 * Format a model ref WITHOUT variant (persistence/snapshot-string form).
 * The argv pin form WITH variant lives in auto-plan's formatModelRefForArgv
 * (`opencode run --model provider/id#variant`). Kept variant-less here:
 * the intake persists the variant in its own effectiveVariant field.
 */
export function modelRefToCliString(ref: V2ModelRef): string {
  return `${ref.providerID}/${ref.id}`;
}

/**
 * Conductor freshness budgets (configurable via env, else plan-state defaults).
 * The reconciler heartbeats under these; verify rejects stale holders —
 * an old leader with a smaller epoch never passes verification.
 */
export const DEFAULT_MAX_HEARTBEAT_MS = DEFAULT_CONDUCTOR_MAX_HEARTBEAT_MS;
export const DEFAULT_MAX_PROGRESS_MS = DEFAULT_CONDUCTOR_MAX_PROGRESS_MS;

function conductorStaleOpts(): { maxHeartbeatMs: number; maxProgressMs: number } {
  const hb = Number(process.env.MC_MAX_HEARTBEAT_MS ?? process.env.MC_CONDUCTOR_MAX_HEARTBEAT_MS ?? DEFAULT_MAX_HEARTBEAT_MS);
  const pg = Number(process.env.MC_MAX_PROGRESS_MS ?? process.env.MC_CONDUCTOR_MAX_PROGRESS_MS ?? DEFAULT_MAX_PROGRESS_MS);
  return {
    maxHeartbeatMs: Number.isFinite(hb) && hb > 0 ? hb : DEFAULT_MAX_HEARTBEAT_MS,
    maxProgressMs: Number.isFinite(pg) && pg > 0 ? pg : DEFAULT_MAX_PROGRESS_MS,
  };
}

/** Unit scope (bun test) stays deterministic: the local heuristic decides alone. */
function isTestScope(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/**
 * §4 TOCTOU identity: outputs the test runner may legitimately produce.
 * Coverage/tmp/logs are always ignored. dist/build are NOT a global ignore:
 * only untracked generated outputs (status `??`, never versioned) are
 * permitted there — a versioned source under dist/ that changes (worktree or
 * staged `git add`) is relevant and blocks attribution. This keeps the common
 * persistent-mutation test green without blocking normal builds (untracked
 * coverage/dist outputs stay allowed).
 */
export const ALLOWED_TEST_ARTIFACT_PATTERNS: RegExp[] = [
  /^coverage\//,
  /^\.nyc_output\//,
  /^tmp\//,
  /^\.coverage/,
  /\.lcov$/,
  /\.log$/,
];

/** True when a repo-relative path is a permitted test artifact (coverage/tmp/logs). */
export function isAllowedTestArtifact(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^"+|"+$/g, '').trim();
  if (!normalized) return false;
  return ALLOWED_TEST_ARTIFACT_PATTERNS.some((re) => re.test(normalized));
}

/** True for generated outputs under dist/build that were never versioned. */
function isUntrackedDistBuildOutput(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return /^(dist|build)\//.test(normalized);
}

/** Parse `git status --porcelain` into repo-relative paths (rename-aware). */
export function parsePorcelainDirtyPaths(porcelain: string): string[] {
  return parsePorcelainEntries(porcelain).map((e) => e.path);
}

/** Parse porcelain into status-aware entries (untracked vs tracked change). */
export function parsePorcelainEntries(porcelain: string): Array<{ status: string; path: string }> {
  const out: Array<{ status: string; path: string }> = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const rawStatus = line.slice(0, 2);
    const status = rawStatus.trim();
    const m = line.match(/^.{2}\s+(.*)$/);
    const raw = (m ? m[1] : line.trim()).trim().replace(/^"+|"+$/g, '');
    if (!raw) continue;
    const arrow = raw.indexOf(' -> ');
    const p = (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim().replace(/^"+|"+$/g, '');
    if (p) out.push({ status, path: p });
  }
  return out;
}

/** Dirty paths that are NOT permitted artifacts — the identity-relevant set. */
export function filterRelevantDirtyPaths(paths: string[]): string[] {
  return paths.filter((p) => !isAllowedTestArtifact(p));
}

/** Status-aware filter: untracked dist/build outputs stay permitted, tracked changes block. */
export function filterRelevantDirtyEntries(entries: Array<{ status: string; path: string }>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (isAllowedTestArtifact(e.path)) continue;
    const untracked = e.status === '??' || e.status.includes('?');
    if (untracked && isUntrackedDistBuildOutput(e.path)) continue;
    out.push(e.path);
  }
  return out;
}

/** Stable hash of the scope contents read for review (sorted keys + values). */
export function hashScopeContents(contents: Record<string, string>): string {
  const keys = Object.keys(contents).sort();
  const payload = keys.map((k) => `${k}\0${contents[k]}`).join('\0\0');
  let h = 5381;
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(16)}`;
}

/**
 * True when non-artifact file content changed under the test — a mutation of
 * impl/tests, never an artifact write. Compares post-test contents against
 * pre-test contents, ignoring allowed artifact paths on both sides.
 */
export function hasRelevantContentChange(
  before: Record<string, string>,
  after: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (isAllowedTestArtifact(k)) continue;
    if (before[k] !== after[k]) return true;
  }
  return false;
}

/**
 * §6 launcher routing: serve (verified triple) is the autonomous path.
 * TUI is legacy only — used when `useServeMode === false` explicitly, and
 * always with an explicit unpinned warning (never silently to satisfy the
 * model contract).
 * Default-serve (alinha com tools/launch.ts): ausente === serve.
 */
export function shouldUseServeMode(config: { useServeMode?: boolean }): boolean {
  return config.useServeMode !== false;
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

/**
 * B4: merge readiness gate. A `ready_to_merge` job merges when its
 * declared dependencies are merged and no earlier (mergeOrder) sibling
 * with unfinished work blocks it. A `failed` earlier sibling never
 * blocks an independent job — head-of-line blocking on a failed sibling
 * stalled `pad-task` 4+ min behind a live conductor. Dependency edges
 * still block (a dependent of the failed job stays put).
 */
export function canMergeJobNow(
  jobs: Array<{ name: string; status: string; mergeOrder?: number; dependsOn?: string[] }>,
  jobName: string,
): boolean {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const job = byName.get(jobName);
  if (!job || job.status !== 'ready_to_merge') return false;
  const depsOk = (job.dependsOn ?? []).every((dep) => byName.get(dep)?.status === 'merged');
  if (!depsOk) return false;
  const order = job.mergeOrder ?? Number.MAX_SAFE_INTEGER;
  for (const other of jobs) {
    if (other.name === jobName) continue;
    if ((other.mergeOrder ?? Number.MAX_SAFE_INTEGER) >= order) continue;
    const s = other.status;
    if (s === 'merged' || s === 'failed') continue;
    return false;
  }
  return true;
}

/**
 * B3-deadlock: conteúdo já mergeado na integration mas o plano marca `failed
 * (empty diff)` legado. O job `failed` nunca é re-revisado (review só roda na
 * fila de merge), então nem reconcile, nem resume, nem retry resolvem.
 *
 * Cura fail-closed: só cura quando (a) há mergeEvidence PASS com reviewedCommit,
 * (b) a branch do job ainda está NO MESMO commit (evidência fresca, nunca stale),
 * e (c) o conteúdo está contido na integration — ancestralidade direta
 * (`merge-base --is-ancestor`, caso ff) OU diff vazio por arquivo do
 * touchSet/changedFiles (caso squash, que cria commit novo). Falha funcional
 * sem PASS e commit divergente nunca curam.
 */
export async function shouldHealFailedAsMerged(opts: {
  repoRoot: string;
  integrationBranch: string;
  job: { name: string; branch?: string; touchSet?: string[] };
  evidence?: { testStatus?: string; reviewedCommit?: string; changedFiles?: string[]; scope?: string } | null;
}): Promise<{ heal: boolean; reason: string }> {
  const ev = opts.evidence;
  if (!ev || ev.testStatus !== 'passed' || !ev.reviewedCommit) {
    return { heal: false, reason: 'no PASS evidence (functional failure stays failed)' };
  }
  const branch = opts.job.branch;
  if (!branch || !opts.integrationBranch) {
    return { heal: false, reason: 'missing job branch or integration branch' };
  }
  const head = await getBranchHead(branch, opts.repoRoot);
  if (!head.head || !isSameCommit(head.head, ev.reviewedCommit)) {
    return { heal: false, reason: `stale evidence: branch ${branch} moved past reviewed commit` };
  }
  const ancestor = await gitCommand(
    ['merge-base', '--is-ancestor', ev.reviewedCommit, opts.integrationBranch],
    { cwd: opts.repoRoot },
  );
  if (ancestor.exitCode === 0) {
    return { heal: true, reason: `reviewed commit ${ev.reviewedCommit.slice(0, 8)} is an ancestor of ${opts.integrationBranch}` };
  }
  const paths = (opts.job.touchSet?.length ? opts.job.touchSet : ev.changedFiles) ?? [];
  let checked = 0;
  for (const rel of paths) {
    const safe = rel.replace(/^\/+/, '').trim();
    if (!safe || safe.includes('..')) continue;
    const diff = await gitCommand(
      ['diff', opts.integrationBranch, ev.reviewedCommit, '--', safe],
      { cwd: opts.repoRoot },
    );
    if (diff.exitCode !== 0) {
      return { heal: false, reason: `containment check failed for ${safe} (grounded)` };
    }
    if (diff.stdout.trim() !== '') {
      return { heal: false, reason: `${safe} diverges from ${opts.integrationBranch}` };
    }
    checked += 1;
  }
  if (checked === 0) {
    return { heal: false, reason: 'not an ancestor and no touchSet/changedFiles to verify containment' };
  }
  return { heal: true, reason: `touchSet content of ${ev.reviewedCommit.slice(0, 8)} already contained in ${opts.integrationBranch}` };
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
   * R01: bounded autonomous fix-loop state per job (diagnostic → worker
   * instruction → reverification). attempts counts correction dispatches;
   * lastSignature detects no-progress repeats. Cleared on pass.
   */
  private reviewAttempts = new Map<string, { attempts: number; lastSignature: string }>();
  /** R01: job whose latest review dispatched an autonomous correction (merge skips pause for it). */
  private lastReviewAutoFix: string | null = null;
  /** R01: autonomous correction dispatches before escalating to the user. */
  private static readonly REVIEW_MAX_AUTO_FIX = 2;
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
  /**
   * Conductor fencing identity for this instance (set on start/resume claim).
   * The reconciler verifies + heartbeats with token/epoch+frescor; an old
   * leader whose epoch no longer matches is rejected and steps down.
   * Undefined until this instance claims (unit fakes never claim → skipped).
   */
  private conductorToken?: string;
  private conductorEpoch?: number;

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

  /**
   * R05: real install/usage notes (observed, never invented). Reports the
   * detected install command for the integration worktree labeled as
   * detected-not-executed, plus the effective test command as the usage
   * entry. Never reduces install/usage to the test command alone.
   */
  private async detectInstallNotes(worktree?: string): Promise<string[]> {
    const notes: string[] = [];
    if (worktree) {
      try {
        const install = await detectInstallCommand(worktree).catch(() => null);
        if (install) {
          notes.push(`install (detected, not executed here): ${install}`);
        } else {
          const hasPackageJson = await Bun.file(`${worktree}/package.json`).exists().catch(() => false);
          if (hasPackageJson) notes.push('install: package.json present but no install command detected (bun install is the default guess, not executed)');
        }
      } catch {}
    }
    const testCmd = this.getEffectiveTestCommand();
    if (testCmd) notes.push(`usage: run tests with \`${testCmd}\``);
    return notes;
  }

  /** F04: validate + apply ceiling to this execution's config (used by all components). */
  applyCeiling(ceiling?: { maxParallel?: number; testCommand?: string }): void {
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
   * Per-task gate pins without test execution (structural-only).
   * The pre-merge gate NEVER runs the repo-wide test command: probing the
   * integration worktree WITHOUT the job's own change fails deterministically
   * for aggregator tasks, and acceptance anchors can never match runner
   * stdout verbatim (the runner prints its own lines, not acceptance text).
   * Tasks conclude per-task via worker completion (reports/idle already drove
   * the job to completed) + diff + touchSet (validated before ready_to_merge).
   * The repo-wide gate runs ONCE post-all-merged in integration (final
   * verification, fail-closed). Anchors only apply to evidence observed by the
   * product in the correct context — never to verbatim stdout here.
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
   * R01 public gate: fold the external opencode functional review into the
   * local check. Pass needs BOTH (external pass + local coverage); either
   * side failing blocks. Fail-closed: an unavailable reviewer (missing
   * binary, timeout, unparseable output) or missing evidence never passes —
   * the local heuristic stays auxiliary and never synthesizes a pass.
   */
  private async reviewWithExternalSufficiency(
    input: ReviewInput,
    gradedRequirements: EssentialRequirement[],
    requireExternal: boolean,
  ): Promise<ReviewVerdict> {
    if (!requireExternal || gradedRequirements.length === 0 || !input.evidence || !input.fileContents) {
      return reviewJob(requireExternal ? { ...input, requireExternalSufficiency: true } : input);
    }
    try {
      const decision = await this.attachExternalSufficiency(gradedRequirements, input);
      if (!decision) return reviewJob({ ...input, requireExternalSufficiency: true });
      return reviewJob({ ...input, sufficiency: decision, requireExternalSufficiency: true });
    } catch {
      return reviewJob({ ...input, requireExternalSufficiency: true });
    }
  }

  /**
   * Ask a real OpenCode run for per-criterion functional verdicts and fold
   * them via toSufficiencyDecision. Never throws: every failure mode
   * resolves to an all-fail decision (fail-closed, never a pass).
   */
  private async attachExternalSufficiency(
    gradedRequirements: EssentialRequirement[],
    input: ReviewInput,
  ): Promise<SufficiencyDecision | null> {
    if (gradedRequirements.length === 0 || !input.evidence || !input.fileContents) return null;
    const criteria: FunctionalCriterionInput[] = gradedRequirements.map((r) => ({
      id: r.id,
      description: r.description,
      anchors: r.testAnchors,
    }));
    const contents = input.fileContents;
    const testSet = new Set((input.testPaths ?? []).filter((p) => p in contents));
    const implFiles: Record<string, string> = {};
    const tests: Record<string, string> = {};
    for (const [path, content] of Object.entries(contents)) {
      if (testSet.has(path)) tests[path] = content;
      else implFiles[path] = content;
    }
    // Unified diff as complementary context (best-effort, never blocking).
    let implDiff: string | undefined;
    try {
      const repoRoot = this.effectiveRepoRoot();
      const diff = await gitCommand(['diff', `${input.baseBranch}...${input.jobBranch}`], { cwd: repoRoot });
      if (diff.exitCode === 0 && diff.stdout.trim()) implDiff = diff.stdout.slice(0, 20000);
    } catch {
      implDiff = undefined;
    }
    const timeoutMs = Number(process.env.MC_REVIEW_TIMEOUT_MS ?? 120000);
    // Modelo efetivo herdado (MC_REVIEW_MODEL vira override dentro do
    // resolveReviewModel): sem ele o revisor falhava unpinned sem invocar.
    const effectiveArgv = formatModelRefForArgv(this.ensureEffectiveModel());
    const results = await reviewFunctionallyViaOpenCode({
      requirements: criteria,
      ...(Object.keys(implFiles).length > 0 ? { implFiles } : {}),
      ...(implDiff ? { implDiff } : {}),
      ...(Object.keys(tests).length > 0 ? { tests } : {}),
      outputs: input.evidence.output ?? '',
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    }, effectiveArgv);
    return toSufficiencyDecision(results);
  }

  /**
   * R01: per-task functional gate on the real approval path. NEVER passes on
   * diff alone: derives requirements from the task's acceptance criteria,
   * inspects implementation + tests, runs task-scoped verification (the test
   * command in a candidate worktree at the job HEAD — never the repo-wide
   * gate, which runs once post-all-merged), and judges coverage via reviewJob
   * on product-observed evidence (a green suite that does not exercise the
   * requirement fails). Bounded fix loop (diagnostic → worker instruction →
   * reverification, capped attempts + no-progress detection); escalates to the
   * user only on reserved decisions or grounded impediments.
   */
  private async reviewJobWithFixLoop(job: JobSpec, plan: PlanSpec): Promise<ReviewVerdict> {
    this.lastReviewAutoFix = null;
    const pins = await this.buildStructuralPins(job, plan);
    // B3: `merged` is terminal — never re-review the same commit. A retry
    // that lands on an already-merged job is a no-op pass, never a
    // spurious empty-diff failure in a loop.
    if (job.status === 'merged') {
      return {
        verdict: 'pass',
        blocking: false,
        reasons: [],
        jobName: job.name,
        reviewedCommit: pins.jobHead,
        reviewedBase: pins.baseHead,
      };
    }
    if (pins.changedFiles.length === 0) {
      // B3: empty diff on the SAME commit already verified (task-scoped
      // mergeEvidence PASS) is a no-op pass even in strict mode — the
      // delivery was proven before integration, re-failing it is a loop.
      try {
        const evidence = await loadMergeEvidence().catch(() => null);
        const prev = (evidence as Record<string, { testStatus?: string; reviewedCommit?: string }> | null)?.[job.name];
        if (prev?.testStatus === 'passed' && prev.reviewedCommit && isSameCommit(prev.reviewedCommit, pins.jobHead)) {
          return {
            verdict: 'pass',
            blocking: false,
            reasons: [],
            jobName: job.name,
            reviewedCommit: pins.jobHead,
            reviewedBase: pins.baseHead,
          };
        }
      } catch {}
      return {
        verdict: 'fail',
        blocking: true,
        reasons: [`Review blocked: job "${job.name}" has no changes (empty diff) — nothing to verify`],
        jobName: job.name,
        reviewedCommit: pins.jobHead,
        reviewedBase: pins.baseHead,
      };
    }
    const requirements = requirementsFromAcceptance(job.name, job.prompt ?? '');
    // Manual-plan fallback (documented rule): a prompt WITHOUT `- [ ]`
    // acceptance lines carries no criterion to judge coverage against, so the
    // artificial fallback anchor is NOT graded — grading absence-of-criteria
    // would make every manual merge impossible. The gate still requires
    // product-observed test evidence (command + exit 0 + output + commit on
    // the candidate — never diff alone); the pass is recorded acceptanceLess
    // so the report keeps the job out of Verified and under Gaps ("merged
    // without acceptance criteria"). Autonomous plans always carry acceptance
    // and keep the strict anchor rule.
    const acceptanceLess = !hasAcceptanceCriteria(job.prompt ?? '');
    const gradedRequirements = acceptanceLess ? [] : requirements;
    // Public path (reconcile/merge): a pass requires an external opencode
    // pass decision — the local heuristic never decides alone. Unit scope
    // (bun test) stays deterministic and keeps the local check only.
    const requireExternal = !isTestScope() && gradedRequirements.length > 0;
    const touchSet = job.touchSet?.length ? [...job.touchSet] : undefined;
    const baseInput: ReviewInput = {
      jobName: job.name,
      jobBranch: job.branch ?? '',
      baseBranch: plan.integrationBranch,
      baseHead: pins.baseHead,
      jobHead: pins.jobHead,
      changedFiles: pins.changedFiles,
      ...(touchSet ? { touchSet } : {}),
      requirements: gradedRequirements,
      evidence: null,
      claimedPass: true,
      ...(requireExternal ? { requireExternalSufficiency: true as const } : {}),
    };
    // Inline evidence cycle: review → gather product-observed evidence →
    // re-review, bounded with quarantine on repeating signatures.
    let observed: TestEvidence | null = null;
    const loop = await runReviewFixLoop({
      input: baseInput,
      options: { maxFixCycles: 1, backoffMs: 0, quarantineAfterRepeats: 2 },
      review: (input) => this.reviewWithExternalSufficiency(input, gradedRequirements, requireExternal),
      fix: async (_attempt, _last, input) => {
        // Evidence present but insufficient: needs a worker, not another probe.
        if (input.evidence) return null;
        let gathered: { evidence: TestEvidence; fileContents: Record<string, string>; testPaths: string[] } | null = null;
        try {
          gathered = await this.gatherScopeEvidence(job, pins.jobHead, plan.integrationBranch, pins.changedFiles);
        } catch {
          gathered = null;
        }
        if (!gathered) return null; // grounded impediment: surface the fail, escalate downstream
        observed = gathered.evidence;
        return { ...input, evidence: gathered.evidence, fileContents: gathered.fileContents, testPaths: gathered.testPaths };
      },
      sleep: async () => {},
    });
    if (loop.quarantined) {
      return {
        ...loop.verdict,
        reasons: [...loop.verdict.reasons, 'review quarantined: same failure signature repeats (no progress) — escalating'],
      };
    }
    if (loop.verdict.verdict === 'pass') {
      this.reviewAttempts.delete(job.name);
      // Conserve task-scoped evidence (merged, never replaced) so the final
      // report verifies this job without the global smoke.
      try {
        await saveMergeEvidence({
          jobName: job.name,
          mergedAt: new Date().toISOString(),
          reviewedCommit: pins.jobHead,
          reviewedBase: pins.baseHead,
          changedFiles: pins.changedFiles,
          testCommand: observed?.command,
          testStatus: observed ? 'passed' : 'skipped',
          ...(observed?.output ? { testOutput: observed.output } : {}),
          scope: 'task',
          ...(acceptanceLess ? { acceptanceLess: true } : {}),
        }).catch(() => {});
      } catch {}
      try {
        const snap = await loadRuntimeSnapshot().catch(() => null);
        const intakeId = snap?.autoIntake?.id;
        if (intakeId) {
          await appendAutoDecision(intakeId, `review ${job.name}: pass (${acceptanceLess ? 'MANUAL fallback — no acceptance criteria; scoped evidence only' : 'functional'}, scoped ${observed?.command ?? 'no-command'} @ ${pins.jobHead.slice(0, 8)})`).catch(() => {});
        }
      } catch {}
      return {
        verdict: 'pass',
        blocking: false,
        reasons: [],
        jobName: job.name,
        reviewedCommit: pins.jobHead,
        reviewedBase: pins.baseHead,
      };
    }
    // Fail: decide autonomous correction vs escalation.
    const signature = [...loop.verdict.reasons].sort().join('\n');
    const prev = this.reviewAttempts.get(job.name) ?? { attempts: 0, lastSignature: '' };
    const noProgress = prev.lastSignature !== '' && prev.lastSignature === signature;
    const reasonsText = loop.verdict.reasons.join(' ');
    const reserved =
      requiresUserReview(reasonsText) ||
      /touchSet violation|missing test command|missing execution environment|tested code diverges|candidate .*diverges|tested tree was dirty|missing functional evidence|no test command exists/i.test(reasonsText);
    const canRelaunch = Boolean(job.branch && job.worktreePath);
    if (!reserved && !noProgress && prev.attempts < Orchestrator.REVIEW_MAX_AUTO_FIX && canRelaunch) {
      const instruction = this.buildFunctionalCorrection(job, gradedRequirements, pins.changedFiles, loop.verdict.reasons);
      try {
        await updatePlanJob(plan.id, job.name, {
          status: 'failed',
          error: `Functional review failed: ${loop.verdict.reasons.join('; ').slice(0, 500)}`,
          prompt: `${job.prompt}\n\n---\nREVIEW CORRECTION (attempt ${prev.attempts + 1}/${Orchestrator.REVIEW_MAX_AUTO_FIX}):\n${instruction}`,
        });
        job.status = 'failed';
        job.prompt = `${job.prompt}\n\n---\nREVIEW CORRECTION (attempt ${prev.attempts + 1}/${Orchestrator.REVIEW_MAX_AUTO_FIX}):\n${instruction}`;
        await this.relaunchJobForCorrection(job.name, [], [], {
          functional: { title: 'CORRECTION TASK — Functional review failed', body: instruction },
        });
        job.status = 'running';
        this.reviewAttempts.set(job.name, { attempts: prev.attempts + 1, lastSignature: signature });
        this.lastReviewAutoFix = job.name;
        try {
          const snap = await loadRuntimeSnapshot().catch(() => null);
          const intakeId = snap?.autoIntake?.id;
          if (intakeId) {
            await appendAutoDecision(intakeId, `review ${job.name}: fail (${loop.verdict.reasons.length} reason(s)) — auto-fix attempt ${prev.attempts + 1}/${Orchestrator.REVIEW_MAX_AUTO_FIX} dispatched`).catch(() => {});
          }
        } catch {}
        return {
          verdict: 'fail',
          blocking: true,
          reasons: [...loop.verdict.reasons, `auto-fix attempt ${prev.attempts + 1}/${Orchestrator.REVIEW_MAX_AUTO_FIX} dispatched: worker re-oriented, merge deferred (no pause)`],
          jobName: job.name,
          reviewedCommit: pins.jobHead,
          reviewedBase: pins.baseHead,
        };
      } catch (error) {
        // Relaunch itself failed: grounded impediment, escalate explicitly.
        const msg = error instanceof Error ? error.message : String(error);
        return {
          verdict: 'fail',
          blocking: true,
          reasons: [...loop.verdict.reasons, `auto-fix dispatch failed (grounded impediment): ${msg}`],
          jobName: job.name,
          reviewedCommit: pins.jobHead,
          reviewedBase: pins.baseHead,
        };
      }
    }
    if (noProgress) {
      loop.verdict.reasons.push('no progress: same failure signature as the previous attempt — escalating');
    } else if (prev.attempts >= Orchestrator.REVIEW_MAX_AUTO_FIX) {
      loop.verdict.reasons.push(`auto-fix budget exhausted (${prev.attempts}/${Orchestrator.REVIEW_MAX_AUTO_FIX}) — escalating`);
    }
    return loop.verdict;
  }

  /**
   * R01: product-observed scoped verification. Runs the effective test
   * command in a candidate worktree and returns evidence built by the
   * product — never a worker claim. Two scopes, in order:
   *  1. job scope: the job's own worktree (only when it is clean and its
   *     HEAD equals the job HEAD — otherwise a temporary detached
   *     worktree at the job HEAD);
   *  2. integration candidate: a temporary worktree at the integration
   *     branch with the job's changes merged in (temp area, discarded
   *     afterwards) — the appropriate scope for aggregator tasks whose
   *     isolated probe fails deterministically without siblings.
   * A pass in either scope verifies the candidate; both failing returns
   * combined failing evidence for the diagnosis. Null only when no command
   * can be resolved or executed (grounded impediment).
   *
   * Identity (R01/P3): never labels dirty or divergent trees with the desired
   * commit. Job scope records the observed HEAD (must equal jobHead); the
   * integration candidate records taskHead + candidateBase + candidateHead
   * separately so no pass is ever attributed to the wrong commit.
   */
  private async observeCandidateState(dir: string): Promise<{ head: string | null; dirty: boolean; dirtyPaths?: string[] }> {
    const headRes = await gitCommand(['-C', dir, 'rev-parse', 'HEAD']);
    const head = headRes.exitCode === 0 && headRes.stdout.trim() !== '' ? headRes.stdout.trim() : null;
    const statusRes = await gitCommand(['-C', dir, 'status', '--porcelain']);
    // Fail-closed: an unreadable status is treated as dirty, never as clean.
    // §4: permitted outputs (coverage/tmp/logs + untracked dist/build) are
    // filtered — they never prove an impl/test mutation. Versioned dist/build
    // changes (worktree or staged) stay relevant and block attribution.
    if (statusRes.exitCode !== 0) return { head, dirty: true };
    const dirtyPaths = filterRelevantDirtyEntries(parsePorcelainEntries(statusRes.stdout));
    return { head, dirty: dirtyPaths.length > 0, dirtyPaths };
  }

  private async readCandidateContents(dir: string, changedFiles: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const fs = await import('fs');
    const pathMod = await import('path');
    for (const rel of changedFiles.slice(0, 24)) {
      const safe = rel.replace(/^\/+/, '');
      if (safe === '' || safe.includes('..')) continue;
      const full = pathMod.join(dir, safe);
      let stat: { isFile(): boolean; size: number };
      try {
        stat = fs.statSync(full);
      } catch {
        // Deleted or unreadable on the candidate — skip; the review fails
        // closed on absent proof rather than inventing content.
        continue;
      }
      if (!stat.isFile() || stat.size > 40000) continue;
      try {
        out[rel] = fs.readFileSync(full, 'utf8').slice(0, 20000);
      } catch {
        // Unreadable file — skip without inventing content (see above).
        continue;
      }
    }
    return out;
  }

  /** File paths referenced by a test command (`node check.mjs` → check.mjs). */
  private extractCommandFileRefs(command: string): string[] {
    const refs: string[] = [];
    const tokenPattern = /"([^"]+)"|'([^']+)'|`([^`]+)`|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = tokenPattern.exec(command)) !== null) {
      const token = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (!token || token.startsWith('-')) continue;
      if (!/\.(m?[jt]s|[jt]sx|mts|cts|cjs)$/.test(token)) continue;
      const cleaned = token.replace(/^[./\\]+/, '').replace(/\\/g, '/');
      if (cleaned === '' || cleaned.includes('..')) continue;
      if (!refs.includes(cleaned)) refs.push(cleaned);
      if (refs.length >= 8) break;
    }
    return refs;
  }

  /** Test-like tracked files present in a candidate (existing suite cover). */
  private async discoverCandidateTests(dir: string): Promise<string[]> {
    const ls = await gitCommand(['-C', dir, 'ls-files']);
    if (ls.exitCode !== 0) return [];
    const isTest = (p: string): boolean => /test|spec|__tests__|\.test\.|\.spec\./i.test(p);
    return ls.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && isTest(l) && !l.includes('..'))
      .slice(0, 10);
  }

  private async readScopeContents(
    dir: string,
    changedFiles: string[],
    command: string | undefined,
  ): Promise<{ contents: Record<string, string>; testPaths: string[] }> {
    const refs = command !== undefined ? this.extractCommandFileRefs(command) : [];
    let discovered: string[] = [];
    try {
      discovered = await this.discoverCandidateTests(dir);
    } catch {
      discovered = [];
    }
    const wanted = [...changedFiles];
    for (const extra of [...refs, ...discovered]) {
      if (!wanted.includes(extra)) wanted.push(extra);
      if (wanted.length >= 24) break;
    }
    const contents = await this.readCandidateContents(dir, wanted);
    const available = new Set(Object.keys(contents));
    const testPaths = [
      ...changedFiles.filter((p) => /test|spec|__tests__|\.test\.|\.spec\./i.test(p) && available.has(p)),
      ...refs.filter((p) => available.has(p)),
      ...discovered.filter((p) => available.has(p)),
    ].filter((p, i, arr) => arr.indexOf(p) === i);
    return { contents, testPaths };
  }

  /**
   * Scope paths executed by a candidate run: changed files plus test files
   * referenced by the test command and discovered test-likes (capped).
   */
  private async collectScopePaths(dir: string, changedFiles: string[], command: string | undefined): Promise<string[]> {
    const refs = command !== undefined ? this.extractCommandFileRefs(command) : [];
    let discovered: string[] = [];
    try {
      discovered = await this.discoverCandidateTests(dir);
    } catch {
      discovered = [];
    }
    return [...new Set([...changedFiles, ...refs, ...discovered])]
      .filter((p) => p !== '' && !p.includes('..'))
      .slice(0, 24);
  }

  /** Tracked set for the dist/build allowlist (unknown tracking fails closed). */
  private async buildIsTracked(dir: string): Promise<((rel: string) => boolean) | undefined> {
    try {
      const ls = await gitCommand(['-C', dir, 'ls-files']);
      if (ls.exitCode !== 0) return undefined;
      const set = new Set(ls.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      return (rel: string) => set.has(rel);
    } catch {
      return undefined;
    }
  }

  /** Content snapshots as FileIdentity records for the canonical verdict. */
  private scopeFileIdentities(contents: Record<string, string>): Record<string, FileIdentity> {
    const out: Record<string, FileIdentity> = {};
    for (const [key, value] of Object.entries(contents)) {
      out[key] = { hash: hashScopeContents({ [key]: value }), mtimeMs: 0, size: value.length, exists: true };
    }
    return out;
  }

  private async gatherScopeEvidence(
    job: JobSpec,
    jobHead: string,
    integrationBranch: string,
    changedFiles: string[],
  ): Promise<{ evidence: TestEvidence; fileContents: Record<string, string>; testPaths: string[] } | null> {
    const repoRoot = this.effectiveRepoRoot();
    const timeout = (this.config as MCConfig & { testTimeout?: number }).testTimeout ?? 600000;
    const configured = this.getEffectiveTestCommand();
    const tempDirs: string[] = [];
    const makeTemp = async (prefix: string): Promise<string> => {
      const { mkdtempSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const dir = mkdtempSync(join(tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    };
    const cleanup = async (): Promise<void> => {
      for (const dir of tempDirs.splice(0)) {
        await gitCommand(['worktree', 'remove', '--force', dir], { cwd: repoRoot }).catch(() => {});
      }
    };
    try {
      // Scope 1: job tree — only when clean and at the reviewed commit.
      // A dirty worktree or a divergent HEAD is never tested under the job
      // HEAD label; fall back to an immutable detached worktree instead.
      let jobCandidate = job.worktreePath;
      if (jobCandidate) {
        const probe = await gitCommand(['-C', jobCandidate, 'rev-parse', '--git-dir']);
        if (probe.exitCode !== 0) {
          jobCandidate = undefined;
        } else {
          const observed = await this.observeCandidateState(jobCandidate);
          if (observed.dirty || observed.head !== jobHead) jobCandidate = undefined;
        }
      }
      if (!jobCandidate) {
        const base = await makeTemp('mc-review-job-');
        const add = await gitCommand(['worktree', 'add', '--detach', base, jobHead], { cwd: repoRoot });
        if (add.exitCode !== 0) return null;
        const observed = await this.observeCandidateState(base);
        if (observed.dirty || observed.head !== jobHead) return null;
        jobCandidate = base;
      }
      const observedJob = await this.observeCandidateState(jobCandidate);
      const cmdA = configured ?? await detectTestCommand(jobCandidate);
      let evidenceA: TestEvidence | null = null;
      let contentsA: Record<string, string> = {};
      let testsA: string[] = [];
      if (cmdA) {
        // §4 TOCTOU A→B→A: the run executes under protected inputs
        // (snapshot hash before, read-only hardening, re-hash on a short
        // poll, hash+mtime compare after). A swap that executes and restores
        // — invisible to HEAD/dirty/content-after — still refuses identity.
        // Allowlist respected inside: untracked dist/build outputs stay
        // writable, versioned dist stays a protected input.
        const scopedBefore = await this.readScopeContents(jobCandidate, changedFiles, cmdA).catch(() => null);
        const scopePathsA = await this.collectScopePaths(jobCandidate, changedFiles, cmdA);
        const isTrackedA = await this.buildIsTracked(jobCandidate);
        let runA: { success: boolean; output: string; timedOut: boolean } | undefined;
        const protectionA = await protectInputsDuringRun({
          dir: jobCandidate,
          scopePaths: scopePathsA,
          ...(isTrackedA ? { isTracked: isTrackedA } : {}),
          runFn: async () => {
            runA = await runTestCommand(jobCandidate, cmdA, timeout);
          },
        });
        const result = runA ?? {
          success: false,
          output: `protection refused the run: ${protectionA.reason ?? 'write denied on protected input'}`,
          timedOut: false,
        };
        // Re-observe AFTER the run AND after reading: never stamp the
        // pre-test head over changed content (§4 Bloqueante B).
        const observedAfter = await this.observeCandidateState(jobCandidate);
        const scoped = await this.readScopeContents(jobCandidate, changedFiles, cmdA);
        contentsA = scoped.contents;
        testsA = scoped.testPaths;
        // Canonical identity verdict over the executed bytes: content hash
        // plus transient hits observed DURING the run. testedCommit is never
        // stamped clean over a transient mutation — it fails here.
        const canonicalA = scopedBefore
          ? decideIdentityVerdict(
              this.scopeFileIdentities(scopedBefore.contents),
              this.scopeFileIdentities(contentsA),
              protectionA.transientHits,
            )
          : protectionA.verdict === 'fail'
            ? { verdict: 'fail' as const, reason: protectionA.reason }
            : { verdict: 'pass' as const };
        const mutated = scopedBefore
          ? hasRelevantContentChange(scopedBefore.contents, contentsA)
          : false;
        const protectionFail = protectionA.verdict === 'fail' || canonicalA.verdict === 'fail';
        const diverged = observedAfter.head !== observedJob.head;
        const dirtyAfter = observedAfter.dirty || mutated || diverged || protectionFail;
        const refusalA = protectionFail
          ? (protectionA.reason ?? canonicalA.reason ?? 'identity refused: input changed during run')
          : undefined;
        evidenceA = this.toScopeEvidence(
          cmdA,
          result,
          { testedCommit: observedAfter.head ?? jobHead, dirty: dirtyAfter },
          `worktree:${jobCandidate} (product-executed, job scope, ${process.platform})`,
          refusalA ?? (dirtyAfter && result.success
            ? `identity refused: tree changed during test (head ${observedJob.head?.slice(0, 8)}→${observedAfter.head?.slice(0, 8)}, dirty=${observedAfter.dirty}, content-changed=${mutated}) — not attributed to ${jobHead.slice(0, 8)}`
            : undefined),
        );
        if (result.success && !dirtyAfter && observedAfter.head === jobHead && observedAfter.head === observedJob.head) {
          return { evidence: evidenceA, fileContents: contentsA, testPaths: testsA };
        }
      }
      // Scope 2: integration candidate (base + job changes, temp area).
      const candidateDir = await makeTemp('mc-review-int-');
      const addB = await gitCommand(['worktree', 'add', '--detach', candidateDir, integrationBranch], { cwd: repoRoot });
      if (addB.exitCode !== 0) return evidenceA ? { evidence: evidenceA, fileContents: contentsA, testPaths: testsA } : null;
      const baseObserved = await this.observeCandidateState(candidateDir);
      if (baseObserved.dirty) return evidenceA ? { evidence: evidenceA, fileContents: contentsA, testPaths: testsA } : null;
      const mergeB = await gitCommand(['merge', '--no-ff', '--no-edit', jobHead], { cwd: candidateDir });
      if (mergeB.exitCode !== 0) {
        await gitCommand(['merge', '--abort'], { cwd: candidateDir }).catch(() => {});
        return evidenceA ? { evidence: evidenceA, fileContents: contentsA, testPaths: testsA } : null;
      }
      const candidateObserved = await this.observeCandidateState(candidateDir);
      const cmdB = configured ?? await detectTestCommand(candidateDir);
      if (!cmdB) return evidenceA ? { evidence: evidenceA, fileContents: contentsA, testPaths: testsA } : null;
      const scopedBBefore = await this.readScopeContents(candidateDir, changedFiles, cmdB).catch(() => null);
      const scopePathsB = await this.collectScopePaths(candidateDir, changedFiles, cmdB);
      const isTrackedB = await this.buildIsTracked(candidateDir);
      let runB: { success: boolean; output: string; timedOut: boolean } | undefined;
      const protectionB = await protectInputsDuringRun({
        dir: candidateDir,
        scopePaths: scopePathsB,
        ...(isTrackedB ? { isTracked: isTrackedB } : {}),
        runFn: async () => {
          runB = await runTestCommand(candidateDir, cmdB, timeout);
        },
      });
      const resultB = runB ?? {
        success: false,
        output: `protection refused the run: ${protectionB.reason ?? 'write denied on protected input'}`,
        timedOut: false,
      };
      // §4: same re-observation as scope 1 — never stamp the pre-test
      // candidate head over content changed by the test run.
      const candidateAfter = await this.observeCandidateState(candidateDir);
      const scopedB = await this.readScopeContents(candidateDir, changedFiles, cmdB);
      const contentsB = scopedB.contents;
      const testsB = scopedB.testPaths;
      const canonicalB = scopedBBefore
        ? decideIdentityVerdict(
            this.scopeFileIdentities(scopedBBefore.contents),
            this.scopeFileIdentities(contentsB),
            protectionB.transientHits,
          )
        : protectionB.verdict === 'fail'
          ? { verdict: 'fail' as const, reason: protectionB.reason }
          : { verdict: 'pass' as const };
      const mutatedB = scopedBBefore
        ? hasRelevantContentChange(scopedBBefore.contents, contentsB)
        : false;
      const protectionFailB = protectionB.verdict === 'fail' || canonicalB.verdict === 'fail';
      const divergedB = candidateAfter.head !== candidateObserved.head;
      const dirtyAfterB = candidateAfter.dirty || mutatedB || divergedB || protectionFailB;
      const refusalB = protectionFailB
        ? (protectionB.reason ?? canonicalB.reason ?? 'identity refused: candidate input changed during run')
        : undefined;
      const evidenceB = this.toScopeEvidence(
        cmdB,
        resultB,
        {
          testedCommit: candidateAfter.head ?? jobHead,
          taskHead: jobHead,
          candidateBase: baseObserved.head ?? undefined,
          candidateHead: candidateAfter.head ?? undefined,
          dirty: dirtyAfterB,
        },
        `integration-candidate:${candidateDir} (base ${integrationBranch}@${(baseObserved.head ?? '').slice(0, 8)} + job ${jobHead.slice(0, 8)}, product-executed, ${process.platform})`,
        refusalB ?? (dirtyAfterB && resultB.success
          ? `identity refused: candidate changed during test (head ${candidateObserved.head?.slice(0, 8)}→${candidateAfter.head?.slice(0, 8)}, dirty=${candidateAfter.dirty}, content-changed=${mutatedB})`
          : undefined),
      );
      if (resultB.success && !dirtyAfterB && candidateAfter.head === candidateObserved.head) return { evidence: evidenceB, fileContents: contentsB, testPaths: testsB };
      // Both scopes failed: combined evidence so the diagnosis names both.
      if (evidenceA) {
        const combined: TestEvidence = {
          ...evidenceB,
          // Preserve the job-scope mutation signal: a dirty scope-1 run must
          // never be laundered into a clean combined record (§4).
          ...(evidenceA.dirty ? { dirty: true } : {}),
          output: `[job scope] ${cmdA}\n${evidenceA.output}\n\n[integration candidate] ${cmdB}\n${evidenceB.output}`.slice(0, 8000),
        };
        return {
          evidence: combined,
          // Job-scope contents win on collision: they are what the first
          // (mutating) run actually executed.
          fileContents: { ...contentsB, ...contentsA },
          testPaths: [...new Set([...testsA, ...testsB])],
        };
      }
      return { evidence: evidenceB, fileContents: contentsB, testPaths: testsB };
    } finally {
      await cleanup();
    }
  }

  private toScopeEvidence(
    command: string,
    result: { success: boolean; output: string; timedOut: boolean },
    identity: { testedCommit: string; taskHead?: string; candidateBase?: string; candidateHead?: string; dirty?: boolean },
    environment: string,
    identityNote?: string,
  ): TestEvidence {
    const base = `${result.timedOut ? '[timed out] ' : ''}${result.output}`.slice(0, 7800).trim()
      || `(no output; ${result.success ? 'exit 0' : 'non-zero exit'})`;
    const output = identityNote ? `${identityNote}\n${base}`.slice(0, 8000) : base;
    return {
      command,
      exitCode: result.success ? 0 : 1,
      output,
      testedCommit: identity.testedCommit,
      environment,
      ...(identity.taskHead !== undefined ? { taskHead: identity.taskHead } : {}),
      ...(identity.candidateBase !== undefined ? { candidateBase: identity.candidateBase } : {}),
      ...(identity.candidateHead !== undefined ? { candidateHead: identity.candidateHead } : {}),
      ...(identity.dirty !== undefined ? { dirty: identity.dirty } : {}),
    };
  }

  /**
   * R01: worker instruction for a functional review failure. Names the failing
   * reasons, the requirements, and the changed scope — never a bare "fix it"
   * and never "print the anchor". The diagnosis already says whether the
   * implementation or the tests must change; the worker fixes that side and
   * proves it with a test that calls the implementation.
   */
  private buildFunctionalCorrection(
    job: JobSpec,
    requirements: EssentialRequirement[],
    changedFiles: string[],
    diagnosis: string[],
  ): string {
    const isTest = (f: string) => /test|spec|__tests__|\.test\.|\.spec\./i.test(f);
    const impl = changedFiles.filter((f) => !isTest(f));
    const testFiles = changedFiles.filter(isTest);
    return [
      `The previous work on branch "${job.branch ?? '(unknown)'}" did not pass functional review:`,
      ...diagnosis.map((d) => `- ${d}`),
      ``,
      `Requirements that must hold (each needs a test that calls the implementation and asserts the result):`,
      ...requirements.map((r) => `- ${r.id}: ${r.description}`),
      ...(impl.length > 0 ? [`Changed implementation files: ${impl.join(', ')}`] : []),
      ...(testFiles.length > 0
        ? [`Changed test files: ${testFiles.join(', ')}`]
        : [`No test file was changed — add or extend tests that exercise the requirements above.`]),
      `Instructions:`,
      `1. Fix the implementation and/or tests on this branch per the diagnosis above so every requirement is exercised by a test assertion that calls the implementation (a matching test name alone is not coverage).`,
      `2. Do NOT weaken tests to force approval: if a previous test was wrong, record why in the commit message.`,
      `3. Commit your corrections and report completion.`,
      `4. Reporting is NOT optional: call the mc_report tool when you start (status: "working"), at milestones (status: "progress"), and when done (status: "completed" with the test output). Without mc_report the run cannot complete.`,
    ].join('\n');
  }

  /**
   * F08/R08: conclude integration locally on the destination branch.
   * After verifications, the destination (baseBranch or default) receives
   * the integration branch WITHOUT push/PR. Protects preexisting changes
   * (dirty tree refuses), and re-verifies with the test command when the
   * destination advanced since the plan base.
   * R08: the candidate is verified BEFORE the destination ref moves, and ANY
   * failure after the ref moved rolls the destination back to its recorded
   * HEAD (restoring the checkout alone never undoes a merge). The reset only
   * ever targets the recorded pre-merge destination HEAD — never an
   * uncontrolled reset — and the original checkout is always restored.
   * Test-only fakes (unknown branches in a non-repo worktree) return null to
   * preserve the legacy PR path in unit tests; real repos enforce strictly.
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
    const recordedDestHead = destHead.head;
    let merged = false;
    try {
      // R08 preflight: when the destination advanced since the plan base, the
      // re-verification command must resolve BEFORE the ref moves — a missing
      // command refuses completion without touching the destination.
      const advanced = recordedDestHead !== plan.baseCommit;
      if (advanced) {
        const preConfigured = this.getEffectiveTestCommand();
        const preCmd = preConfigured ?? await detectTestCommand(repoRoot);
        if (!preCmd) {
          throw new Error('Destination advanced since plan base but no test command exists to reverify — refusing to complete (destination untouched)');
        }
      }
      const mergeRes = await gitCommand(
        ['merge', '--no-ff', '-m', `Merge ${integrationBranch} (local autonomous completion)`, integrationBranch],
        { cwd: repoRoot },
      );
      if (mergeRes.exitCode !== 0) {
        await gitCommand(['merge', '--abort'], { cwd: repoRoot }).catch(() => {});
        throw new Error(`Local destination merge conflicts (${destination} <- ${integrationBranch}): ${mergeRes.stderr || mergeRes.stdout}`);
      }
      merged = true;
      let reverified = false;
      if (advanced) {
        // Destination advanced since the plan base: re-run tests on the merged tree.
        // §4 identidade: executa no snapshot imutável (git archive) — mutação
        // ou A→B→A restore no original durante o run falha, nunca é atribuído.
        const configured = this.getEffectiveTestCommand();
        const cmd = configured ?? await detectTestCommand(repoRoot);
        if (!cmd) {
          throw new Error('Destination advanced since plan base but no test command exists to reverify — refusing to complete');
        }
        const timeout = (this.config as MCConfig & { testTimeout?: number }).testTimeout ?? 600000;
        const retest = await this.runImmutableRetest(repoRoot, cmd, timeout);
        reverified = true;
        if (!retest.success) {
          throw new Error(`Reverification on advanced destination failed (${cmd}): ${retest.output.slice(0, 500)}`);
        }
      }
      const newHead = await gitCommand(['rev-parse', 'HEAD'], { cwd: repoRoot });
      return { destinationBranch: destination, destinationHead: newHead.stdout.trim(), integratedHead: intHead.head, reverified };
    } catch (e) {
      // R08 rollback: any failure after the ref moved restores the recorded
      // destination HEAD (checkout restore alone never undoes a merge).
      if (merged) {
        await gitCommand(['reset', '--hard', recordedDestHead], { cwd: repoRoot }).catch(() => {});
      }
      // Restore the original checkout (best-effort).
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
   * Claim conductor ownership and keep the fencing identity (token/epoch).
   * Best-effort so unit fakes without state dir keep working; the handoff
   * verifies by re-read and fails closed when absent.
   */
  private async claimConductorOwnership(planId: string, command: string, owner: string, repoRoot: string): Promise<void> {
    try {
      const lease = await claimConductorLease(planId, process.pid, command, owner, repoRoot);
      this.conductorToken = lease.token;
      this.conductorEpoch = lease.epoch;
    } catch {
      // Best-effort: the public handoff re-reads the lease and fails closed.
    }
  }

  /**
   * Periodic liveness: verify ownership with token/epoch+frescor, then
   * heartbeat. Returns false when this instance no longer owns the plan
   * (takeover bumped the epoch, token rotated, or lease went stale) — the
   * old leader must step down, never keep driving. Skipped until this
   * instance claims (unit fakes without a claim never heartbeat) and in
   * unit scope (bun test stays deterministic — fencing itself is covered
   * by the plan-state and handoff suites with real state dirs, never by
   * the loop here).
   */
  private async heartbeatConductor(planId: string, repoRoot: string): Promise<boolean> {
    if (isTestScope()) return true;
    if (this.conductorToken === undefined && this.conductorEpoch === undefined) return true;
    try {
      const owned = await verifyConductorLease(planId, process.pid, repoRoot, {
        token: this.conductorToken,
        epoch: this.conductorEpoch,
        ...conductorStaleOpts(),
      });
      if (!owned) return false;
      try {
        const lease = await recordHeartbeat(planId, process.pid, repoRoot, { token: this.conductorToken });
        this.conductorToken = lease.token;
        this.conductorEpoch = lease.epoch;
      } catch {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Mark work progress (also refreshes liveness). Best-effort, never throws.
   * Skipped in unit scope (same determinism precedent as the heartbeat). */
  private async progressConductor(planId: string, repoRoot: string): Promise<void> {
    if (isTestScope()) return;
    if (this.conductorToken === undefined && this.conductorEpoch === undefined) return;
    try {
      const lease = await recordProgress(planId, process.pid, repoRoot, { token: this.conductorToken });
      this.conductorToken = lease.token;
      this.conductorEpoch = lease.epoch;
    } catch {
      // Best-effort: a fencing mismatch surfaces on the next heartbeat verify.
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
      // R05: Verified = merged AND backed by TASK-scoped passing product
      // evidence (scoped review run on the candidate). Jobs covered only by
      // the repo-wide integration smoke stay out of Verified — a shared
      // integration run is one integration test, not per-task verification.
      // Pins (reviewedCommit/reviewedBase/changedFiles) merge by field, never
      // reset by the global write.
      type EvidenceView = { testStatus?: string; scope?: string; testCommand?: string; reviewedCommit?: string; acceptanceLess?: boolean };
      const evOf = (name: string): EvidenceView => (mergeEvidence as Record<string, EvidenceView>)[name] ?? {};
      const taskVerified = (name: string): boolean => {
        const rec = evOf(name);
        // Manual fallback (no acceptance criteria) never verifies: evidence
        // allowed the merge, but there was no criterion to judge coverage.
        return rec.testStatus === 'passed' && rec.scope === 'task' && Boolean(rec.reviewedCommit) && !rec.acceptanceLess;
      };
      const acceptanceLessEntries = merged
        .filter((name) => evOf(name).acceptanceLess)
        .map((name) => `${name} [merged] — no acceptance criteria defined, outcome not verified by criterion`);
      const verified = merged
        .filter(taskVerified)
        .map((name) => {
          const rec = evOf(name);
          return `${name} [merged, task-scoped]${rec.testCommand ? ` ${rec.testCommand} passed` : ''}${rec.reviewedCommit ? ` @ ${rec.reviewedCommit.slice(0, 8)}` : ''}`;
        });
      const integrationCovered = merged
        .filter((name) => !taskVerified(name) && evOf(name).testStatus === 'passed')
        .map((name) => {
          const rec = evOf(name);
          return `${name} [merged] — covered only by global integration smoke${rec.testCommand ? ` (${rec.testCommand})` : ''}, no task-scoped verification`;
        });
      const unmet = plan.jobs
        .filter((job) => job.status === 'failed' || job.status === 'conflict' || job.status === 'needs_rebase' || job.status === 'canceled')
        .map((job) => `${job.name} [${job.status}]${job.error ? `: ${job.error}` : ''}`);
      // R05: Gaps also surface pending human decisions and requirements
      // without integrated work — a complement awaiting decision blocks
      // acceptance of its requirement.
      let pendingQuestions: string[] = [];
      try {
        const persisted = snap?.pendingQuestions ?? [];
        pendingQuestions = [
          ...(intake?.questions ?? []),
          ...persisted.map((q) => `[${q.jobId}] ${q.question}`),
        ];
      } catch {
        pendingQuestions = [...(intake?.questions ?? [])];
      }
      const mergedPrompts = plan.jobs
        .filter((job) => job.status === 'merged')
        .map((job) => job.prompt ?? '');
      // A requirement is met only when some merged job carries one of its
      // acceptance anchors (tasks embed acceptance verbatim at launch).
      const unmetRequirements = (intake?.requirements ?? [])
        .filter((r) => {
          const needles = [...(r.acceptance ?? []), r.id].map((s) => s.trim()).filter(Boolean);
          if (needles.length === 0) {
            const probe = r.text.trim().toLowerCase().slice(0, 40);
            return !probe || !mergedPrompts.some((p) => p.toLowerCase().includes(probe));
          }
          return !needles.some((n) => mergedPrompts.some((p) => p.includes(n)));
        })
        .map((r) => `requirement "${r.id}" without merged work: ${r.text}`);
      const pendingGaps = pendingQuestions.map((q) => `pending human decision (blocks acceptance): ${q}`);
      const unverified = [
        ...plan.jobs
          .filter((job) => job.status !== 'merged')
          .filter((job) => !unmet.some((entry) => entry.startsWith(`${job.name} `)))
          .map((job) => `${job.name} [${job.status}] — outcome not verified`),
        ...integrationCovered.map((entry) => `${entry}`),
        ...acceptanceLessEntries.map((entry) => `${entry}`),
        ...unmetRequirements.map((entry) => `${entry}`),
        ...pendingGaps,
      ];
      const files = [...new Set(evidenceList.flatMap((r) => r.changedFiles ?? []))];
      const configuredCmd = this.getEffectiveTestCommand();
      const installNotes = await this.detectInstallNotes(plan.integrationWorktree).catch(() => [] as string[]);
      const installUsage = [...new Set([
        ...installNotes,
        ...evidenceList.flatMap((r) => [...(r.setupCommands ?? []), ...(r.testCommand ? [r.testCommand] : [])]),
        ...(configuredCmd && !evidenceList.some((r) => r.testCommand === configuredCmd) ? [`configured test command (not yet executed in this run): ${configuredCmd}`] : []),
      ])];
      const tests = evidenceList
        .filter((r) => r.testCommand)
        .map((r) => ({ command: `${r.scope === 'integration' ? '[integration] ' : r.scope === 'task' ? '[task] ' : ''}${r.testCommand!}`, result: r.testStatus, output: r.testOutput }));
      const decisions = [...(intake?.decisions ?? []), ...(plan.auditLog ?? []).map((a) => `${a.action}${a.jobName ? ` ${a.jobName}` : ''}`)];
      // OMO status declared explicitly (never a silent success): without OMO
      // the report records vanilla-only execution as the limitation.
      let omoLine = 'Limitation: OMO status unknown — vanilla execution only.';
      try {
        const omo = await detectOMO().catch(() => null);
        if (omo) omoLine = describeOmoLimitation(omo.detected, omo.configSource ?? undefined);
      } catch {
        // Best-effort: the unknown-status line above already fails closed.
      }
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
          omoLine,
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
    // The env string may carry #variant (parsed by parseModelRef); the tracked
    // lookup is session-scoped when the plan knows its launching session
    // (tools/plan+launch read the same session), falling back to the global
    // tracked model otherwise — identical behavior when untracked.
    const env = process.env.MC_PLANNER_MODEL?.trim();
    if (env) {
      const parsed = parseModelRef(env);
      if (parsed) return parsed;
    }
    const ref = getCurrentModelRef(this.planLaunchSessionID);
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
          jobs: plan.jobs.map((job) => {
            const live = byName.get(job.name) ?? job;
            return {
              name: job.name,
              status: live.status,
              dependsOn: job.dependsOn,
              mergeOrder: job.mergeOrder,
              priority: job.priority,
              error: live.error,
            };
          }),
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
          if (!current) return { sessionID: '' };
          // B2: a failed-infra pick re-enters via requeue first (failed →
          // queued is a forced recovery transition) so the claim below sees
          // a dispatchable state. Anything else non-queued stays skipped.
          if (current.status === 'failed') {
            if (!isDispatchInfraError(current.error) || parseDispatchAttempt(current.error) >= MAX_DISPATCH_ATTEMPTS) {
              return { sessionID: '' };
            }
            const depsOk = (current.dependsOn ?? []).every((dep) => byName.get(dep)?.status === 'merged');
            try {
              await updatePlanJob(plan.id, current.name, { status: depsOk ? 'queued' : 'waiting_deps' }, { force: true }, this.effectiveRepoRoot());
              current.status = depsOk ? 'queued' : 'waiting_deps';
            } catch {
              return { sessionID: '' };
            }
          }
          if (current.status !== 'queued' && current.status !== 'waiting_deps') {
            return { sessionID: '' };
          }
          const key = `${plan.id}:${req.job.name}`;
          if (dispatchedThisPass.has(key) || (this.coordinatedJobs.has(key) && current.status === 'running')) {
            return { sessionID: '' };
          }
          dispatchedThisPass.add(key);
          // F03: use the coordinator-calculated prompt (not a stale job.prompt).
          if (req.prompt) current.prompt = req.prompt;
          const ok = await this.launchJob(current);
          if (ok === false) return { sessionID: '' };
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
    // Conductor lease on boot: this driver proves assumption (sonda 13).
    // Keeps the fencing identity (token/epoch) for periodic heartbeat +
    // verify in the reconciler; best-effort so unit fakes without state dir
    // keep working (the public handoff re-reads the lease and fails closed).
    await this.claimConductorOwnership(plan.id, `start plan ${plan.id}`, 'orchestrator-start', repoRoot);
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

  /**
   * One-shot CLI hygiene: shut down ONLY the loops/listeners THIS instance
   * started (reconciler timer, monitor polling, event subscriptions) so the
   * CLI process can exit instead of lingering as a secondary coordinator.
   * Never kills tmux sessions/panes, worktrees, branches or anyone else's
   * process — stopping a view/driver loop is not canceling work.
   */
  shutdown(): void {
    this.stopReconciler();
    this.unsubscribeFromMonitorEvents();
    try {
      const monitor = this.monitor as unknown as { stop?: () => void };
      if (typeof monitor.stop === 'function') monitor.stop();
    } catch {
      // Best-effort: never fail a CLI return because of loop teardown.
    }
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

      // Conductor liveness: verify ownership (token/epoch+frescor) and
      // heartbeat periodically. An old leader whose epoch no longer matches
      // (takeover bumped it) is rejected here and steps down — never drives.
      // Skipped until this instance claims (unit fakes never claim).
      if (this.conductorToken !== undefined || this.conductorEpoch !== undefined) {
        const stillOwner = await this.heartbeatConductor(plan.id, repoRoot);
        if (!stillOwner) {
          console.warn(`[MC] conductor fencing: pid ${process.pid} no longer owns plan ${plan.id} (epoch ${this.conductorEpoch}) — stepping down.`);
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          return;
        }
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

      // B2: auto-recovery before dispatch — failed-infra jobs with budget
      // left re-enter as queued/waiting_deps so this pass drives a real
      // retry (a resume with zero attempts is the §7.5 stall). Functional
      // failures stay failed (visible, need a fix, never silently retried).
      try {
        await this.requeueInfraFailures(plan, byName);
      } catch {}

      // B3-deadlock: cura failed-já-integrado antes do despacho (evidência
      // PASS no mesmo commit + conteúdo contido na integration → merged
      // terminal, sem re-review, sem exigir pause). Desbloqueia dependentes
      // no mesmo passe.
      try {
        const healed = await this.healAlreadyIntegratedFailures(plan);
        if (healed.length > 0) {
          this.notify(`🩹 Healed ${healed.length} job(s) already integrated: ${healed.join(', ')} (failed→merged, no re-review).`);
        }
      } catch {}

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

        const dispatched = await this.launchJob(job);
        if (dispatched === false) {
          // B2: launchJob persists failed + syncs the in-memory job, never
          // counts as running — the next pass (or requeue budget) owns it.
          job.status = 'failed';
          continue;
        }
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

        // B4: a failed earlier sibling never blocks an independent job
        // (deps still gate: a dependent of the failed job stays put).
        if (!canMergeJobNow(mergeOrder, job.name)) {
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
        // R01: a head job whose correction worker is still fixing (status left
        // 'running' by an autonomous review fix) must not be re-reviewed yet —
        // defer this pass; reverification happens when it reports again.
        const headNow = byName.get(nextJob.name) ?? nextJob;
        if (headNow.status !== 'merging' && headNow.status !== 'ready_to_merge') {
          return;
        }
        this.showToast('Mission Control', `Merging job "${nextJob.name}"...`, 'info');
        this.notify(`⇄ Merging job "${nextJob.name}" into integration branch...`);
        // Per-task gate is structural-only (diff pins via
        // reviewJobWithFixLoop) — never a repo-wide probe pre-merge
        // (deterministic fail without the job's own change; anchors can
        // never match runner stdout verbatim). The repo-wide gate runs once
        // post-all-merged (final verification, fail-closed).
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
          // R01: autonomous correction dispatched (worker re-oriented, bounded
          // attempts left) — defer the merge WITHOUT pausing. Escalations
          // (reserved/no-progress/exhausted) fall through to the pause below.
          if (this.lastReviewAutoFix === nextJob.name) {
            const current = byName.get(nextJob.name);
            if (current) current.status = 'running';
            this.showToast('Mission Control', `Job "${nextJob.name}" review failed — correction dispatched.`, 'warning');
            this.notify(`🔧 Job "${nextJob.name}" failed functional review; a correction worker was dispatched (bounded fix loop, no pause). Merge deferred until it reports again.`);
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
              // Per-merge repo-wide runs would fail deterministically on
              // missing not-yet-merged siblings even with correct workers:
              // always skip here; the global gate runs once post-all-merged
              // (final verification, fail-closed).
              { skipTest: true },
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
          // Conductor progress: a merge proves work advanced (periodic proof).
          await this.progressConductor(plan.id, repoRoot);
          // F09: conserve product-observed evidence for the final report.
          // R05 trail: the per-merge write carries merge metadata only. When
          // the merge ran with skipTest (no repo-wide run here), verification
          // fields are omitted so the earlier task-scoped pass/scope is never
          // downgraded to skipped by this write (guarded in saveMergeEvidence
          // too). The global integration gate writes its own scope below.
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
              ...(tr?.command !== undefined ? { testCommand: tr.command } : {}),
              ...(tr?.status !== undefined ? { testStatus: tr.status } : {}),
              ...(tr?.output !== undefined ? { testOutput: tr.output } : {}),
              ...(tr?.setup?.commands !== undefined ? { setupCommands: tr.setup.commands } : {}),
              ...(tr?.setup?.status !== undefined ? { setupStatus: tr.setup.status } : {}),
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
          // §4 identidade: verificação final também roda no snapshot imutável —
          // mutação/A→B→A no worktree durante o run falha, nunca é atribuída.
          const verifyResult = await this.runImmutableRetest(verifyWorktree, verifyCommand, verifyTimeout);
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
          // commands/outputs instead of empties. R05: this run is INTEGRATION
          // evidence — it never promotes a job to Verified and never erases
          // task-scoped pins (merge by field). Jobs already verified by their
          // task-scoped review keep that evidence untouched.
          try {
            const { loadMergeEvidence } = await import('./durable-state');
            const existing = await loadMergeEvidence().catch(() => ({}));
            for (const job of latestPlan.jobs) {
              const prev = (existing as Record<string, { testStatus?: string; scope?: string }>)[job.name];
              if (prev && prev.testStatus === 'passed' && prev.scope === 'task') continue;
              await saveMergeEvidence({
                jobName: job.name,
                mergedAt: job.mergedAt ?? new Date().toISOString(),
                testCommand: verifyCommand,
                testStatus: 'passed',
                testOutput: verifyResult.output || undefined,
                scope: 'integration',
              }).catch(() => {});
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

  private async launchJob(job: JobSpec): Promise<boolean> {
    const planId = this.activePlanId;
    if (!planId) {
      throw new Error('No active plan for job launch');
    }

    // Coerência pré-despacho: bloqueia ANTES do claim/worktree/prompt, sem
    // despachar. Diagnóstico pede ampliar touchSet ou mover o teste p/ job
    // dependente. Claim atômico continua primeiro entre recursos.
    try {
      this.assertJobCoherent(job);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updatePlanJob(planId, job.name, {
        status: 'failed',
        error: `dispatch blocked (incoherent touchSet/acceptance): ${msg}`,
      }, { force: true }, this.effectiveRepoRoot()).catch(() => {});
      return false;
    }

    const placement = this.planPlacement ?? this.config.defaultPlacement ?? 'session';
    const shortPlanId = planId ? planId.slice(0, 8) : '';
    const branch = job.branch ?? `mc/plan/${shortPlanId}/${job.name}`;
    const mode = job.mode ?? this.config.omo?.defaultMode ?? 'vanilla';
    const sanitizedName = job.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    // §7 + sonda 15: per-execution identity (serve AND TUI share the execTag
    // scope so parallel runs never collide by bare name).
    const useServe = shouldUseServeMode(this.config as { useServeMode?: boolean });
    const execTag = job.id ? formatExecTag(planId, job.id) : shortPlanId;
    const tmuxSessionName = execTag
      ? sessionNameForJob(sanitizedName, execTag)
      : `mc-${sanitizedName}`;
    const windowName = execTag ? `${sanitizedName}-${execTag}` : sanitizedName;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error('Window placement requires running inside tmux');
            }
            return `${currentSession}:${windowName}`;
          })();

    // Sonda 15: atomic dispatch claim BEFORE any resource exists. Loser aborts
    // without creating/killing anything (no tmux, no worktree, no prompt).
    const repoRoot = this.effectiveRepoRoot();
    const owner = this.planLaunchSessionID ?? `orchestrator-${process.pid}`;
    try {
      const claim = await claimJobForDispatch(planId, job.name, owner, repoRoot);
      if (!claim.ok) {
        if (claim.status === 'waiting_deps') {
          // waiting_deps is a legitimate dispatch state once deps are merged:
          // claim it atomically under the plan lock (same exclusivity).
          const won = await withPlanLock(async () => {
            const live = await loadPlan(repoRoot);
            const cur = live?.jobs.find((j) => j.name === job.name || j.id === job.id);
            if (!live || live.id !== planId || !cur) return false;
            if (cur.status !== 'waiting_deps') return false;
            cur.status = 'running';
            // Persist via updatePlanJob path (same lock re-entry is safe:
            // withFileLock serializes, nested call would deadlock — so write
            // directly here through the already-held lock).
            const { atomicWrite } = await import('./utils');
            const { join } = await import('path');
            const { getDataDir } = await import('./paths');
            const filePath = join(await getDataDir(repoRoot), 'plan.json');
            await atomicWrite(filePath, JSON.stringify(live, null, 2));
            return true;
          }, repoRoot).catch(() => false);
          if (!won) return false;
        } else {
          return false;
        }
      }
    } catch (e) {
      // Claim itself failed (no plan / unknown job): fail-closed without
      // creating anything; mark failed so the run never sticks queued.
      const msg = e instanceof Error ? e.message : String(e);
      // Already running means another driver won — quiet abort, no kill.
      if (/already|running/i.test(msg) && !/no active plan|not found|mismatch/i.test(msg)) return false;
      await updatePlanJob(planId, job.name, {
        status: 'failed',
        error: `dispatch claim failed: ${msg}`,
      }, { force: true }, repoRoot).catch(() => {});
      return false;
    }

    let worktreePath = '';
    let promptFilePath: string | undefined;
    let servePort: number | undefined;
    let servePassword: string | undefined;
    let createdTmuxTarget: string | undefined;
    // §8: register BEFORE the prompt so mc_report never sees "No active job".
    const jobId = randomUUID();
    let registered = false;
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
      // §6 unified launcher: serve (verified triple) is the autonomous path.
      // TUI only when useServeMode === false explicitly — always with an
      // explicit unpinned warning, never silently satisfying the model contract.
      const effective = this.ensureEffectiveModel();
      let serveUrl: string | undefined;
      let serveRemoteSessionID: string | undefined;
      let modelRequested: V2ModelRef | undefined;
      let modelObserved: V2ModelRef | undefined;

      // §8 registro antes do prompt: o worker existe no job-state antes de
      // poder reportar (addJob + updatePlanJob com running antes do launcher).
      const existingState = await loadJobState();
      const staleJobs = existingState.jobs.filter(
        (j) => j.name === job.name && j.status !== 'running',
      );
      for (const stale of staleJobs) {
        await removeReport(stale.id).catch(() => {});
        await removeJob(stale.id).catch(() => {});
      }
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
      registered = true;
      await updatePlanJob(planId, job.name, {
        status: 'running',
        branch,
        worktreePath,
        tmuxTarget,
      }, undefined, this.effectiveRepoRoot());

      if (useServe) {
        const activeJobs = await getRunningJobs().catch(() => []);
        servePort = await allocatePort(this.config, activeJobs);
        serveUrl = `http://127.0.0.1:${servePort}`;
        // Per-worker credential resolved BEFORE creating the session:
        // serve ALWAYS requires auth, so without this the wait below
        // could never succeed. Same value feeds launcher env + client,
        // and is persisted on the job below so reconnects reuse it.
        servePassword = resolveServePassword(
          (this.config as MCConfig & { serverPassword?: string }).serverPassword,
        );
        const serveLauncherPath = await writeServeLauncherScript(
          worktreePath,
          servePort,
          servePassword,
        );
        const { quoteShellPath } = await import('./sdk-client');
        const initialServeCommand = `bash ${quoteShellPath(serveLauncherPath)}`;
        if (placement === 'session') {
          await createSession({ name: tmuxSessionName, workdir: worktreePath, command: initialServeCommand });
        } else {
          await createWindow({ session: getCurrentSession()!, name: windowName, workdir: worktreePath, command: initialServeCommand });
        }
        createdTmuxTarget = tmuxTarget;
        await setPaneDiedHook(tmuxTarget, `run-shell "echo '${job.id}' >> .mission-control/completed-jobs.log"`);
        cleanupLauncherScript(worktreePath);
        const client = await v2WaitForServer(servePort, {
          password: servePassword,
        });
        const agentOpt = (job as unknown as { agent?: string }).agent;
        const worker = await launchWorkerViaServe(client, {
          worktree: worktreePath,
          prompt: jobPrompt,
          model: { ...effective },
          profile: {
            permissions: buildWorktreePermissions(worktreePath),
            title: job.name,
            ...(agentOpt ? { agent: agentOpt } : {}),
          },
          tmuxTarget,
        });
        // §5 fail-closed: sem pin observado nunca é sucesso silencioso.
        if (!worker.observedModel) {
          throw new Error(
            `[MC] serve worker without observed model pin — requested ${effective.providerID}/${effective.id} but server reported none. Fail-closed, never TUI silent.`,
          );
        }
        serveRemoteSessionID = worker.sessionId;
        modelRequested = worker.requestedModel ? { ...worker.requestedModel } : { ...effective };
        modelObserved = worker.observedModel ? { ...worker.observedModel } : undefined;
        // §5 perfil serve: /start-work via comando serve-nativo (sem sendKeys).
        if (mode === 'plan') {
          try {
            await v2RunCommand(client, worker.sessionId, '/start-work', '');
          } catch {
            // Best-effort: o prompt já orienta; falha do comando não invalida o pin.
          }
        }
        await updateJob(jobId, {
          ...(servePort !== undefined ? { port: servePort } : {}),
          ...(serveUrl !== undefined ? { serverUrl: serveUrl } : {}),
          ...(serveRemoteSessionID !== undefined ? { remoteSessionID: serveRemoteSessionID } : {}),
          ...(servePassword !== undefined ? { serverPassword: servePassword } : {}),
          ...(modelRequested ? { modelRequested: { ...modelRequested } } : {}),
          ...(modelObserved ? { modelObserved: { ...modelObserved } } : {}),
        }).catch(() => {});
      } else {
        const pin = describeTuiModelPin(effective);
        console.warn(`[MC] TUI launcher (unpinned model): requested ${pin.requested ?? 'none'} — ${pin.blockade}`);
        promptFilePath = await writePromptFile(worktreePath, jobPrompt);
        // F06: effective model once per execution — snapshot triple (variant preserved for serve).
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
            name: windowName,
            workdir: worktreePath,
            command: initialCommand,
          });
        }
        createdTmuxTarget = tmuxTarget;

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
      }

      await updatePlanJob(planId, job.name, {
        status: 'running',
        branch,
        worktreePath,
        tmuxTarget,
        ...(servePort !== undefined ? { port: servePort } : {}),
        ...(serveUrl !== undefined ? { serverUrl: serveUrl } : {}),
        ...(serveRemoteSessionID !== undefined ? { remoteSessionID: serveRemoteSessionID } : {}),
        ...(servePassword !== undefined ? { serverPassword: servePassword } : {}),
      }, undefined, this.effectiveRepoRoot());
      if (serveRemoteSessionID || modelRequested || modelObserved) {
        // Persistir pin no JobSpec quando o schema permitir (best-effort).
        await updatePlanJob(planId, job.name, {
          ...(serveRemoteSessionID !== undefined ? { remoteSessionID: serveRemoteSessionID } : {}),
        } as Partial<JobSpec>, undefined, this.effectiveRepoRoot()).catch(() => {});
      }
      return true;
    } catch (error) {
      if (promptFilePath) {
        cleanupPromptFile(promptFilePath, 0);
      }
      if (servePort !== undefined) {
        await releasePort(servePort).catch(() => {});
      }

      // §7 catch guard: só killar o que ESTA chamada criou (flag
      // createdTmuxTarget + filtro de posse). Falha antes de createSession
      // nunca mata homônima.
      try {
        if (createdTmuxTarget) {
          const owned = filterOwnedKillTargets([createdTmuxTarget], createdTmuxTarget);
          for (const cand of owned) {
            if (placement === 'session') {
              await killSession(cand);
            } else {
              const [session, window] = cand.split(':');
              if (session && window) {
                await killWindow(session, window);
              }
            }
          }
        }
      } catch {}

      if (worktreePath) {
        await this.removeJobWorktree(worktreePath, true).catch(() => {});
      }
      if (registered) {
        await removeJob(jobId).catch(() => {});
      }

      // B2: dispatch failure — the worker never started, so the error
      // carries the infra marker + attempt budget. Callers must NOT treat
      // this as launched (return false): the in-memory job stays failed so
      // this pass never counts it as running, and the reconciler can
      // requeue it (capped) via the public recovery path.
      const rawCause = error instanceof Error ? error.message : String(error);
      const consumed = parseDispatchAttempt(job.error);
      const attempt = Math.min(consumed + 1, MAX_DISPATCH_ATTEMPTS);
      const infraError = formatDispatchInfraError(rawCause, attempt);
      job.status = 'failed';
      job.error = infraError;
      await updatePlanJob(planId, job.name, {
        status: 'failed',
        error: infraError,
      }, { force: true }, this.effectiveRepoRoot());
      return false;
    }
  }

  async relaunchJobForCorrection(
    jobName: string,
    violations: string[],
    touchSetPatterns: string[],
    opts?: { functional?: { title: string; body: string } },
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

    // Coerência no relaunch: nunca reinjeta prompt contraditório em loop.
    // Se o plano continua incoerente (aceite exige arquivo fora do touchSet),
    // exige aceite revisado/replanejo com diagnóstico — NÃO relaunch cego.
    try {
      this.assertJobCoherent(job);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot relaunch correction for job "${jobName}": plan still incoherent — revise o aceite ou amplie o touchSet antes de relançar (replanejo necessário, não relaunch cego). ${msg}`,
      );
    }

    const placement = this.planPlacement ?? this.config.defaultPlacement ?? 'session';
    const mode = job.mode ?? this.config.omo?.defaultMode ?? 'vanilla';
    const sanitizedName = job.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    // R01 relaunch ownership: session per execution (plan+job ids), never the
    // bare job name that collides across projects/runs. The predecessor is
    // killed only through the recorded tmuxTarget (ownership marker) after a
    // has-session check — never an unrecorded same-name session.
    const execTag = formatExecTag(plan.id, job.id);
    const tmuxSessionName = sessionNameForJob(sanitizedName, execTag);
    const windowName = `${sanitizedName}-${execTag}`;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error('Window placement requires running inside tmux');
            }
            return `${currentSession}:${windowName}`;
          })();

    // Kill the predecessor session/window if still alive (ownership-checked).
    // §7: only the recorded predecessor is owned. The legacy bare name is
    // killed solely via explicit migration opt-in (never by mere existence),
    // so a foreign same-prefix session survives.
    try {
      const previousTarget = job.tmuxTarget;
      if (placement === 'session') {
        const owned = buildOwnedKillList({
          previousTarget,
          legacySessionName: `mc-${sanitizedName}`,
          allowLegacyFallback: false,
        });
        for (const cand of filterOwnedKillTargets(owned, previousTarget)) {
          let exists = false;
          try {
            exists = await sessionExists(cand);
          } catch {
            exists = false;
          }
          if (exists) await killSession(cand);
        }
      } else if (previousTarget) {
        // Strict equality with the recorded target — no prefix similarity.
        for (const cand of filterOwnedKillTargets([previousTarget], previousTarget)) {
          const [session, window] = cand.split(':');
          if (!session || !window) continue;
          let exists = false;
          try {
            exists = await windowExists(session, window);
          } catch {
            exists = false;
          }
          if (exists) await killWindow(session, window);
        }
      }
    } catch {
      // Predecessor may already be dead — that's fine
    }

    // Build correction prompt with context from the original task
    const correctionPrompt = opts?.functional
      ? `${opts.functional.title}\n\nThe previous task in this worktree was:\n"${job.prompt}"\n\n${opts.functional.body}`
      : `CORRECTION TASK — TouchSet Violation\n\n` +
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
    let relaunchPort: number | undefined;
    let createdRelaunchTarget: string | undefined;

    // Never silently reuse a dirty worktree: checkpoint visible (add+commit)
    // so the correction starts from a recorded state. Refuse when the
    // checkpoint itself fails. §4: permitted outputs (coverage + untracked
    // dist/build) never force a checkpoint — only relevant mutations do.
    const dirtyProbe = await gitCommand(['-C', worktreePath, 'status', '--porcelain']);
    if (dirtyProbe.exitCode !== 0) {
      throw new Error(
        `Cannot relaunch correction for job "${jobName}": cannot inspect worktree (${dirtyProbe.stderr || 'unknown'}) — refusing to reuse an unknown tree state`,
      );
    }
    if (filterRelevantDirtyEntries(parsePorcelainEntries(dirtyProbe.stdout)).length > 0) {
      const addRes = await gitCommand(['-C', worktreePath, 'add', '-A']);
      if (addRes.exitCode !== 0) {
        throw new Error(
          `Cannot relaunch correction for job "${jobName}": worktree has uncommitted changes and staging failed (${addRes.stderr || addRes.stdout}) — refusing to reuse a dirty worktree silently`,
        );
      }
      const checkpointRes = await gitCommand(
        ['-C', worktreePath, 'commit', '-m', `chore(${job.name}): checkpoint uncommitted work before correction relaunch`],
      );
      if (checkpointRes.exitCode !== 0) {
        throw new Error(
          `Cannot relaunch correction for job "${jobName}": worktree has uncommitted changes and the checkpoint commit failed (${checkpointRes.stderr || checkpointRes.stdout}) — refusing to reuse a dirty worktree silently`,
        );
      }
    }

    try {
      // §6: correction relaunches on the verified serve path by default,
      // preserving variant + auto-fix continuity (worker re-oriented on the
      // same worktree). TUI only on explicit opt-out, never silent.
      const useServeRelaunch = shouldUseServeMode(this.config as { useServeMode?: boolean });
      const effectiveRelaunch = this.ensureEffectiveModel();
      let relaunchUrl: string | undefined;
      let relaunchPassword: string | undefined;
      let relaunchRemoteSessionID: string | undefined;
      let relaunchRequested: V2ModelRef | undefined;
      let relaunchObserved: V2ModelRef | undefined;
      if (useServeRelaunch) {
        const activeJobs = await getRunningJobs().catch(() => []);
        relaunchPort = await allocatePort(this.config, activeJobs);
        relaunchUrl = `http://127.0.0.1:${relaunchPort}`;
        relaunchPassword = resolveServePassword(
          (this.config as MCConfig & { serverPassword?: string }).serverPassword,
        );
        const serveLauncherPath = await writeServeLauncherScript(
          worktreePath,
          relaunchPort,
          relaunchPassword,
        );
        const { quoteShellPath } = await import('./sdk-client');
        const initialServeCommand = `bash ${quoteShellPath(serveLauncherPath)}`;
        if (placement === 'session') {
          await createSession({ name: tmuxSessionName, workdir: worktreePath, command: initialServeCommand });
        } else {
          await createWindow({ session: getCurrentSession()!, name: windowName, workdir: worktreePath, command: initialServeCommand });
        }
        createdRelaunchTarget = tmuxTarget;
        await setPaneDiedHook(tmuxTarget, `run-shell "echo '${job.id}' >> .mission-control/completed-jobs.log"`);
        cleanupLauncherScript(worktreePath);
        const client = await v2WaitForServer(relaunchPort, {
          password: relaunchPassword,
        });
        const agentOpt = (job as unknown as { agent?: string }).agent;
        const worker = await launchWorkerViaServe(client, {
          worktree: worktreePath,
          prompt: fullPrompt,
          model: { ...effectiveRelaunch },
          profile: {
            permissions: buildWorktreePermissions(worktreePath),
            title: job.name,
            ...(agentOpt ? { agent: agentOpt } : {}),
          },
          tmuxTarget,
        });
        if (!worker.observedModel) {
          throw new Error(
            `[MC] serve relaunch without observed model pin — fail-closed, never TUI silent.`,
          );
        }
        relaunchRemoteSessionID = worker.sessionId;
        relaunchRequested = worker.requestedModel ? { ...worker.requestedModel } : { ...effectiveRelaunch };
        relaunchObserved = worker.observedModel ? { ...worker.observedModel } : undefined;
        if (mode === 'plan') {
          try {
            await v2RunCommand(client, worker.sessionId, '/start-work', '');
          } catch {}
        }
      } else {
        const pin = describeTuiModelPin(effectiveRelaunch);
        console.warn(`[MC] TUI relaunch (unpinned model): requested ${pin.requested ?? 'none'} — ${pin.blockade}`);
        promptFilePath = await writePromptFile(worktreePath, fullPrompt);
        const launcherPath = await writeLauncherScript(worktreePath, promptFilePath, effectiveRelaunch);

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
            name: windowName,
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
        ...(relaunchPort !== undefined ? { port: relaunchPort } : {}),
        ...(relaunchUrl !== undefined ? { serverUrl: relaunchUrl } : {}),
        ...(relaunchPassword !== undefined ? { serverPassword: relaunchPassword } : {}),
        ...(relaunchRemoteSessionID !== undefined ? { remoteSessionID: relaunchRemoteSessionID } : {}),
        ...(relaunchRequested ? { modelRequested: { ...relaunchRequested } } : {}),
        ...(relaunchObserved ? { modelObserved: { ...relaunchObserved } } : {}),
      });

      await updatePlanJob(plan.id, job.name, {
        status: 'running',
        tmuxTarget,
        error: undefined,
        ...(relaunchPort !== undefined ? { port: relaunchPort } : {}),
        ...(relaunchUrl !== undefined ? { serverUrl: relaunchUrl } : {}),
        ...(relaunchPassword !== undefined ? { serverPassword: relaunchPassword } : {}),
        ...(relaunchRemoteSessionID !== undefined ? { remoteSessionID: relaunchRemoteSessionID } : {}),
      });
    } catch (error) {
      if (promptFilePath) {
        cleanupPromptFile(promptFilePath, 0);
      }
      if (relaunchPort !== undefined) {
        await releasePort(relaunchPort).catch(() => {});
      }

      // §7 catch guard (relaunch): só killar o que ESTA chamada criou.
      try {
        if (typeof createdRelaunchTarget === 'string' && createdRelaunchTarget) {
          const owned = filterOwnedKillTargets([createdRelaunchTarget], createdRelaunchTarget);
          for (const cand of owned) {
            if (placement === 'session') {
              await killSession(cand);
            } else {
              const [session, window] = cand.split(':');
              if (session && window) {
                await killWindow(session, window);
              }
            }
          }
        }
      } catch {}

      throw new Error(
        `Failed to relaunch job "${jobName}" for correction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * B2: public recovery for dispatch-infra failures. A `failed` job whose
   * error carries the infra marker (worker never started) returns to the
   * dispatch pool as `queued` (deps satisfied) or `waiting_deps`, keeping
   * its attempt count in the diagnostic. Functional failures (review/test/
   * touchSet) are refused — they need a fix, not a requeue. The budget
   * (`MAX_DISPATCH_ATTEMPTS`) is enforced: exhausted attempts throw
   * instead of looping forever. Uses `force` because `failed → queued` is
   * a recovery transition outside the happy-path matrix.
   */
  async requeueFailedDispatch(jobName: string): Promise<string> {
    const repoRoot = this.effectiveRepoRoot();
    const plan = await loadPlan(repoRoot);
    if (!plan) throw new Error('No active plan');
    const job = plan.jobs.find((j) => j.name === jobName);
    if (!job) throw new Error(`Job "${jobName}" not found in plan`);
    if (job.status !== 'failed') {
      throw new Error(`Job "${jobName}" is not failed (current: ${job.status}) — nothing to requeue.`);
    }
    if (!isDispatchInfraError(job.error)) {
      throw new Error(`Job "${jobName}" did not fail on dispatch-infra — fix the cause and retry via the approval path instead.`);
    }
    const attempt = parseDispatchAttempt(job.error);
    if (attempt >= MAX_DISPATCH_ATTEMPTS) {
      throw new Error(`Job "${jobName}" exhausted its dispatch budget (${attempt}/${MAX_DISPATCH_ATTEMPTS}) — inspect the cause (${job.error ?? 'unknown'}) instead of looping.`);
    }
    const depsOk = (job.dependsOn ?? []).every((dep) => plan.jobs.find((j) => j.name === dep)?.status === 'merged');
    const target = depsOk ? 'queued' : 'waiting_deps';
    await updatePlanJob(plan.id, job.name, { status: target }, { force: true }, repoRoot);
    return `Job "${jobName}" requeued to ${target} (dispatch attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS} consumed; next failure advances the budget). Cause kept: ${job.error ?? 'unknown'}`;
  }

  /**
   * B2: reconciler-side auto-recovery. Requeues every `failed`-infra job
   * with budget left before this pass dispatches, so a `resume` drives a
   * real retry instead of stalling with zero attempts. Returns the names
   * requeued. Budget-exhausted and functional failures are left alone.
   */
  private async requeueInfraFailures(
    plan: PlanSpec,
    byName: Map<string, JobSpec>,
  ): Promise<string[]> {
    const requeued: string[] = [];
    const repoRoot = this.effectiveRepoRoot();
    for (const job of plan.jobs) {
      const current = byName.get(job.name) ?? job;
      if (current.status !== 'failed') continue;
      if (!isDispatchInfraError(current.error)) continue;
      if (parseDispatchAttempt(current.error) >= MAX_DISPATCH_ATTEMPTS) continue;
      const depsOk = (current.dependsOn ?? []).every((dep) => byName.get(dep)?.status === 'merged');
      const target = depsOk ? 'queued' : 'waiting_deps';
      try {
        await updatePlanJob(plan.id, current.name, { status: target }, { force: true }, repoRoot);
        current.status = target;
        requeued.push(current.name);
      } catch {
        // Best-effort: a lost race keeps the job failed (visible, not lost).
      }
    }
    return requeued;
  }

  /**
   * B3-deadlock: antes do despacho, cura jobs `failed` cujo conteúdo já está
   * integrado (evidência PASS no mesmo commit + contenção na integration).
   * Marca `merged` terminal (force: failed→merged é inválida no fluxo normal)
   * com decisão registrada, sem re-review e sem exigir pause. Dependentes com
   * deps satisfeitas desbloqueiam no mesmo passe (byName é a mesma referência).
   */
  private async healAlreadyIntegratedFailures(plan: PlanSpec): Promise<string[]> {
    const healed: string[] = [];
    const repoRoot = this.effectiveRepoRoot();
    let evidence: Record<string, { testStatus?: string; reviewedCommit?: string; changedFiles?: string[]; scope?: string }>;
    try {
      evidence = await loadMergeEvidence().catch(() => ({}));
    } catch {
      return [];
    }
    for (const job of plan.jobs) {
      if (job.status !== 'failed') continue;
      const rec = evidence[job.name];
      let check: { heal: boolean; reason: string };
      try {
        check = await shouldHealFailedAsMerged({
          repoRoot,
          integrationBranch: plan.integrationBranch,
          job: { name: job.name, branch: job.branch, touchSet: job.touchSet },
          evidence: rec ?? undefined,
        });
      } catch {
        continue;
      }
      if (!check.heal) continue;
      try {
        await updatePlanJob(plan.id, job.name, { status: 'merged', mergedAt: new Date().toISOString() }, { force: true }, repoRoot);
        job.status = 'merged';
        healed.push(job.name);
        try {
          const snap = await loadRuntimeSnapshot().catch(() => null);
          const intakeId = snap?.autoIntake?.id;
          if (intakeId) {
            await appendAutoDecision(intakeId, `reconcile healed ${job.name}: failed→merged (already integrated; ${check.reason})`).catch(() => {});
          }
        } catch {}
      } catch {
        // Best-effort: mantém failed visível em vez de perder o estado.
      }
    }
    return healed;
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
      // Idempotency guard: 'completed' is only reachable from 'running'
      // (matrix). A late/duplicate complete arriving after the gate moved
      // the job forward (ready_to_merge/merging/merged, or a failure/
      // terminal state) must never force an invalid transition nor
      // downgrade the job — just reconcile and return.
      try {
        const plan = await loadPlan();
        const current =
          plan && plan.id === planId
            ? plan.jobs.find((j) => j.name === job.name)?.status
            : undefined;
        if (current && current !== 'running') {
          await this.reconcile();
          return;
        }
      } catch {
        // Guard is best-effort; fall through to the write below so a
        // genuine completion is never silently dropped.
      }
      await updatePlanJob(planId, job.name, {
        status: 'completed',
      });
      await this.reconcile();
    })().catch((error) => {
      // A lost race (job moved past 'running' between guard and write)
      // surfaces as an invalid transition — benign, already reconciled
      // above on the next pass. Only log real failures.
      if (error instanceof Error && /Invalid job transition/.test(error.message)) {
        return;
      }
      console.error('Failed to reconcile completed job state:', error);
    });
  }

  private handleJobFailed = (job: Job): void => {
    if (job.planId && this.activePlanId && job.planId === this.activePlanId) {
      const planId = job.planId;
      const jobName = job.name;
      // True when the event was a stale/duplicate that must not disturb
      // the loop: the finally below must not stop the reconciler for it.
      let ignored = false;
      (async () => {
        // Idempotency guard: a late failure arriving after the gate moved
        // the job forward (ready_to_merge/completed/merging/merged) must
        // never downgrade it nor pause the plan. Terminal and rebase
        // states are likewise left alone; duplicates of 'failed' too.
        try {
          const plan = await loadPlan();
          const current =
            plan && plan.id === planId
              ? plan.jobs.find((j) => j.name === jobName)?.status
              : undefined;
          if (
            current === 'ready_to_merge' ||
            current === 'completed' ||
            current === 'merging' ||
            current === 'merged' ||
            current === 'failed' ||
            current === 'stopped' ||
            current === 'canceled' ||
            current === 'conflict' ||
            current === 'needs_rebase'
          ) {
            ignored = true;
            return;
          }
          if (current === 'queued' || current === 'waiting_deps') {
            // Recovery (same precedent as launch failure): queued/
            // waiting_deps → failed is not a valid transition, so force
            // it explicitly to keep a genuine pre-run worker failure
            // visible (plan pauses below) instead of stuck queued.
            await updatePlanJob(planId, jobName, {
              status: 'failed',
              error: 'job monitor reported failure',
            }, { force: true });
          } else {
            await updatePlanJob(planId, jobName, {
              status: 'failed',
              error: 'job monitor reported failure',
            });
          }
        } catch (error) {
          if (error instanceof Error && /Invalid job transition/.test(error.message)) {
            // Lost race: the job moved past a markable state between
            // guard and write — stale event, ignore fully (no pause).
            ignored = true;
            return;
          }
          // Legacy behavior: any other write error still pauses the plan
          // below (fail-closed) instead of silently dropping the failure.
        }

        const plan = await loadPlan();
        if (!plan || plan.id !== planId) {
          return;
        }

        this.showToast('Mission Control', `Job "${jobName}" failed. Plan paused.`, 'error');
        this.notify(`❌ Job "${jobName}" failed. Fix and retry with mc_plan_approve(checkpoint: "on_error", retry: "${jobName}").`);
        await this.setCheckpoint('on_error', plan, {
          jobName,
          failureKind: 'job_failed',
        });
      })()
        .catch(() => {})
        .finally(() => {
          if (ignored) {
            return;
          }
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
      // R04: stable identity + full entry BEFORE long ops — the pre-generate
      // record already carries request/repo/docs/contextDocs/config/model so
      // a crash during planner/base still resumes the complete entry, and the
      // id never changes after generation (intakeId pinned through retry).
      const stableId = randomUUID();
      const preNow = new Date().toISOString();
      await saveAutoIntake({
        id: stableId,
        request: enrichedInput.request,
        repo: repoRoot,
        targetBranch: enrichedInput.targetBranch,
        ceiling: Object.keys(validCeiling).length > 0 ? validCeiling : enrichedInput.ceiling,
        docs: enrichedInput.docs,
        contextDocs: loadedDocs,
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
        intakeId: stableId,
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
   * R04: the intake↔plan link (planId) is verified before driving anything;
   * completed is reported as terminal (never "reativado"); the awaiting-plan
   * regeneration replaces the pending requirements with the new draft.
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
          // R04: the regenerated draft REPLACES the pending requirements (never
          // keeps the empty pre-plan list while a plan exists for it).
          await saveAutoIntake({
            ...record!,
            planId: spec.id,
            requirements: draft.requirements.map((r) => ({ ...r })),
            decisions: [...(record!.decisions ?? []), ...draft.decisions],
            questions: [...(record!.questions ?? []), ...draft.questions],
            nextSteps: nextStepsFor(draft),
            status: 'running',
            updatedAt: now,
          }).catch(() => {});
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
      // R04: verify the intake↔plan link before driving anything — resuming
      // the wrong plan (stale disk state from another intake) is refused
      // explicitly instead of silently advancing it.
      if (record.planId && plan.id !== record.planId) {
        return [
          `Inconsistência: intake ${record.id} aponta para plano ${record.planId}, mas o disco tem plano ${plan.id} (nada despachado, nada reintegrado).`,
          `Verifique o repo ${record.repo ?? repoRoot} ou gere novamente.`,
          await this.autonomousProgress(record.id),
        ].join('\n');
      }
      // R04: completed is terminal — report it as completed, never as
      // "reativado". There is no conductor to restart for a finished run.
      if (beforeStatus === 'completed') {
        await appendAutoDecision(record.id, `resume on completed plan ${plan.id}: terminal, no conductor restarted`).catch(() => {});
        const progress = await this.autonomousProgress(record.id);
        return [`Concluído: plano ${plan.id} já está completed (terminal, nada a reativar, nada duplicado).`, progress].join('\n');
      }
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
   * R02: complement triggers a real plan revision via the model (same slot as
   * intake) WITH the original entry (request/target/ceiling/context docs):
   * new requirements persist as a version; same-name tasks with changed
   * content change the work (reoriented in place when not started, linked
   * correction task when delivered — never silently ignored); new
   * tasks/corrections go through existing paths
   * (addJob/applyModelAdjustment); pending proposals persist as open
   * questions that block acceptance. Pause/decisions are preserved. Never
   * announces the scheduler before scheduling.
   */
  async complementAutonomousRequest(
    intakeId: string,
    text: string,
    generate?: PlannerGenerate,
  ): Promise<{ added: string[]; updated: string[]; message: string }> {
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
        return { added: [], updated: [], message: `Complement recorded on intake ${intakeId} (no plan yet, nothing rebuilt).` };
      }
      const paused = plan.status === 'paused' || !!plan.checkpoint;
      if (paused) {
        // Free content recorded as a question; the pause/decision stands.
        await appendAutoQuestion(intakeId, followUp).catch(() => {});
        return {
          added: [],
          updated: [],
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
          updated: [],
          message: `Complement recorded on intake ${intakeId} (reconciler active, no model revision without generate).`,
        };
      }
      // R02: the revision sees the ORIGINAL entry — updated request, target,
      // ceiling AND the loaded context docs — never just the follow-up text.
      // Same-name tasks with changed content change the work (reorient when
      // not started, linked correction when delivered); nothing is ignored.
      const ctxDocs = record!.contextDocs ?? [];
      const input: AutoIntakeInput = {
        request: updatedRequest,
        repo: repoRoot,
        targetBranch: record!.targetBranch,
        ceiling: record!.ceiling,
        ...(ctxDocs.length > 0 ? { docs: ctxDocs.map((d) => d.content) } : {}),
      };
      const { draft } = await runAutoIntakeWithRetry(input, generate, { maxAttempts: 3, baseDelayMs: 1000 });
      const live = (await loadPlan(repoRoot)) ?? plan;
      const byName = new Map(live.jobs.map((j) => [j.name, j]));
      const added: string[] = [];
      const updated: string[] = [];
      let needsUser = 0;
      const promptCore = (prompt: string): string =>
        prompt.includes('\n\nAcceptance criteria:')
          ? prompt.split('\n\nAcceptance criteria:')[0].trim()
          : prompt.trim();
      const acceptanceBlock = (prompt: string): string =>
        prompt.includes('\n\nAcceptance criteria:')
          ? prompt.split('\n\nAcceptance criteria:')[1]
          : '';
      for (const t of draft.tasks) {
        const current = byName.get(t.name);
        if (!current) {
          // New task: existing path (validated, autonomous or question).
          const res = await this.applyModelAdjustment(
            { action: 'add_task', task: { ...t }, reason: followUp },
            { intakeId },
          ).catch((e) => ({ route: 'needs-user' as const, message: e instanceof Error ? e.message : String(e) }));
          if (res.route === 'autonomous') {
            added.push(t.name);
            const created = (await loadPlan(repoRoot).catch(() => null))?.jobs.find((j) => j.name === t.name);
            if (created) byName.set(t.name, created);
          } else needsUser += 1;
          continue;
        }
        // Same name: compare work content (prompt core + acceptance + deps).
        const samePrompt = promptCore(current.prompt) === t.prompt.trim();
        const currentAcceptance = acceptanceBlock(current.prompt)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^-\s*\[\s*\]\s+/.test(l))
          .map((l) => l.replace(/^-\s*\[\s*\]\s+/, '').trim())
          .filter((l) => l.length > 0);
        const nextAcceptance = t.acceptance.map((a) => a.trim()).filter((a) => a.length > 0);
        // Set equality BOTH ways: adding AND removing a criterion change the
        // work. A one-way subset check silently drops removals (the draft
        // without the criterion still matches) and the loop skips the update.
        const sameAcceptance =
          currentAcceptance.length === nextAcceptance.length &&
          nextAcceptance.every((a) => currentAcceptance.includes(a));
        const sameDeps =
          JSON.stringify([...(current.dependsOn ?? [])].sort()) ===
          JSON.stringify([...(t.dependsOn ?? [])].sort());
        if (samePrompt && sameAcceptance && sameDeps) continue;
        if (current.status === 'queued' || current.status === 'waiting_deps') {
          // Not started: reorient in place (new prompt/acceptance/deps).
          const newPrompt =
            `${t.prompt.trim()}\n\nAcceptance criteria:\n` +
            t.acceptance.map((a) => `- [ ] ${a}`).join('\n');
          await updatePlanJob(live.id, current.name, {
            prompt: newPrompt,
            dependsOn: t.dependsOn?.length ? [...t.dependsOn] : undefined,
            ...(t.touchSet?.length ? { touchSet: [...t.touchSet] } : {}),
          }, undefined, repoRoot);
          current.prompt = newPrompt;
          current.dependsOn = t.dependsOn?.length ? [...t.dependsOn] : undefined;
          if (t.touchSet?.length) current.touchSet = [...t.touchSet];
          await appendAutoDecision(intakeId, `complement reoriented not-started task "${t.name}" (prompt/acceptance updated before start)`).catch(() => {});
          updated.push(t.name);
          continue;
        }
        // Started/delivered: linked correction task (never rewrites history).
        let correctionName = `${t.name}-correction`;
        let suffix = 2;
        while (byName.has(correctionName)) correctionName = `${t.name}-correction-${suffix++}`;
        const res = await this.applyModelAdjustment(
          {
            action: 'add_task',
            task: { ...t, name: correctionName, dependsOn: [t.name, ...(t.dependsOn ?? [])] },
            reason: `${followUp} (correction for delivered task "${t.name}")`,
          },
          { intakeId },
        ).catch((e) => ({ route: 'needs-user' as const, message: e instanceof Error ? e.message : String(e) }));
        if (res.route === 'autonomous') {
          added.push(correctionName);
          const created = (await loadPlan(repoRoot).catch(() => null))?.jobs.find((j) => j.name === correctionName);
          if (created) byName.set(correctionName, created);
        } else needsUser += 1;
      }
      // Deps adjustments for existing tasks (functional change without new tasks).
      const depMap: Record<string, string[]> = {};
      let depsChanged = false;
      for (const t of draft.tasks) {
        if (!byName.has(t.name)) continue;
        const cur = byName.get(t.name)?.dependsOn ?? [];
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
      await appendAutoDecision(intakeId, `complement revision: ${draft.requirements.length} requirements, +${added.length} tasks, ~${updated.length} reoriented${needsUser ? `, ${needsUser} needs-user` : ''}`).catch(() => {});
      // Ensure the loop is alive only after scheduling (never announce before).
      try {
        const latest = await loadPlan(repoRoot);
        if (latest && (latest.status === 'running' || latest.status === 'merging' || latest.status === 'pending') && !this.isRunning) {
          this.startReconciler();
        }
      } catch {}
      const reconciled = this.isRunning ? 'reconciler active' : 'reconciler will advance on next pass';
      const effect = [
        ...(added.length > 0 ? [`added ${added.length} task(s) [${added.join(', ')}]`] : []),
        ...(updated.length > 0 ? [`reoriented ${updated.length} not-started task(s) [${updated.join(', ')}]`] : []),
      ].join(', ');
      if (effect) {
        return { added, updated, message: `Complement revised plan: ${effect} (${reconciled}).` };
      }
      if (needsUser > 0) {
        return { added, updated, message: `Complement recorded as human decision (${needsUser} proposal(s) need review, kept as open questions blocking acceptance, ${reconciled}).` };
      }
      return { added, updated, message: `Complement noted: requirements version persisted (${draft.requirements.length}), no new tasks (${reconciled}).` };
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
          const password = resolveJobPassword(sourceJob, this.config.serverPassword);
          if (!password) {
            throw new Error(
              `[MC] fork of job "${sourceJob.name}" needs its serve password (job or config) — fail-closed, never unauthenticated.`,
            );
          }
          const client = createV2Client(sourceJob.port, password);
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
          // Same serve instance, same credential: carry it so the forked
          // job's own reconnects (monitor poll, relay) auth correctly.
          newJob.serverPassword = password;
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
        // Checkpoint do operador preservado até approve explícito: resume só
        // re-ancora a identidade em memória (sem despachar — o reconciliador
        // retorna cedo em pausa, e nenhum driver é iniciado aqui). Limpar a
        // pausa aqui divergiria da mensagem ("aguarda decisão") e fecharia o
        // caminho público de correção (approve exige paused).
        this.checkpoint = plan.checkpoint ?? null;
        this.activePlanId = plan.id;
        this.planPlacement = plan.placement ?? null;
        this.planLaunchSessionID = plan.launchSessionID;
        this.mergeTrain = new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());
        return;
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
      // Conductor lease on boot (resume path): this process proves assumption.
      // Best-effort so unit fakes keep working; handoff verifies by re-read.
      await this.claimConductorOwnership(plan.id, `resume plan ${plan.id}`, 'orchestrator-resume', repoRoot);
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

  private jobAcceptanceCriteria(job: JobSpec): string[] {
    const lines = (job.prompt ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^-\s*\[\s*\]\s+/.test(l))
      .map((l) => l.replace(/^-\s*\[\s*\]\s+/, '').trim())
      .filter((l) => l.length > 0);
    return [...new Set(lines)];
  }

  private assertJobCoherent(job: JobSpec): void {
    const acceptance = this.jobAcceptanceCriteria(job);
    if (acceptance.length === 0) return;
    validateTaskCoherence({ name: job.name, acceptance, touchSet: job.touchSet, dependsOn: job.dependsOn });
  }

  /**
   * Immutable retest: runs the command in a `git archive` snapshot copy and
   * refuses attribution when the ORIGINAL was touched during the run
   * (hash+mtime+ctime). Identity fail → success=false with the reason in
   * output, never a pass. Scope defaults to tracked files (ls-files).
   */
  private async runImmutableRetest(
    dir: string,
    command: string,
    timeoutMs: number,
    scopePaths?: string[],
    jobHead?: string,
  ): Promise<{ success: boolean; output: string; timedOut: boolean }> {
    let scope = scopePaths?.filter((p) => p !== '' && !p.includes('..')) ?? [];
    if (scope.length === 0) {
      try {
        const ls = await gitCommand(['-C', dir, 'ls-files']);
        if (ls.exitCode === 0) {
          scope = ls.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 200);
        }
      } catch {
        scope = [];
      }
    }
    try {
      const r = await runTestsOnImmutableSnapshot({
        dir,
        scopePaths: scope,
        testCommand: command,
        timeoutMs,
        ...(jobHead ? { jobHead } : {}),
      });
      if (r.verdict === 'fail') {
        return { success: false, output: `${r.reason ?? 'identity refused'}${r.output ? `\n${r.output}` : ''}`.slice(0, 8000), timedOut: r.timedOut };
      }
      return { success: r.success, output: r.output, timedOut: r.timedOut };
    } catch (error) {
      // Fail-closed on snapshot failure (no silent unprotected rerun): surface
      // as test failure so the caller pauses instead of merging unverified.
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `immutable snapshot failed: ${msg}`.slice(0, 2000), timedOut: false };
    }
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

    // Coerência pré-despacho: aceite fora do touchSet bloqueia o plano aqui,
    // antes do primeiro launch (diagnóstico pede ampliar touchSet ou mover
    // o teste p/ job dependente).
    for (const job of spec.jobs) {
      this.assertJobCoherent(job);
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
