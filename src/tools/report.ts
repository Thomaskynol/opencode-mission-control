import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { isInManagedWorktree } from '../lib/worktree';
import { getJobByName, loadJobState } from '../lib/job-state';
import { loadPlan } from '../lib/plan-state';
import {
  readAllReports,
  buildFinalReportMarkdown,
  writeFinalReport,
  type ReportStatus,
} from '../lib/reports';
import { writeReport } from '../lib/reports';

export const mc_report: ToolDefinition = tool({
  description:
    'Report agent status back to Mission Control. Auto-detects which job is calling based on the current worktree.',
  args: {
    status: tool.schema
      .enum(['working', 'blocked', 'needs_review', 'completed', 'progress'])
      .describe(
        'Current status: working (actively coding), blocked (waiting/stuck), needs_review (done but needs human review), completed (work finished successfully), progress (milestone update)',
      ),
    message: tool.schema
      .string()
      .describe('Human-readable status message'),
    progress: tool.schema
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Completion percentage (0-100)'),
  },
  async execute(args) {
    const cwd = process.cwd();
    const managed = await isInManagedWorktree(cwd);

    if (!managed.isManaged || !managed.jobName) {
      throw new Error(
        'mc_report can only be used from within a managed Mission Control worktree.',
      );
    }

    const state = await loadJobState();
    // Match only running jobs to avoid picking up stale entries from previous runs
    // that share the same name/worktree path
    const job = state.jobs.find(
      (j) =>
        j.status === 'running' &&
        (j.worktreePath === managed.worktreePath ||
         j.name === managed.jobName),
    ) ?? state.jobs.find(
      (j) =>
        j.worktreePath === managed.worktreePath ||
        j.name === managed.jobName,
    );

    if (!job) {
      throw new Error(
        `No active job found for worktree "${managed.worktreePath}". The job may have been cleaned up.`,
      );
    }

    await writeReport({
      jobId: job.id,
      jobName: job.name,
      status: args.status as ReportStatus,
      message: args.message,
      progress: args.progress,
      timestamp: new Date().toISOString(),
    });

    const progressSuffix =
      args.progress !== undefined ? ` (${args.progress}%)` : '';
    return `Report submitted: [${args.status}]${progressSuffix} ${args.message}`;
  },
});

/**
 * M5/M7: standardized final report assembled from live state.
 * Readable body up front (request → verified vs gaps → next steps);
 * long per-job messages stay referenced here and attached as annexes.
 * Never invents percentages or results: unknown work is listed under
 * Gaps (Unmet / Unverified), never under Verified.
 */
export const mc_report_final: ToolDefinition = tool({
  description:
    'Assemble the standardized final mission report from the active plan, jobs, and milestone reports',
  args: {
    notes: tool.schema
      .string()
      .optional()
      .describe('Extra operator notes appended under Real Evidence'),
    includeAttachments: tool.schema
      .boolean()
      .optional()
      .describe('Attach full per-job report messages as annexes (default true)'),
  },
  async execute(args) {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan to report on');
    }
    const [state, reports] = await Promise.all([loadJobState(), readAllReports()]);
    const withAttachments = args.includeAttachments ?? true;

    const tasks = plan.jobs.map((job) => ({
      name: job.name,
      status: job.status,
      detail: job.error ?? (job.mergedAt ? `merged at ${job.mergedAt}` : undefined),
    }));
    const merged = plan.jobs.filter((job) => job.status === 'merged').map((job) => job.name);
    const conflicts = plan.jobs
      .filter((job) => job.status === 'conflict' || job.status === 'needs_rebase')
      .map((job) => job.name);
    // Fail-closed: only merged jobs count as verified. A completed job
    // that never merged (no reviewer gate, no integration) is unverified —
    // its code may be untested or unreviewed.
    const verified = plan.jobs
      .filter((job) => job.status === 'merged')
      .map((job) => `${job.name} [${job.status}]`);
    const unmet = plan.jobs
      .filter((job) => job.status === 'failed' || job.status === 'conflict' || job.status === 'needs_rebase' || job.status === 'canceled')
      .map((job) => `${job.name} [${job.status}]${job.error ? `: ${job.error}` : ''}`);
    // Anything not merged is unverified — including completed jobs: a worker
    // "completed" claim without a merge (no reviewer gate, no integration)
    // is not evidence.
    const unverified = plan.jobs
      .filter((job) => job.status !== 'merged')
      .filter((job) => !unmet.some((entry) => entry.startsWith(`${job.name} `)))
      .map((job) => `${job.name} [${job.status}] — outcome not verified`);
    const notes = args.notes?.trim() ? [args.notes.trim()] : [];

    const markdown = buildFinalReportMarkdown({
      title: plan.name,
      request: `Plan "${plan.name}" (${plan.mode}) — ${plan.jobs.length} job(s).`,
      scope: plan.jobs.map((job) => job.name),
      architecture: [`Integration branch: ${plan.integrationBranch}`, `Base commit: ${plan.baseCommit}`],
      decisions: [],
      tasks,
      contributions: reports.map((report) => ({
        instance: report.jobId,
        job: report.jobName,
        summary: `[${report.status}] ${report.message}`,
      })),
      files: [],
      branches: [
        plan.integrationBranch,
        ...plan.jobs.map((job) => job.branch).filter((branch): branch is string => Boolean(branch)),
      ],
      integration: {
        branch: plan.integrationBranch,
        merged,
        conflicts,
        note: plan.prUrl ? `PR: ${plan.prUrl}` : undefined,
      },
      installUsage: [],
      tests: [],
      evidences: [...notes, `Plan status: ${plan.status}${plan.prUrl ? ` — PR: ${plan.prUrl}` : ''}`],
      problems: unmet.map((entry) => ({ problem: entry, solution: 'See job error and retry via mc_plan_approve' })),
      verified,
      unmet,
      unverified,
      limitations: [],
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
      attachments: withAttachments
        ? reports.map((report) => ({
          name: `${report.jobName} [${report.status}] @ ${report.timestamp}`,
          content: report.progress !== undefined
            ? `${report.message} (${report.progress}%)`
            : report.message,
        }))
        : [],
    });

    const filePath = await writeFinalReport(plan.id, markdown);
    return [
      `Final report for plan "${plan.name}" written to ${filePath}.`,
      '',
      `Verified: ${verified.length}, Unmet: ${unmet.length}, Unverified: ${unverified.length}.`,
      'Long logs are in Annexes; unknown work is under Gaps, never under Verified.',
    ].join('\n');
  },
});
