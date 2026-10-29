import { join } from 'path';
import { existsSync, lstatSync, rmSync } from 'fs';
import type { JobSpec } from './plan-types';
import { gitCommand } from './git';
import { getIntegrationWorktree, withIntegrationLock } from './integration';
import { extractConflicts } from './utils';
import { createV2Client, v2Prompt } from './sdk-client';
import type { ReviewVerdict } from './reviewer';

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
  status: 'passed' | 'failed' | 'skipped';
  commands: string[];
  output?: string;
};

export type MergeTestReport = {
  status: 'passed' | 'failed' | 'skipped';
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



export async function validateTouchSet(
  jobBranch: string,
  baseBranch: string,
  touchSet: string[],
  opts?: { cwd?: string },
): Promise<{ valid: boolean; violations?: string[]; changedFiles?: string[] }> {
  if (touchSet.length === 0) {
    return { valid: true };
  }

  const diffResult = await gitCommand(['diff', '--name-only', `${baseBranch}...${jobBranch}`], opts);
  if (diffResult.exitCode !== 0) {
    return { valid: false, violations: [`Failed to diff: ${diffResult.stderr}`] };
  }

  const changedFiles = diffResult.stdout.split('\n').map(f => f.trim()).filter(Boolean);
  if (changedFiles.length === 0) {
    return { valid: true, changedFiles: [] };
  }

  const violations: string[] = [];
  for (const file of changedFiles) {
    const matchesAny = touchSet.some(pattern => {
      // Trailing slash means "this directory and everything inside it"
      const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
      const glob = new Bun.Glob(normalized);
      return glob.match(file);
    });
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
  status: 'passed' | 'failed' | 'skipped';
}> {
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

export class MergeTrain {
  private queue: JobSpec[] = [];

  constructor(
    private readonly integrationWorktree: string,
    private readonly config?: MergeTrainConfig,
  ) {}

  static async forPlan(planId: string, config?: MergeTrainConfig): Promise<MergeTrain> {
    const integrationWorktree = await getIntegrationWorktree(planId);
    return new MergeTrain(integrationWorktree, config);
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

  async processNext(reviewVerdict?: ReviewVerdict | null, opts?: { skipTest?: boolean }): Promise<MergeResult> {
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
    return withIntegrationLock(this.integrationWorktree, () =>
      this.processNextInner(job, reviewVerdict ?? null, opts),
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
    if (verdict.reviewedBase !== integrationHead) {
      return {
        success: false,
        type: 'review_blocked',
        output: `Review blocked: job "${job.name}" was approved on base ${verdict.reviewedBase} but integration is now at ${integrationHead} (base moved, re-review required)`,
      };
    }
    if (job.branch) {
      const jobHead = await gitCommand(['-C', this.integrationWorktree, 'rev-parse', job.branch]);
      if (jobHead.exitCode === 0 && jobHead.stdout.trim() !== verdict.reviewedCommit) {
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

  private async processNextInner(job: JobSpec, reviewVerdict: ReviewVerdict | null, opts?: { skipTest?: boolean }): Promise<MergeResult> {

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
      return {
        success: false,
        type: 'test_failure',
        output: dependencySetupResult.output,
        testReport: {
          status: 'skipped',
          command: testCommand,
          reason: 'Dependency setup failed before tests could run',
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
      const fixTimeout = this.config?.fixBeforeRollbackTimeout ?? DEFAULT_FIX_BEFORE_ROLLBACK_TIMEOUT_MS;
      const isServeMode = job.port !== undefined;

      if (isServeMode && fixTimeout > 0) {
        const fixPrompt = this.buildFixPrompt(job.name, testCommand, testResult.output);
        const fixPrompted = await this.promptAgentForFix(job, fixPrompt);

        if (fixPrompted) {
          await this.sleep(fixTimeout);

          const retestResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs);

          if (retestResult.success) {
            const regressionBlock = await this.runPostIntegrationRegression(timeoutMs, headBeforeStr);
            if (regressionBlock) {
              return regressionBlock;
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
