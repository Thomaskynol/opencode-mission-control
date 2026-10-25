import { randomUUID } from 'crypto';
import type { MCConfig } from './config';
import type { PlanSpec, JobSpec, PlanStatus, CheckpointType, CheckpointContext, AuditLogEntry } from './plan-types';
import { loadPlan, savePlan, updatePlanJob, updatePlanFields, clearPlan, validateGhAuth } from './plan-state';
import { getDefaultBranch } from './git';
import { createIntegrationBranch, deleteIntegrationBranch, requireHumanAuth, type PublishAuthOptions } from './integration';
import { coordinateOnce, clampMaxParallel } from './coordinator';
import { MergeTrain, checkMergeability, type MergeTestReport, validateTouchSet } from './merge-train';
import { addJob, getRunningJobs, updateJob, loadJobState, removeJob, type Job } from './job-state';
import { JobMonitor } from './monitor';
import { removeReport } from './reports';
import { createWorktree, removeWorktree } from './worktree';
import { resolvePostCreateHook } from './worktree-setup';
import { writePromptFile, cleanupPromptFile, writeLauncherScript, cleanupLauncherScript } from './prompt-file';
import { getCurrentModel } from './model-tracker';
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
  type AutoIntakeInput,
  type PlannerGenerate,
  type RuntimeDecision,
} from './auto-plan';
import {
  saveAutoIntake,
  loadAutoIntake,
  loadRuntimeSnapshot,
  appendAutoDecision,
  appendAutoQuestion,
  setAutoIntakeStatus,
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
   * M5/M7 wiring: coordinator dispatches tracked per plan run so a
   * retry/crash never launches the same job twice. Key: `${planId}:${jobName}`.
   */
  private coordinatedJobs = new Set<string>();
  private jobComms: JobComms = new JobComms();
  private pendingReplanActions: Map<string, () => Promise<void>> = new Map();

  private getMergeTrainConfig(): {
    testCommand?: string;
    testTimeout?: number;
    mergeStrategy?: 'squash' | 'ff-only' | 'merge';
    setupCommands?: string[];
    fixBeforeRollbackTimeout?: number;
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
    };
  }

  private isQueued(name: string): boolean {
    const train = this.mergeTrain as (MergeTrain & { has?: (name: string) => boolean }) | null;
    if (!train) return false;
    // Duck-typed: test fakes expose getQueue() without has().
    if (typeof train.has === 'function') return train.has(name);
    return train.getQueue().some((job) => job.name === name);
  }

  private resolveCoordinatorModel(): V2ModelRef {
    // The stored snapshot is already a full triple — return it untouched so a
    // pinned variant survives (pin triplo). String snapshots never carry a
    // variant (model-tracker stores provider/modelID only).
    return (
      this.planModelSnapshot ??
      parseModelRef(getCurrentModel() ?? '') ?? { providerID: 'unknown', id: 'unknown' }
    );
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

    const plan = await loadPlan();
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
      });
      this.showToast('Mission Control', 'Checkpoint cleared, resuming execution.', 'info');

      if (!this.isRunning) {
        this.startReconciler();
      }
    }
  }

  async startPlan(spec: PlanSpec): Promise<{ pending: boolean; message?: string }> {
    this.validatePlan(spec);

    const existingPlan = await loadPlan();
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
    const integration = spec.baseBranch
      ? await createIntegrationBranch(spec.id, integrationPostCreate, spec.baseBranch)
      : await createIntegrationBranch(spec.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;

    if (spec.mode === 'copilot') {
      await savePlan(plan);
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

    await savePlan(plan);

    this.activePlanId = plan.id;
    this.coordinatedJobs.clear();
    this.planPlacement = spec.placement ?? null;
    this.planLaunchSessionID = spec.launchSessionID;
    this.mergeTrain = new MergeTrain(plan.integrationWorktree, this.getMergeTrainConfig());
    this.subscribeToMonitorEvents();
    this.startReconciler();
    this.showToast('Mission Control', `Plan "${plan.name}" started.`, 'info');
    this.notify(`📋 Plan "${plan.name}" started in autopilot mode. ${plan.jobs.length} jobs queued.`);
    return { pending: false };
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
    });
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
      const plan = await loadPlan();

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

      const maxParallel = (this.config as MCConfig & { maxParallel?: number }).maxParallel ?? 3;
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
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet);
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
        const mergeResult = await this.mergeTrain.processNext();

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
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'failed',
            error: mergeResult.output ?? 'merge train test failure',
          });

          const testSummary = this.formatTestReportSummary(mergeResult.testReport);
          if (testSummary) {
            this.notify(`🧪 ${nextJob.name}: ${testSummary}`);
          }

          this.showToast('Mission Control', `Job "${nextJob.name}" failed merge tests. Plan paused.`, 'error');
          this.notify(`❌ Job "${nextJob.name}" failed merge tests. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`);
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

      const latestPlan = await loadPlan();
      if (!latestPlan) {
        return;
      }

      const allMerged = latestPlan.jobs.length > 0 && latestPlan.jobs.every((job) => job.status === 'merged');
      // Guard: don't re-enter PR creation if already in progress or terminal
      if (allMerged && latestPlan.status !== 'creating_pr' && latestPlan.status !== 'completed' && latestPlan.status !== 'failed') {
        this.showToast('Mission Control', 'All jobs merged. Creating PR...', 'info');
        this.notify(`🎯 All ${latestPlan.jobs.length} jobs merged. Creating PR...`);

        if (this.isSupervisor(latestPlan)) {
          await this.setCheckpoint('pre_pr', latestPlan);
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
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `Plan completed! PR: ${prUrl}`, 'success');
          this.notify(`🎉 Plan "${latestPlan.name}" completed! PR created: ${prUrl}`);
        } catch (prError) {
          const errMsg = prError instanceof Error ? prError.message : String(prError);
          // M5/M7: refusing to push without explicit human auth preserves
          // partial work (pause at pre_pr) instead of failing the plan.
          // Approve with mc_plan_approve(checkpoint: "pre_pr") to continue.
          if (/explicit human authorization/i.test(errMsg)) {
            this.showToast('Mission Control', 'All jobs merged. PR needs explicit human authorization.', 'warning');
            this.notify(
              `⏸️ All ${latestPlan.jobs.length} jobs merged. PR creation needs explicit human authorization — ` +
              `no push was made. Approve with mc_plan_approve(checkpoint: "pre_pr").`,
            );
            await this.setCheckpoint('pre_pr', latestPlan);
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

    await updatePlanJob(planId, job.name, { status: 'running', branch });

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
      const plan = await loadPlan();
      const hasDeps = job.dependsOn && job.dependsOn.length > 0;
      const startPoint = plan ? (hasDeps ? plan.integrationBranch : plan.baseCommit) : undefined;

      worktreePath = await createWorktree({ branch, startPoint, postCreate });

      if (mode !== 'vanilla') {
        const omoStatus = await detectOMO();
        if (!omoStatus.detected) {
          throw new Error(
            `OMO mode "${mode}" requires Oh-My-OpenCode to be installed and detected`,
          );
        }

        if (mode === 'plan' || mode === 'ralph' || mode === 'ulw') {
          try {
            const sourcePlansPath = './.sisyphus/plans';
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
      const model = this.planModelSnapshot ? modelRefToCliString(this.planModelSnapshot) : getCurrentModel();
      const launcherPath = await writeLauncherScript(worktreePath, promptFilePath, model);

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
        await removeWorktree(worktreePath, true).catch(() => {});
      }

      // Recovery: the job never left queued/waiting_deps (no worktree yet),
      // but queued/waiting_deps → failed is not a valid transition. Force
      // it explicitly so the failure is visible instead of stuck queued.
      await updatePlanJob(planId, job.name, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }, { force: true });
    }
  }

  async relaunchJobForCorrection(
    jobName: string,
    violations: string[],
    touchSetPatterns: string[],
  ): Promise<void> {
    const plan = await loadPlan();
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
      const model = this.planModelSnapshot ? modelRefToCliString(this.planModelSnapshot) : getCurrentModel();
      const launcherPath = await writeLauncherScript(worktreePath, promptFilePath, model);

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

  async cancelPlan(): Promise<void> {
    this.stopReconciler();
    this.coordinatedJobs.clear();

    const plan = await loadPlan();
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
    // Retry with backoff: an invalid model answer never becomes work.
    const { intake, draft, attempts } = await runAutoIntakeWithRetry(input, generate, {
      maxAttempts: 3,
      baseDelayMs: 1000,
    });
    const base = await ensureBaseReady(input.repo ?? process.cwd(), input.targetBranch);

    const now = new Date().toISOString();
    await saveAutoIntake({
      id: intake.id,
      request: intake.request,
      repo: intake.repo,
      targetBranch: intake.targetBranch,
      ceiling: intake.ceiling,
      requirements: draft.requirements.map((r) => ({ ...r })),
      decisions: [...draft.decisions],
      questions: [...draft.questions],
      nextSteps: [],
      status: 'planned',
      createdAt: intake.createdAt,
      updatedAt: now,
    });
    await appendAutoDecision(
      intake.id,
      `model answered in ${attempts} attempt(s) (${draft.requirements.length} requirements, ${draft.tasks.length} tasks)`,
    ).catch(() => {});
    await appendAutoDecision(
      intake.id,
      `base ready: ${base.baseBranch}@${base.baseCommit.slice(0, 8)}${base.createdBranch ? ' (destination branch created locally, never pushed)' : ''}`,
    ).catch(() => {});

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
    await this.startPlan(spec);
    await appendAutoDecision(intake.id, `plan ${spec.id} launched (${tasks.length} tasks)`).catch(() => {});
    await setAutoIntakeStatus(intake.id, 'running').catch(() => {});
    await appendAutoDecision(
      intake.id,
      'conducting: coordinator (observe → decide → dispatch) + reconciler (merge) + monitor (reports); follow detaches, close never cancels',
    ).catch(() => {});
    return { intakeId: intake.id, tasks, launched: true };
  }

  /**
   * Public resume without new JSON: a disposable coordinator process may be
   * killed; this re-enters via persisted intake + plan, never duplicates
   * workers (resumePlan reuses tmux/panes, reconciler dedupes queue) and
   * never reintegrates merged work. Never touches user sessions.
   */
  async resumeAutonomousIntake(intakeId: string): Promise<string> {
    const record = await loadAutoIntake(intakeId);
    if (!record) {
      throw new Error(`No intake "${intakeId}" persisted — start one before resuming.`);
    }
    const plan = await loadPlan();
    if (!plan) {
      return `Intake ${record.id} [${record.status}]: no active plan to resume (nothing duplicated, nothing reintegrated).`;
    }
    await this.resumePlan();
    await appendAutoDecision(record.id, `resumed via public path (plan ${plan.id}, no new JSON)`).catch(() => {});
    return await this.autonomousProgress(record.id);
  }

  /**
   * Extend the persisted NL request; the same work continues, nothing rebuilds.
   * When running, the follow-up enters the scheduler and the reconciler /
   * coordinator advance eligible work with no manual resume. When paused or
   * blocked by a decision, the pause is respected and the free-text follow-up
   * is recorded as a question (content, never an approve/deny).
   */
  async complementAutonomousRequest(intakeId: string, text: string): Promise<void> {
    const record = await loadAutoIntake(intakeId);
    if (!record) {
      throw new Error(`No intake "${intakeId}" persisted — start one before complementing.`);
    }
    const followUp = text.trim();
    if (!followUp) throw new Error('Complement text must not be empty.');
    await saveAutoIntake({
      ...record,
      request: `${record.request}\nFollow-up: ${followUp}`,
      updatedAt: new Date().toISOString(),
    });
    const plan = await loadPlan().catch(() => null);
    const paused = !!plan && (plan.status === 'paused' || !!plan.checkpoint);
    if (paused) {
      // Free content recorded as a question; the pause/decision stands.
      await appendAutoQuestion(intakeId, followUp).catch(() => {});
      return;
    }
    await appendAutoDecision(intakeId, `complement: "${followUp.slice(0, 120)}"`).catch(() => {});
    // Running: make sure the loop that advances eligible work is alive, so no
    // manual resumePlan is needed after a complement/new task.
    try {
      const latest = await loadPlan();
      if (latest && (latest.status === 'running' || latest.status === 'merging' || latest.status === 'pending') && !this.isRunning) {
        this.startReconciler();
      }
    } catch {}
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
    const plan = await loadPlan();
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
    const plan = await loadPlan();
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
    const plan = await loadPlan();
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
    const plan = await loadPlan();
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
    await savePlan(plan);
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
      const latest = await loadPlan();
      if (latest && (latest.status === 'running' || latest.status === 'merging' || latest.status === 'pending') && !this.isRunning) {
        this.startReconciler();
      }
    } catch {}
  }

  async reorderJobs(newOrder: string[]): Promise<void> {
    const plan = await loadPlan();
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
    await savePlan(plan);

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
    const plan = await loadPlan();
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

  async resumePlan(): Promise<void> {
    const plan = await loadPlan();
    if (!plan || (plan.status !== 'running' && plan.status !== 'paused')) {
      return;
    }

    if (plan.status === 'paused') {
      await updatePlanFields(plan.id, {
        status: 'running',
        checkpoint: null,
        checkpointContext: null,
      });
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
            });
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
      });
      return;
    }

    this.subscribeToMonitorEvents();
    this.startReconciler();
  }

  private async createPR(opts?: PublishAuthOptions): Promise<string> {
    // M5/M7 (pending M1): no push/PR without explicit human authorization.
    // The human opts in per call — absence of the flag is a refusal.
    requireHumanAuth('git push', opts);
    requireHumanAuth('gh pr create', opts);
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan found');
    }

    const pushResult = await this.runCommand(['git', 'push', 'origin', plan.integrationBranch]);
    if (pushResult.exitCode !== 0) {
      throw new Error(`Failed to push integration branch: ${pushResult.stderr || pushResult.stdout}`);
    }

    const baseBranch = plan.baseBranch ?? await getDefaultBranch();
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
    ]);

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
