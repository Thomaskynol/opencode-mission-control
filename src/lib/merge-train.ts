import { join, dirname } from 'path';
import { existsSync, lstatSync, rmSync } from 'fs';
import type { JobSpec } from './plan-types';
import { gitCommand } from './git';
import { getIntegrationWorktree, withIntegrationLock } from './integration';
import { extractConflicts } from './utils';
import { createV2Client, v2Prompt } from './sdk-client';
import type { ReviewVerdict } from './reviewer';
import {
  verifyMergeFencing,
  type MergeFencingIdentity,
} from './plan-state';

export type MergeResult
  = | { success: true; mergedAt: string; testReport: MergeTestReport }
  | {
      success: false;
      type: 'conflict' | 'test_failure' | 'review_blocked';
      files?: string[];
      output?: string;
      testReport?: MergeTestReport;
    };

type MergeSetupReport = {
  status: 'passed' | 'failed' | 'skipped' | 'env-failure';
  commands: string[];
  output?: string;
};

export type MergeTestReport = {
  status: 'passed' | 'failed' | 'skipped' | 'env-failure';
  command?: string;
  output?: string;
  timedOut?: boolean;
  reason?: string;
  setup: MergeSetupReport;
};

export type MergeTrainConfig = {
  testCommand?: string;
  testTimeout?: number;
  mergeStrategy?: 'squash' | 'ff-only' | 'merge';
  setupCommands?: string[];
  fixBeforeRollbackTimeout?: number;
  /**
   * M4: post-integration regression command, run after the main test
   * command passes. Failure rolls back the merge like a test failure.
   */
  regressionCommand?: string;
  /**
   * M4: when true, processNext() refuses to merge without an explicit
   * reviewer verdict=pass. Default false to preserve legacy callers.
   */
  requireReviewPass?: boolean;
};

const DEFAULT_TEST_TIMEOUT_MS = 600000;
const DEFAULT_FIX_BEFORE_ROLLBACK_TIMEOUT_MS = 120000;

const INSTALL_COMMAND_BY_LOCKFILE = [
  { file: 'bun.lockb', command: 'bun install --frozen-lockfile' },
  { file: 'bun.lock', command: 'bun install --frozen-lockfile' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
] as const;



/**
 * Single touchSet pattern matcher shared by merge-train validation,
 * reviewer scope checks and auto-plan coherence: trailing slash means
 * "this directory and everything inside it" (`src/` = `src/**`).
 */
export function matchesTouchPattern(pattern: string, file: string): boolean {
  // Paridade com auto-plan/coordinator (normalizeCoherencePath,
  // touchPatternsOverlap): "./" inicial não muda o caminho — sem isso
  // planning aceita e validateTouchSet/reviewer rejeitam o mesmo scope.
  const unprefixed = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  const normalized = unprefixed.endsWith('/') ? `${unprefixed}**` : unprefixed;
  return new Bun.Glob(normalized).match(file);
}

const OVERLAP_GLOB_CHARS = /[*?{\[]/;

/**
 * R2 fencing identity for merges: the orchestrator threads its conductor
 * token/epoch/pid here and processNext re-reads the lease FRESH immediately
 * before every git effect (merge, commit, rollback). A stale holder is
 * refused with no effect. Unmanaged use (no identity anywhere) is allowed
 * only when no conductor lease governs the branch — production always wires
 * identity via setFencing/forPlan/per-call opts.
 */
export type MergeFencing = MergeFencingIdentity;

const INTEGRATION_WORKTREE_PREFIX = 'mc-integration-';

/**
 * Best-effort scope recovery for direct callers: a real integration
 * worktree path embeds `<xdg>/<projectId>/mc-integration-<planId>`, so the
 * governing lease (and its planId) are resolvable without the caller
 * knowing the repo root. Returns null for unmanaged paths (unit tests,
 * legacy callers) — those stay allowed unless a lease is found via an
 * explicit identity.
 */
function derivePlanScopeFromWorktree(worktreePath: string): { planId: string; dataDir: string } | null {
  const base = worktreePath.replace(/\/+$/, '').split('/').pop() ?? '';
  if (!base.startsWith(INTEGRATION_WORKTREE_PREFIX) || base.length === INTEGRATION_WORKTREE_PREFIX.length) {
    return null;
  }
  return {
    planId: base.slice(INTEGRATION_WORKTREE_PREFIX.length),
    dataDir: join(dirname(worktreePath), 'state'),
  };
}

/**
 * Concrete witness for a touchSet pattern: every glob token replaced by a
 * fixed probe segment, so the OTHER pattern can be tested against it with
 * the canonical matchesTouchPattern. A witness matching the other pattern
 * proves real overlap (glob×glob, dir×file); no match either direction
 * proves disjointness for the covered shapes (e.g. `src/*.js` × `src/*.ts`).
 */
function witnessForPattern(pattern: string): string {
  const base = pattern.endsWith('/') ? `${pattern}**` : pattern;
  return base
    .replace(/\*\*/g, '__probe__/deep')
    .replace(/\{([^{}]*)\}/g, (_, inner: string) => (inner.split(',')[0] ?? '').trim() || '__probe__')
    .replace(/\[[^\]]*\]/g, 'a')
    .replace(/\*/g, '__probe__')
    .replace(/\?/g, 'p');
}

/**
 * R5 segment×segment intersection for the supported glob subset. Returns
 * false ONLY for provably disjoint segments (literal mismatch, conflicting
 * literal prefix/suffix, or disjoint fixed lengths). Anything uncertain
 * (braces, classes, `*` with compatible anchors) returns true — the caller
 * treats uncertainty as overlap (fail-closed: serialize with dependsOn).
 */
function globLengthRange(seg: string): [number, number] {
  let min = 0;
  let max = 0;
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    if (c === '*') {
      max = Number.POSITIVE_INFINITY;
      i += 1;
    } else if (c === '?') {
      min += 1;
      if (max !== Number.POSITIVE_INFINITY) max += 1;
      i += 1;
    } else if (c === '[') {
      const close = seg.indexOf(']', i + 1);
      min += 1;
      if (max !== Number.POSITIVE_INFINITY) max += 1;
      i = close === -1 ? seg.length : close + 1;
    } else if (c === '{') {
      // Brace alternatives: bound by the shortest/longest arm (best effort).
      const close = seg.indexOf('}', i + 1);
      const arms = close === -1 ? [''] : seg.slice(i + 1, close).split(',');
      const lens = arms.map((arm) => arm.replace(/\*/g, '').length);
      const armMin = Math.min(...lens);
      const armMax = arms.some((arm) => arm.includes('*')) ? Number.POSITIVE_INFINITY : Math.max(...lens);
      min += armMin;
      if (max !== Number.POSITIVE_INFINITY) {
        max = armMax === Number.POSITIVE_INFINITY ? armMax : max + armMax;
      }
      i = close === -1 ? seg.length : close + 1;
    } else {
      min += 1;
      if (max !== Number.POSITIVE_INFINITY) max += 1;
      i += 1;
    }
  }
  return [min, max];
}

function literalPrefix(seg: string): string {
  return seg.split(/[*?{\[]/)[0] ?? '';
}

function literalSuffix(seg: string): string {
  const parts = seg.split(/[*?{\]}]/);
  return parts[parts.length - 1] ?? '';
}

function segmentMayOverlap(a: string, b: string): boolean {
  if (a === b || a === '**' || b === '**') return true;
  const ga = OVERLAP_GLOB_CHARS.test(a);
  const gb = OVERLAP_GLOB_CHARS.test(b);
  if (!ga && !gb) return false;
  const [minA, maxA] = globLengthRange(a);
  const [minB, maxB] = globLengthRange(b);
  if (maxA < minB || maxB < minA) return false;
  const preA = literalPrefix(a);
  const preB = literalPrefix(b);
  if (preA && preB && !preA.startsWith(preB) && !preB.startsWith(preA)) return false;
  const sufA = literalSuffix(a);
  const sufB = literalSuffix(b);
  if (sufA && sufB && !sufA.endsWith(sufB) && !sufB.endsWith(sufA)) return false;
  return true;
}

function splitOverlapPattern(p: string): string[] {
  return (p.endsWith('/') ? `${p}**` : p).split('/');
}

/**
 * Pattern×pattern intersection over segment sequences (`**` spans segments).
 * Exact for the supported subset; conservative (true) wherever the segment
 * analysis cannot prove disjointness.
 */
function patternsMayOverlap(a: string, b: string): boolean {
  const A = splitOverlapPattern(a);
  const B = splitOverlapPattern(b);
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = `${i},${j}`;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r = false;
    if (i === A.length && j === B.length) r = true;
    else if (i === A.length) r = B.slice(j).every((s) => s === '**');
    else if (j === B.length) r = A.slice(i).every((s) => s === '**');
    else if (A[i] === '**') r = go(i + 1, j) || go(i, j + 1);
    else if (B[j] === '**') r = go(i, j + 1) || go(i + 1, j);
    else r = segmentMayOverlap(A[i]!, B[j]!) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Canonical pattern×pattern overlap shared by plan coherence (auto-plan).
 * Conservative by design: a proven or plausible overlap returns true
 * (callers serialize / require dependsOn ordering); only provably disjoint
 * scopes return false. Never treats a bare suffix as equality — paths in
 * different directories (`src/total.js` × `other/src/total.js`) do NOT
 * overlap. A glob-free literal prefix still covers nested files (`src` ×
 * `src/total.js`), matching the directory intuition without weakening the
 * file-level matcher above.
 */
export function touchPatternsOverlap(a: string, b: string): boolean {
  const na = a.trim().replace(/^\.\//, '');
  const nb = b.trim().replace(/^\.\//, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (matchesTouchPattern(na, witnessForPattern(nb))) return true;
  if (matchesTouchPattern(nb, witnessForPattern(na))) return true;
  const sa = na.endsWith('/') ? na.slice(0, -1) : na;
  const sb = nb.endsWith('/') ? nb.slice(0, -1) : nb;
  if (!OVERLAP_GLOB_CHARS.test(na) && (sb === sa || sb.startsWith(sa + '/'))) return true;
  if (!OVERLAP_GLOB_CHARS.test(nb) && (sa === sb || sa.startsWith(sb + '/'))) return true;
  // R5: single-witness probes miss real intersections (`src/a*.ts` ×
  // `src/*b.ts` meet at `src/ab.ts`). The segment analysis above decides
  // the supported subset exactly; whatever it cannot prove disjoint stays
  // overlapping (fail-closed — callers demand dependsOn/widen/split).
  if (!patternsMayOverlap(na, nb)) return false;
  return true;
}

export async function validateTouchSet(
  jobBranch: string,
  baseBranch: string,
  touchSet: string[],
  opts?: { cwd?: string },
): Promise<{ valid: boolean; violations?: string[]; changedFiles?: string[] }> {
  const diffResult = await gitCommand(['diff', '--name-only', `${baseBranch}...${jobBranch}`], opts);
  if (diffResult.exitCode !== 0) {
    return { valid: false, violations: [`Failed to diff: ${diffResult.stderr}`] };
  }

  const changedFiles = diffResult.stdout.split('\n').map(f => f.trim()).filter(Boolean);
  if (changedFiles.length === 0) {
    return { valid: true, changedFiles: [] };
  }

  // No allow-all: a non-empty diff without a declared scope is a violation
  // (the job must declare which files it may touch).
  if (touchSet.length === 0) {
    return {
      valid: false,
      violations: [
        `touchSet declares no scope but the diff touches ${changedFiles.length} file(s): ${changedFiles.join(', ')} — declare the allowed scope in touchSet`,
      ],
      changedFiles,
    };
  }

  const violations: string[] = [];
  for (const file of changedFiles) {
    const matchesAny = touchSet.some((pattern) => matchesTouchPattern(pattern, file));
    if (!matchesAny) {
      violations.push(file);
    }
  }

  return {
    valid: violations.length === 0,
    violations: violations.length > 0 ? violations : undefined,
    changedFiles,
  };
}

export async function checkMergeability(
  integrationWorktree: string,
  jobBranch: string,
): Promise<{ canMerge: boolean; conflicts?: string[] }> {
  const testMerge = await gitCommand([
    '-C', integrationWorktree,
    'merge', '--no-commit', '--no-ff', jobBranch,
  ]);

  // Always clean up — leave worktree pristine
  await gitCommand(['-C', integrationWorktree, 'merge', '--abort']).catch(() => {});
  await gitCommand(['-C', integrationWorktree, 'reset', '--hard', 'HEAD']).catch(() => {});
  await gitCommand(['-C', integrationWorktree, 'clean', '-fd']).catch(() => {});

  if (testMerge.exitCode !== 0) {
    const conflicts = extractConflicts(
      [testMerge.stdout, testMerge.stderr].filter(Boolean).join('\n'),
    );
    return {
      canMerge: false,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  return { canMerge: true };
}

async function rollbackMerge(worktreePath: string): Promise<void> {
  // Try merge --abort first
  await gitCommand(['-C', worktreePath, 'merge', '--abort']).catch(() => {});

  // Always reset the index and working tree to be safe
  await gitCommand(['-C', worktreePath, 'reset', '--hard', 'HEAD']).catch(() => {});
  await gitCommand(['-C', worktreePath, 'clean', '-fd']).catch(() => {});
}

async function rollbackMergeToHead(worktreePath: string, targetHead: string): Promise<void> {
  // Try merge --abort first
  await gitCommand(['-C', worktreePath, 'merge', '--abort']).catch(() => {});

  // Reset to the target HEAD
  await gitCommand(['-C', worktreePath, 'reset', '--hard', targetHead]).catch(() => {});
  await gitCommand(['-C', worktreePath, 'clean', '-fd']).catch(() => {});
}

/**
 * M5/M7: detect the "nothing to commit" family of git errors. An empty
 * diff is valid for diagnosis — the merge is a no-op success, not a failure.
 */
function isEmptyCommitFailure(output: string): boolean {
  return /nothing to commit|empty commit|no changes added to commit/i.test(output);
}

export async function detectTestCommand(worktreePath: string): Promise<string | null> {
  try {
    const packageJsonFile = Bun.file(join(worktreePath, 'package.json'));
    if (!(await packageJsonFile.exists())) {
      return null;
    }

    const packageJson = JSON.parse(await packageJsonFile.text()) as {
      scripts?: Record<string, unknown>;
    };

    const testScript = packageJson.scripts?.test;
    return typeof testScript === 'string' && testScript.trim() !== ''
      ? testScript
      : null;
  } catch {
    return null;
  }
}

export async function detectInstallCommand(worktreePath: string): Promise<string | null> {
  try {
    for (const entry of INSTALL_COMMAND_BY_LOCKFILE) {
      const lockfile = Bun.file(join(worktreePath, entry.file));
      if (await lockfile.exists()) {
        return entry.command;
      }
    }

    const packageJsonFile = Bun.file(join(worktreePath, 'package.json'));
    if (!(await packageJsonFile.exists())) {
      return null;
    }

    const packageJson = JSON.parse(await packageJsonFile.text()) as {
      packageManager?: string;
    };
    const packageManager = packageJson.packageManager?.toLowerCase() ?? '';
    if (packageManager.startsWith('bun@')) {
      return 'bun install';
    }
    if (packageManager.startsWith('pnpm@')) {
      return 'pnpm install';
    }
    if (packageManager.startsWith('yarn@')) {
      return 'yarn install';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a test command in a worktree directory.
 *
 * Scope protection lives in the orchestrator (gatherScopeEvidence runs the
 * command on an immutable snapshot via runTestsOnImmutableSnapshot:
 * git archive → tmpdir, cwd=snapshot, original attested hash+mtime+ctime).
 * This function stays
 * raw on purpose so legitimate builds keep working: untracked dist/build
 * outputs, coverage/tmp/logs are writable outputs, never blocked here —
 * versioned dist modifications are refused upstream as identity failures.
 */
export async function runTestCommand(
  worktreePath: string,
  command: string,
  timeoutMs: number,
): Promise<{ success: boolean; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

  return {
    success: !timedOut && exitCode === 0,
    output,
    timedOut,
  };
}

function normalizeCommands(commands?: string[]): string[] {
  if (!commands) {
    return [];
  }
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function getNodeModulesStatus(worktreePath: string): 'present' | 'missing' | 'dangling_symlink' {
  const nodeModulesPath = join(worktreePath, 'node_modules');
  if (existsSync(nodeModulesPath)) {
    return 'present';
  }

  try {
    const stat = lstatSync(nodeModulesPath);
    if (stat.isSymbolicLink()) {
      return 'dangling_symlink';
    }
  } catch {}

  return 'missing';
}

async function ensureTestDependencies(
  worktreePath: string,
  timeoutMs: number,
  setupCommands?: string[],
): Promise<{
  success: boolean;
  output: string;
  timedOut: boolean;
  commands: string[];
  status: 'passed' | 'failed' | 'skipped' | 'env-failure';
}> {
  // Shared helper (F): same preparation as review snapshots. Deps go into a
  // copy for review; here the integration worktree already IS the copy under
  // test (tracked bytes attributed, untracked node_modules writable). When
  // preparation is impossible, fail closed as env-failure (never pass/skip).
  try {
    const { prepareTestEnv, ENV_UNPREPARED } = await import('./test-env.js');
    const prep = await prepareTestEnv({ snapshotDir: worktreePath, sourceDir: worktreePath, setupCommands, timeoutMs });
    if (prep.status === 'ready') {
      // Preserve legacy setup statuses: explicit setup/install → passed,
      // already-present/no-op → skipped. Both mean ready to run.
      if (prep.commands.length > 0) {
        return { success: true, output: prep.output, timedOut: false, commands: prep.commands, status: 'passed' };
      }
      return { success: true, output: prep.output, timedOut: false, commands: [], status: 'skipped' };
    }
    if (prep.status === 'failed') {
      return { success: false, output: prep.output, timedOut: false, commands: prep.commands, status: 'failed' };
    }
    return { success: false, output: prep.output || ENV_UNPREPARED, timedOut: false, commands: prep.commands, status: 'env-failure' };
  } catch {
    // Fall through to legacy path if helper unavailable (never pass silently).
  }
  const configuredSetupCommands = normalizeCommands(setupCommands);
  if (configuredSetupCommands.length > 0) {
    for (const command of configuredSetupCommands) {
      const setupResult = await runTestCommand(worktreePath, command, timeoutMs);
      if (setupResult.success) {
        continue;
      }

      const prefix = setupResult.timedOut
        ? `Dependency setup command timed out after ${timeoutMs}ms`
        : 'Dependency setup command failed';

      return {
        ...setupResult,
        commands: configuredSetupCommands,
        status: 'failed',
        output: setupResult.output
          ? `${prefix} (${command})\n${setupResult.output}`
          : `${prefix} (${command})`,
      };
    }

    return {
      success: true,
      output: '',
      timedOut: false,
      commands: configuredSetupCommands,
      status: 'passed',
    };
  }

  const installCommand = await detectInstallCommand(worktreePath);
  if (!installCommand) {
    return {
      success: true,
      output: '',
      timedOut: false,
      commands: [],
      status: 'skipped',
    };
  }

  const nodeModulesStatus = getNodeModulesStatus(worktreePath);
  if (nodeModulesStatus === 'present') {
    return {
      success: true,
      output: '',
      timedOut: false,
      commands: [],
      status: 'skipped',
    };
  }

  if (nodeModulesStatus === 'dangling_symlink') {
    rmSync(join(worktreePath, 'node_modules'), {
      force: true,
      recursive: true,
    });
  }

  const installResult = await runTestCommand(worktreePath, installCommand, timeoutMs);
  if (installResult.success) {
    return {
      ...installResult,
      commands: [installCommand],
      status: 'passed',
    };
  }

  const prefix = installResult.timedOut
    ? `Dependency install timed out after ${timeoutMs}ms`
    : 'Dependency install failed';

  return {
    ...installResult,
    commands: [installCommand],
    status: 'failed',
    output: installResult.output
      ? `${prefix} (${installCommand})\n${installResult.output}`
      : `${prefix} (${installCommand})`,
  };
}

/**
 * Demo-r5 root cause: the same commit compared in different formats
 * (short `--short` prefix vs full 40-char SHA) faked a base/job move.
 * A pin that is a prefix of the live SHA (either direction) is the
 * SAME commit. Minimum 4 chars: git never resolves a shorter prefix.
 * Exported so the orchestrator review path uses the same identity.
 */
export function isSameCommit(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 4) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export class MergeTrain {
  private queue: JobSpec[] = [];

  constructor(
    private readonly integrationWorktree: string,
    private readonly config?: MergeTrainConfig,
  ) {}

  static async forPlan(planId: string, config?: MergeTrainConfig, fencing?: Omit<MergeFencingIdentity, 'planId'>): Promise<MergeTrain> {
    const integrationWorktree = await getIntegrationWorktree(planId);
    const train = new MergeTrain(integrationWorktree, config);
    train.setFencing({ planId, ...fencing });
    return train;
  }

  /**
   * R2: thread the conductor identity to the point of effect. The
   * orchestrator calls this after claiming (and the per-call opts of
   * processNext override it when fresher). Without any identity the train
   * is unmanaged: allowed only when no conductor lease governs the branch.
   */
  setFencing(fencing?: MergeFencingIdentity): void {
    this.fencing = fencing;
  }

  private fencing?: MergeFencingIdentity;

  /**
   * R2 fresh gate: re-read the lease immediately before the effect. Runs
   * before the queue shift (refusal keeps the job queued for the rightful
   * owner), inside the integration lock before the merge, and again around
   * long operations — so a takeover during review/wait/test invalidates the
   * stale holder before any git or state effect.
   */
  private async checkFencingGate(fencing?: MergeFencingIdentity): Promise<MergeResult | null> {
    const explicit = fencing ?? this.fencing;
    const identity: MergeFencingIdentity | null = explicit ?? (() => {
      const derived = derivePlanScopeFromWorktree(this.integrationWorktree);
      return derived ? { planId: derived.planId, dataDir: derived.dataDir } : null;
    })();
    // No identity and no derivable scope: unmanaged/legacy use (unit tests,
    // direct callers with no conductor) — nothing governs this branch.
    if (!identity) return null;
    const check = await verifyMergeFencing(identity);
    if (check.ok) return null;
    return { success: false, type: 'review_blocked', output: `Review blocked: ${check.reason}` };
  }

  enqueue(job: JobSpec): void {
    // M5/M7 wiring: single queue with identifiers — retry/crash must not
    // duplicate the merge. A job already queued (same id or name) is a no-op.
    if (this.queue.some((queued) => queued.id === job.id || queued.name === job.name)) {
      return;
    }
    this.queue.push(job);
  }

  /** True when a job with this name is already queued (crash-retry guard). */
  has(jobName: string): boolean {
    return this.queue.some((queued) => queued.name === jobName);
  }

  getQueue(): JobSpec[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }

  async processNext(reviewVerdict?: ReviewVerdict | null, opts?: { skipTest?: boolean; fencing?: MergeFencing }): Promise<MergeResult> {
    // R2: fresh fencing BEFORE the queue shift — a refused stale holder
    // leaves the job queued for the rightful owner (no silent dequeue).
    const gate = await this.checkFencingGate(opts?.fencing);
    if (gate) {
      return gate;
    }

    if (this.queue.length === 0) {
      throw new Error('No jobs in queue');
    }

    const job = this.queue.shift()!;

    if (!job.branch) {
      return {
        success: false,
        type: 'test_failure',
        output: `Job ${job.name} has no branch`,
      };
    }

    const gateBlock = await this.checkReviewGate(job, reviewVerdict ?? null);
    if (gateBlock) {
      return gateBlock;
    }

    // M5/M7: serialize writers per integration branch; rollback stays inside.
    const fencing = opts?.fencing ?? this.fencing;
    return withIntegrationLock(this.integrationWorktree, () =>
      this.processNextInner(job, reviewVerdict ?? null, { ...opts, fencing }),
    );
  }

  /**
   * M4 reviewer gate (static part): without verdict=pass there is no merge.
   * Freshness (job HEAD / integration HEAD vs the reviewed pins) is
   * re-checked inside the lock in processNextInner.
   */
  private async checkReviewGate(job: JobSpec, verdict: ReviewVerdict | null): Promise<MergeResult | null> {
    if (!verdict) {
      if (this.config?.requireReviewPass) {
        return {
          success: false,
          type: 'review_blocked',
          output: `Review blocked: job "${job.name}" requires a reviewer verdict=pass before integration`,
        };
      }
      return null;
    }
    if (verdict.verdict !== 'pass' || verdict.blocking) {
      return {
        success: false,
        type: 'review_blocked',
        output: `Review blocked: job "${job.name}" verdict=fail: ${verdict.reasons.join('; ') || 'no reasons given'}`,
      };
    }
    return null;
  }

  /**
   * M4 freshness: an approval pins (reviewedCommit, reviewedBase). Any move
   * of the job branch or the integration HEAD invalidates it — re-review.
   * Must run inside the integration lock (TOCTOU otherwise).
   *
   * SHA normalization: pins may record a commit in short form
   * (`git rev-parse --short`, 7+ hex chars) while the live HEAD resolves
   * to the full 40-char SHA. A pin that is a prefix of the live SHA
   * (or vice versa) is the SAME commit — not a move. Strict `!==`
   * fakes a move (e.g. approved on `74a6958` vs integration at
   * `74a6958...`) and blocks the merge forever.
   */
  private async checkVerdictFreshness(
    job: JobSpec,
    verdict: ReviewVerdict,
    integrationHead: string,
  ): Promise<MergeResult | null> {
    if (verdict.verdict !== 'pass' || verdict.blocking) {
      return {
        success: false,
        type: 'review_blocked',
        output: `Review blocked: job "${job.name}" verdict=fail: ${verdict.reasons.join('; ') || 'no reasons given'}`,
      };
    }
    if (!isSameCommit(verdict.reviewedBase, integrationHead)) {
      return {
        success: false,
        type: 'review_blocked',
        output: `Review blocked: job "${job.name}" was approved on base ${verdict.reviewedBase} but integration is now at ${integrationHead} (base moved, re-review required)`,
      };
    }
    if (job.branch) {
      const jobHead = await gitCommand(['-C', this.integrationWorktree, 'rev-parse', job.branch]);
      if (jobHead.exitCode === 0 && !isSameCommit(jobHead.stdout.trim(), verdict.reviewedCommit)) {
        return {
          success: false,
          type: 'review_blocked',
          output: `Review blocked: job "${job.name}" was approved on commit ${verdict.reviewedCommit} but branch is now at ${jobHead.stdout.trim()} (job moved, re-review required)`,
        };
      }
    }
    return null;
  }

  /**
   * M4 optional post-integration regression: runs after the main test
   * command passes. Failure rolls back the merge like a test failure.
   * Returns a blocking MergeResult, or null when green/not configured.
   */
  private async runPostIntegrationRegression(
    timeoutMs: number,
    headBeforeStr: string,
  ): Promise<MergeResult | null> {
    const regressionCommand = this.config?.regressionCommand?.trim();
    if (!regressionCommand) {
      return null;
    }
    const regression = await runTestCommand(this.integrationWorktree, regressionCommand, timeoutMs);
    if (regression.success) {
      return null;
    }
    await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
    const reason = regression.timedOut
      ? `Regression timed out after ${timeoutMs}ms`
      : 'Regression failed';
    return {
      success: false,
      type: 'test_failure',
      output: regression.output
        ? `${reason} (${regressionCommand})\n${regression.output}`
        : `${reason} (${regressionCommand})`,
      testReport: {
        status: 'failed',
        command: regressionCommand,
        output: regression.output || undefined,
        timedOut: regression.timedOut || undefined,
        reason,
        setup: { status: 'skipped', commands: [] },
      },
    };
  }

  /**
   * B3: re-merge vazio do MESMO commit já verificado (verdict=pass nos pins
   * do commit atual) é no-op success mesmo em modo estrito — nunca um
   * `review_blocked` determinístico em loop. Sem verdict=pass no mesmo
   * commit, o bloqueio estrito permanece (F01).
   */
  private async isVerifiedSameCommitNoOp(job: JobSpec, verdict: ReviewVerdict | null): Promise<boolean> {
    if (!verdict || verdict.verdict !== 'pass' || verdict.blocking) return false;
    if (!verdict.reviewedCommit || !job.branch) return false;
    try {
      const live = await gitCommand(['-C', this.integrationWorktree, 'rev-parse', job.branch]);
      if (live.exitCode !== 0) return false;
      return isSameCommit(live.stdout.trim(), verdict.reviewedCommit);
    } catch {
      return false;
    }
  }

  private async processNextInner(job: JobSpec, reviewVerdict: ReviewVerdict | null, opts?: { skipTest?: boolean }): Promise<MergeResult> {

    // R2: re-read the lease inside the lock, immediately before the first
    // git effect — a takeover during the lock wait or the long review that
    // precedes processNext refuses here, before any merge/commit/rollback.
    const preMerge = await this.checkFencingGate(opts?.fencing);
    if (preMerge) {
      return preMerge;
    }

    // Save the HEAD before the merge so we can rollback if needed
    const headBeforeMerge = await gitCommand(['-C', this.integrationWorktree, 'rev-parse', 'HEAD']);
    const headBeforeStr = headBeforeMerge.stdout.trim();

    // M4: re-validate the verdict pins under the lock (base may have moved).
    if (reviewVerdict) {
      const stale = await this.checkVerdictFreshness(job, reviewVerdict, headBeforeStr);
      if (stale) {
        return stale;
      }
    }

    const mergeStrategy = this.config?.mergeStrategy ?? 'squash';
    let mergeResult;

    if (mergeStrategy === 'squash') {
      // Squash: merge --squash then commit
      mergeResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'merge',
        '--squash',
        job.branch,
      ]);

      if (mergeResult.exitCode !== 0) {
        const conflicts = extractConflicts(
          [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
        );
        await rollbackMerge(this.integrationWorktree);

        return {
          success: false,
          type: 'conflict',
          files: conflicts.length > 0 ? conflicts : undefined,
        };
      }

      // Commit the squashed changes
      // R2: revalidate between staging and commit — a takeover during the
      // merge or test setup aborts our own staging (lock held, HEAD is
      // still ours) and refuses without committing.
      const preCommit = await this.checkFencingGate(opts?.fencing);
      if (preCommit) {
        await rollbackMerge(this.integrationWorktree);
        return preCommit;
      }
      const commitResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'commit',
        '-m',
        `Merge ${job.name}`,
      ]);

      if (commitResult.exitCode !== 0) {
        // M5/M7: an empty diff is valid for diagnosis — a merge with no
        // changes is a no-op success, never an artificial failure.
        // F01: in strict (requireReviewPass) mode an empty diff is NOT
        // verifiable delivery — block instead of succeeding skipped.
        if (isEmptyCommitFailure(commitResult.stderr || commitResult.stdout)) {
          if (this.config?.requireReviewPass) {
            if (await this.isVerifiedSameCommitNoOp(job, reviewVerdict)) {
              await rollbackMerge(this.integrationWorktree);
              return {
                success: true,
                mergedAt: new Date().toISOString(),
                testReport: {
                  status: 'passed',
                  reason: 'No changes to merge (already integrated, same commit verified) — no-op success',
                  setup: { status: 'skipped', commands: [] },
                },
              };
            }
            await rollbackMerge(this.integrationWorktree);
            return {
              success: false,
              type: 'review_blocked',
              output: `Review blocked: job "${job.name}" has no changes (empty diff) — nothing to verify`,
              testReport: {
                status: 'skipped',
                reason: 'No changes to merge (empty diff) — blocked in strict mode, never verified',
                setup: { status: 'skipped', commands: [] },
              },
            };
          }
          await rollbackMerge(this.integrationWorktree);
          return {
            success: true,
            mergedAt: new Date().toISOString(),
            testReport: {
              status: 'skipped',
              reason: 'No changes to merge (empty diff) — treated as no-op success',
              setup: { status: 'skipped', commands: [] },
            },
          };
        }
        await rollbackMerge(this.integrationWorktree);
        return {
          success: false,
          type: 'test_failure',
          output: `Failed to commit squashed merge: ${commitResult.stderr || commitResult.stdout}`,
        };
      }
    } else if (mergeStrategy === 'ff-only') {
      // FF-only in merge train context: treat as squash since integration branch accumulates merges
      mergeResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'merge',
        '--squash',
        job.branch,
      ]);

      if (mergeResult.exitCode !== 0) {
        const conflicts = extractConflicts(
          [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
        );
        await rollbackMerge(this.integrationWorktree);

        return {
          success: false,
          type: 'conflict',
          files: conflicts.length > 0 ? conflicts : undefined,
        };
      }

      // Commit the squashed changes
      // R2: revalidate between staging and commit — a takeover during the
      // merge or test setup aborts our own staging (lock held, HEAD is
      // still ours) and refuses without committing.
      const preCommit = await this.checkFencingGate(opts?.fencing);
      if (preCommit) {
        await rollbackMerge(this.integrationWorktree);
        return preCommit;
      }
      const commitResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'commit',
        '-m',
        `Merge ${job.name}`,
      ]);

      if (commitResult.exitCode !== 0) {
        // M5/M7: an empty diff is valid for diagnosis — a merge with no
        // changes is a no-op success, never an artificial failure.
        // F01: in strict (requireReviewPass) mode an empty diff is NOT
        // verifiable delivery — block instead of succeeding skipped.
        if (isEmptyCommitFailure(commitResult.stderr || commitResult.stdout)) {
          if (this.config?.requireReviewPass) {
            if (await this.isVerifiedSameCommitNoOp(job, reviewVerdict)) {
              await rollbackMerge(this.integrationWorktree);
              return {
                success: true,
                mergedAt: new Date().toISOString(),
                testReport: {
                  status: 'passed',
                  reason: 'No changes to merge (already integrated, same commit verified) — no-op success',
                  setup: { status: 'skipped', commands: [] },
                },
              };
            }
            await rollbackMerge(this.integrationWorktree);
            return {
              success: false,
              type: 'review_blocked',
              output: `Review blocked: job "${job.name}" has no changes (empty diff) — nothing to verify`,
              testReport: {
                status: 'skipped',
                reason: 'No changes to merge (empty diff) — blocked in strict mode, never verified',
                setup: { status: 'skipped', commands: [] },
              },
            };
          }
          await rollbackMerge(this.integrationWorktree);
          return {
            success: true,
            mergedAt: new Date().toISOString(),
            testReport: {
              status: 'skipped',
              reason: 'No changes to merge (empty diff) — treated as no-op success',
              setup: { status: 'skipped', commands: [] },
            },
          };
        }
        await rollbackMerge(this.integrationWorktree);
        return {
          success: false,
          type: 'test_failure',
          output: `Failed to commit squashed merge: ${commitResult.stderr || commitResult.stdout}`,
        };
      }
    } else {
      // Merge: standard merge with --no-ff to create merge commit
      mergeResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'merge',
        '--no-ff',
        '-m',
        `Merge ${job.name}`,
        job.branch,
      ]);

      if (mergeResult.exitCode !== 0) {
        const conflicts = extractConflicts(
          [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
        );
        await rollbackMerge(this.integrationWorktree);

        return {
          success: false,
          type: 'conflict',
          files: conflicts.length > 0 ? conflicts : undefined,
        };
      }
    }

    // Gap1: scoped tasks defer the repo-wide gate to the final integration
    // verification (post-merge, all siblings present). Merge now without a
    // per-merge repo-wide run; the orchestrator runs the gate once after all
    // merges (fail-closed there, never success-skipped).
    if (opts?.skipTest) {
      return {
        success: true,
        mergedAt: new Date().toISOString(),
        testReport: {
          status: 'skipped',
          reason: 'Deferred to final integration verification (scoped task; repo-wide gate runs post-merge)',
          setup: {
            status: 'skipped',
            commands: [],
          },
        },
      };
    }

    const testCommand = this.config?.testCommand
      ? this.config.testCommand
      : await detectTestCommand(this.integrationWorktree);

    // F01: without test evidence there is no verification. Strict
    // (requireReviewPass) mode blocks instead of succeeding skipped;
    // legacy callers keep the permissive no-op success.
    if (!testCommand) {
      if (this.config?.requireReviewPass) {
        return {
          success: false,
          type: 'review_blocked',
          output: `Review blocked: job "${job.name}" has no test command — missing test evidence (never integrate untested as verified)`,
          testReport: {
            status: 'skipped',
            reason: 'No test command configured or detected — blocked in strict mode',
            setup: {
              status: 'skipped',
              commands: [],
            },
          },
        };
      }
      console.warn(
        `No test command configured or detected in ${this.integrationWorktree}. Skipping test gating.`,
      );
      return {
        success: true,
        mergedAt: new Date().toISOString(),
        testReport: {
          status: 'skipped',
          reason: 'No test command configured or detected',
          setup: {
            status: 'skipped',
            commands: [],
          },
        },
      };
    }

    const timeoutMs = this.config?.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const dependencySetupResult = await ensureTestDependencies(
      this.integrationWorktree,
      timeoutMs,
      this.config?.setupCommands,
    );

    if (!dependencySetupResult.success) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      const isEnvFailure = dependencySetupResult.status === 'env-failure';
      return {
        success: false,
        type: 'test_failure',
        output: dependencySetupResult.output,
        testReport: {
          status: isEnvFailure ? 'env-failure' : 'skipped',
          command: testCommand,
          reason: isEnvFailure ? dependencySetupResult.output : 'Dependency setup failed before tests could run',
          setup: {
            status: dependencySetupResult.status,
            commands: dependencySetupResult.commands,
            output: dependencySetupResult.output,
          },
        },
      };
    }

    const testResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs);

    if (testResult.timedOut) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: `Test timed out after ${timeoutMs}ms`,
        testReport: {
          status: 'failed',
          command: testCommand,
          timedOut: true,
          output: testResult.output,
          reason: `Test timed out after ${timeoutMs}ms`,
          setup: {
            status: dependencySetupResult.status,
            commands: dependencySetupResult.commands,
            output: dependencySetupResult.output || undefined,
          },
        },
      };
    }

    if (!testResult.success) {
      // F parity: undeclared missing dep (MODULE_NOT_FOUND) with no install
      // path is env-failure, not a code test failure. Fail closed as
      // env-failure (never pass/skip), preserving toctou-style tests.
      // Only bare (external) specifiers convert: relative/absolute requires
      // are genuine code bugs and stay test failures.
      if (!testResult.timedOut && /Cannot find module|MODULE_NOT_FOUND/i.test(testResult.output)) {
        try {
          const { ENV_UNPREPARED, isExternalMissingModule } = await import('./test-env.js');
          if (!isExternalMissingModule(testResult.output)) {
            // relative/absolute require typo: code defect, not env — fall through to normal failure
          } else {
          const out = testResult.output.includes('ENV-UNPREPARED') ? testResult.output : `${ENV_UNPREPARED}\n${testResult.output}`;
          await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
          return {
            success: false,
            type: 'test_failure',
            output: out,
            testReport: {
              status: 'env-failure',
              command: testCommand,
              output: out,
              setup: {
                status: 'env-failure',
                commands: dependencySetupResult.commands,
                output: out,
              },
            },
          };
          }
        } catch {}
      }
      const fixTimeout = this.config?.fixBeforeRollbackTimeout ?? DEFAULT_FIX_BEFORE_ROLLBACK_TIMEOUT_MS;
      const isServeMode = job.port !== undefined;

      if (isServeMode && fixTimeout > 0) {
        const fixPrompt = this.buildFixPrompt(job.name, testCommand, testResult.output);
        const fixPrompted = await this.promptAgentForFix(job, fixPrompt);

        if (fixPrompted) {
          await this.sleep(fixTimeout);

          // R2: the fix window is a long wait — a takeover during it refuses
          // before the retest result is trusted (our own merge is rolled back).
          const postFix = await this.checkFencingGate(opts?.fencing);
          if (postFix) {
            await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
            return postFix;
          }

          const retestResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs);

          if (retestResult.success) {
            const regressionBlock = await this.runPostIntegrationRegression(timeoutMs, headBeforeStr);
            if (regressionBlock) {
              return regressionBlock;
            }
            // R2: same long-operation rule as the main path — no stale success claim.
            const postRetest = await this.checkFencingGate(opts?.fencing);
            if (postRetest) {
              return postRetest;
            }
            return {
              success: true,
              mergedAt: new Date().toISOString(),
              testReport: {
                status: 'passed',
                command: testCommand,
                output: retestResult.output || undefined,
                setup: {
                  status: dependencySetupResult.status,
                  commands: dependencySetupResult.commands,
                  output: dependencySetupResult.output || undefined,
                },
              },
            };
          }
        }
      }

      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: testResult.output,
        testReport: {
          status: 'failed',
          command: testCommand,
          output: testResult.output,
          setup: {
            status: dependencySetupResult.status,
            commands: dependencySetupResult.commands,
            output: dependencySetupResult.output || undefined,
          },
        },
      };
    }

    const regressionBlock = await this.runPostIntegrationRegression(timeoutMs, headBeforeStr);
    if (regressionBlock) {
      return regressionBlock;
    }

    // R2: tests/regression are the long operation — a takeover during them
    // must not be reported as our success. The commit was authorized when
    // made (pre-commit gate passed under the lock); it stands for the new
    // owner to reconcile (empty-diff no-op path), we just refuse to claim it.
    const postTest = await this.checkFencingGate(opts?.fencing);
    if (postTest) {
      return postTest;
    }

    return {
      success: true,
      mergedAt: new Date().toISOString(),
      testReport: {
        status: 'passed',
        command: testCommand,
        output: testResult.output || undefined,
        setup: {
          status: dependencySetupResult.status,
          commands: dependencySetupResult.commands,
          output: dependencySetupResult.output || undefined,
        },
      },
    };
  }

  async processAll(
    verdicts?: Map<string, ReviewVerdict>,
  ): Promise<Array<{ job: JobSpec; result: MergeResult }>> {
    const results: Array<{ job: JobSpec; result: MergeResult }> = [];

    while (this.queue.length > 0) {
      const job = this.queue[0];
      const result = await this.processNext(job ? (verdicts?.get(job.name) ?? null) : null);
      results.push({ job, result });
    }

    return results;
  }

  private buildFixPrompt(jobName: string, testCommand: string, testOutput: string): string {
    return `[AUTO-GENERATED] Test Failure in Merge Train

Job "${jobName}" failed during merge train testing.

Test Command: ${testCommand}

Test Output:
${testOutput.slice(0, 2000)}

Please fix the failing tests. You have a limited time window to apply fixes before the merge is rolled back. Focus on the most critical failures first.`;
  }

  private async promptAgentForFix(job: JobSpec, prompt: string): Promise<boolean> {
    // The fix must reach the REMOTE worker session. launchSessionID is the
    // local control-center session — prompting it would inject a fix request
    // into the operator's own session. Without a reachable remote session
    // the fix is skipped loudly and the merge rolls back.
    if (!job.port || !job.remoteSessionID) {
      console.warn(
        `[MC] fix-before-rollback skipped for job "${job.name}": ` +
          'no remote worker session (port/remoteSessionID missing), rolling back.',
      );
      return false;
    }

    try {
      const client = createV2Client(job.port);
      await v2Prompt(client, job.remoteSessionID, prompt);
      return true;
    } catch (error) {
      console.warn(
        `[MC] fix-before-rollback prompt failed for job "${job.name}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
