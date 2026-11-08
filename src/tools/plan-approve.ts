import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan, savePlan, updatePlanJob, updatePlanFields } from '../lib/plan-state';
import { canClearCheckpoint } from '../lib/plan-types';
import { Orchestrator } from '../lib/orchestrator';
import { getSharedMonitor, getSharedNotifyCallback, setSharedOrchestrator } from '../lib/orchestrator-singleton';
import type { CheckpointType } from '../lib/plan-types';
import { loadConfig } from '../lib/config';
import { getCurrentModel } from '../lib/model-tracker';
import { createIntegrationBranch } from '../lib/integration';
import { resolvePostCreateHook } from '../lib/worktree-setup';
import { validateTouchSet } from '../lib/merge-train';

export const mc_plan_approve: ToolDefinition = tool({
  description:
    'Approve a pending copilot plan, clear a supervisor checkpoint, or retry/relaunch a failed job to continue execution',
  args: {
    checkpoint: tool.schema
      .enum(['pre_merge', 'on_error', 'pre_pr'])
      .optional()
      .describe('Specific checkpoint to clear (for supervisor mode)'),
    retry: tool.schema
      .string()
      .optional()
      .describe('Name of a failed, conflict, or needs_rebase job to retry after manual fix (re-validates touchSet); or a ready_to_merge job blocked by another job\u2019s on_error pause (scoped resume, failing job stays failed)'),
    relaunch: tool.schema
      .string()
      .optional()
      .describe('Name of a touchSet-failed job to relaunch — spawns agent in existing worktree with correction prompt'),
  },
  async execute(args) {
    if (args.retry && args.relaunch) {
      throw new Error('Cannot specify both "retry" and "relaunch". Use "retry" for manual fixes (re-validates) or "relaunch" to spawn an agent to fix violations.');
    }

    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan to approve');
    }

    const targetJobName = args.retry ?? args.relaunch;
    if (targetJobName) {
      const job = plan.jobs.find((j) => j.name === targetJobName);
      if (!job) {
        throw new Error(`Job "${targetJobName}" not found in plan`);
      }
      if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
        // R2: scoped resume — a ready_to_merge job blocked by another job's
        // on_error pause can be re-driven without accepting the failure.
        // Only for explicit --retry (never relaunch), only while paused on
        // on_error for a DIFFERENT job; the failing job stays failed.
        const isScopedResume =
          !!args.retry &&
          !args.relaunch &&
          job.status === 'ready_to_merge' &&
          canClearCheckpoint(plan) &&
          !!plan.checkpointContext?.jobName &&
          plan.checkpointContext.jobName !== targetJobName;
        if (!isScopedResume) {
          throw new Error(`Job "${targetJobName}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
        }
      }
    }

    if (canClearCheckpoint(plan)) {
      const checkpoint = (args.checkpoint ?? plan.checkpoint) as CheckpointType;
      const config = await loadConfig();

      if (args.relaunch) {
        const ctx = plan.checkpointContext;
        if (!ctx || ctx.failureKind !== 'touchset') {
          throw new Error(`Job "${args.relaunch}" was not failed due to a touchSet violation — use "retry" instead.`);
        }
        if (ctx.jobName !== args.relaunch) {
          throw new Error(`Checkpoint was set for job "${ctx.jobName}", not "${args.relaunch}".`);
        }

        // Targeted field updates (never whole-snapshot savePlan): a monitor
        // event landing between loadPlan and here must not be clobbered.
        await updatePlanFields(plan.id, { status: 'running', checkpoint: null, checkpointContext: null });

        const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
        setSharedOrchestrator(orchestrator);
        orchestrator.setPlanModelSnapshot(getCurrentModel());

        await orchestrator.relaunchJobForCorrection(
          args.relaunch,
          ctx.touchSetViolations ?? [],
          ctx.touchSetPatterns ?? [],
        );
        await orchestrator.resumePlan();

        return [
          `Checkpoint "${checkpoint}" cleared. Job "${args.relaunch}" relaunched with correction prompt.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'The agent will fix touchSet violations in the existing worktree.',
          'Use mc_plan_status to monitor progress.',
        ].join('\n');
      }

      if (args.retry) {
        const job = plan.jobs.find(j => j.name === args.retry)!;

        const ctx = plan.checkpointContext;
        // R2 scoped resume: ready job blocked by another job's on_error pause.
        // Keep the failing job failed (no accept), keep this job ready, just
        // clear the global pause so the merge train can drive it. Honest
        // partial: destination still waits for allMerged.
        const isScopedResume =
          job.status === 'ready_to_merge' && !!ctx?.jobName && ctx.jobName !== args.retry;
        if (isScopedResume) {
          const failingJob = ctx.jobName;
          await updatePlanFields(plan.id, { status: 'running', checkpoint: null, checkpointContext: null });

          const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
          setSharedOrchestrator(orchestrator);
          orchestrator.setPlanModelSnapshot(getCurrentModel());
          await orchestrator.resumePlan();

          return [
            `Checkpoint "${checkpoint}" cleared. Job "${args.retry}" re-driven (scoped resume; "${failingJob}" stays failed, no violations accepted).`,
            '',
            `  ID:   ${plan.id}`,
            `  Mode: ${plan.mode}`,
            '',
            'Use mc_plan_status to monitor progress.',
          ].join('\n');
        }
        if (ctx?.failureKind === 'touchset' && ctx.jobName === args.retry) {
          if (job.touchSet && job.touchSet.length > 0 && job.branch && plan.integrationBranch) {
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet);
            if (!validation.valid && validation.violations) {
              throw new Error(
                `Job "${args.retry}" still has touchSet violations after manual fix:\n` +
                `  Violations: ${validation.violations.join(', ')}\n` +
                `  Allowed: ${job.touchSet.join(', ')}\n` +
                `Fix the remaining violations and retry again.`,
              );
            }
          }
        }

        const retryJob = plan.jobs.find(j => j.name === args.retry)!;
        // M9: retry resets status/checkpoint only — review attempts persist via
        // plan-state (durable budget), so the counter is never reset here.
        // Targeted updates (never whole-snapshot savePlan) to avoid clobbering
        // concurrent monitor writes.
        await updatePlanJob(plan.id, retryJob.name, { status: 'ready_to_merge', error: undefined });
        await updatePlanFields(plan.id, { status: 'running', checkpoint: null, checkpointContext: null });

        const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
        setSharedOrchestrator(orchestrator);
        orchestrator.setPlanModelSnapshot(getCurrentModel());
        await orchestrator.resumePlan();

        return [
          `Checkpoint "${checkpoint}" cleared. Job "${args.retry}" reset to ready_to_merge.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'Use mc_plan_status to monitor progress.',
        ].join('\n');
      }

      const ctx = plan.checkpointContext;
      if (ctx?.failureKind === 'touchset') {
        const job = plan.jobs.find(j => j.name === ctx.jobName);
        if (job && job.status === 'failed') {
          await updatePlanJob(plan.id, job.name, { status: 'ready_to_merge', error: undefined });
        }
      }

      await updatePlanFields(plan.id, { status: 'running', checkpoint: null, checkpointContext: null });

      const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
      setSharedOrchestrator(orchestrator);
      orchestrator.setPlanModelSnapshot(getCurrentModel());
      await orchestrator.resumePlan();

      const acceptMsg = ctx?.failureKind === 'touchset'
        ? ` TouchSet violations for job "${ctx.jobName}" accepted.`
        : '';
      return [
        `Checkpoint "${checkpoint}" cleared.${acceptMsg} Plan "${plan.name}" resuming.`,
        '',
        `  ID:   ${plan.id}`,
        `  Mode: ${plan.mode}`,
        '',
        'Use mc_plan_status to monitor progress.',
      ].join('\n');
    }

    if (plan.status !== 'pending') {
      // R2 follow-up: scoped resume can leave failed without a pause (independent
      // merged past it). Allow explicit --retry of failed/conflict/needs_rebase
      // while running as scoped per-job reset (touchSet still validated when
      // applicable; re-review decides; CLI binds version-bound approval with
      // ressalva, MCP just re-drives).
      if (plan.status === 'running' && !plan.checkpoint) {
        if (args.relaunch) {
          throw new Error(
            `Plan "${plan.name}" is not paused (current status: ${plan.status}) — relaunch needs an on_error checkpoint with touchSet context.`,
          );
        }
        if (args.retry) {
          const job = plan.jobs.find((j) => j.name === args.retry);
          if (!job) throw new Error(`Job "${args.retry}" not found in plan`);
          if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
            throw new Error(`Job "${args.retry}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
          }
          const config = await loadConfig();
          if (job.touchSet && job.touchSet.length > 0 && job.branch && plan.integrationBranch) {
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet);
            if (!validation.valid && validation.violations) {
              throw new Error(
                `Job "${args.retry}" still has touchSet violations:\n` +
                `  Violations: ${validation.violations.join(', ')}\n` +
                `  Allowed: ${job.touchSet.join(', ')}\n` +
                `Fix the remaining violations and retry again.`,
              );
            }
          }
          // Targeted update (never whole-snapshot savePlan): only the job
            // row changes, the plan keeps running without a checkpoint.
            // M9: scoped retry also preserves persisted review attempts (budget).
            await updatePlanJob(plan.id, job.name, { status: 'ready_to_merge', error: undefined });
          const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
          setSharedOrchestrator(orchestrator);
          orchestrator.setPlanModelSnapshot(getCurrentModel());
          await orchestrator.resumePlan();
          return [
            `Job "${args.retry}" reset to ready_to_merge (running scoped retry; no global pause to clear).`,
            '',
            `  ID:   ${plan.id}`,
            `  Mode: ${plan.mode}`,
            '',
            'Use mc_plan_status to monitor progress.',
          ].join('\n');
        }
      }
      throw new Error(
        `Plan "${plan.name}" is not pending or paused (current status: ${plan.status})`,
      );
    }

    const config = await loadConfig();
    const integrationPostCreate = resolvePostCreateHook(config.worktreeSetup);
    const integration = plan.baseBranch
      ? await createIntegrationBranch(plan.id, integrationPostCreate, plan.baseBranch)
      : await createIntegrationBranch(plan.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;
    plan.status = 'running';
    await savePlan(plan);

    const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
    setSharedOrchestrator(orchestrator);
    orchestrator.setPlanModelSnapshot(getCurrentModel());
    await orchestrator.resumePlan();

    return [
      `Plan "${plan.name}" approved and started.`,
      '',
      `  ID:   ${plan.id}`,
      `  Mode: ${plan.mode}`,
      `  Jobs: ${plan.jobs.length}`,
      '',
      'Use mc_plan_status to monitor progress.',
    ].join('\n');
  },
});
