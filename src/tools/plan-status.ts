import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan } from '../lib/plan-state';
import { readAllReports, readAllReviewVerdicts, resolveJobReport, formatReviewVerdictLine, type AgentReport, type ReviewVerdictRecord } from '../lib/reports';
import type { JobSpec, PlanSpec } from '../lib/plan-types';

function getJobStatusIndicator(status: string): string {
  switch (status) {
    case 'running':
      return '▶';
    case 'completed':
      return '✓';
    case 'merged':
      return '✓✓';
    case 'failed':
      return '✗';
    case 'conflict':
      return '⚡';
    case 'queued':
      return '○';
    case 'waiting_deps':
      return '◌';
    case 'ready_to_merge':
      return '⬆';
    case 'merging':
      return '⇄';
    case 'stopped':
      return '⊘';
    case 'canceled':
      return '⊘';
    default:
      return '•';
  }
}

function formatJobLine(job: JobSpec): string {
  const indicator = getJobStatusIndicator(job.status);
  const deps =
    job.dependsOn?.length ? ` (deps: ${job.dependsOn.join(', ')})` : '';
  const error = job.error ? ` - Error: ${job.error}` : '';
  const merged = job.mergedAt ? ` (merged: ${job.mergedAt})` : '';
  return `  ${indicator} ${job.name}: ${job.status}${deps}${error}${merged}`;
}

/**
 * Blocker 4: latest persisted report per job via the canonical resolver —
 * id first; a same-name report from a previous run id is stale (relaunch
 * mints a new jobId) and is never associated as current.
 */
export function latestReportForJob(
  job: { id?: string; name: string; createdAt?: string },
  reports: AgentReport[],
): AgentReport | undefined {
  const { report } = resolveJobReport({ id: job.id ?? '', name: job.name }, reports);
  return report ?? undefined;
}

/** Verdict lookup: current jobId only. A same-name verdict from a previous
 * run id (relaunch mints a new jobId) is stale — never returned as current
 * (see staleVerdictForJob for the explicit stale marker). */
export function verdictForJob(
  job: { id?: string; name: string },
  verdicts: ReviewVerdictRecord[],
): ReviewVerdictRecord | undefined {
  if (job.id === undefined) return undefined;
  return verdicts.find((v) => v.jobId === job.id);
}

/** Same-name verdict from a different jobId (relaunch continuity): stale
 * marker only — the caller must render it as stale with the old jobId,
 * never as the current verdict. */
export function staleVerdictForJob(
  job: { id?: string; name: string },
  verdicts: ReviewVerdictRecord[],
): ReviewVerdictRecord | undefined {
  if (job.id === undefined) return undefined;
  const named = verdicts
    .filter((v) => v.jobName === job.name && v.jobId !== job.id)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return named[0];
}

function getNextActions(plan: PlanSpec): string {
  const queued = plan.jobs.filter((j) => j.status === 'queued').length;
  const waiting = plan.jobs.filter((j) => j.status === 'waiting_deps').length;
  const running = plan.jobs.filter((j) => j.status === 'running').length;
  const readyToMerge = plan.jobs.filter(
    (j) => j.status === 'ready_to_merge',
  ).length;
  const merging = plan.jobs.filter((j) => j.status === 'merging').length;

  const actions: string[] = [];
  if (running > 0) actions.push(`${running} job(s) running`);
  if (readyToMerge > 0) actions.push(`${readyToMerge} job(s) ready to merge`);
  if (merging > 0) actions.push(`${merging} job(s) merging`);
  if (queued > 0) actions.push(`${queued} job(s) queued`);
  if (waiting > 0) actions.push(`${waiting} job(s) waiting on deps`);

  return actions.length > 0 ? actions.join(', ') : 'None';
}

export const mc_plan_status: ToolDefinition = tool({
  description: 'Show status of the active orchestrated plan',
  args: {},
  async execute() {
    const plan = await loadPlan();
    if (!plan) {
      return 'No active plan.';
    }

    const merged = plan.jobs.filter((j) => j.status === 'merged').length;
    const total = plan.jobs.length;
    const progress = `${merged}/${total} merged`;

    // Blocker 4: verdict trail — persisted reports + review verdicts are
    // part of the status, never log-only. Reads are best-effort (a missing
    // sidecar is "none yet", never a crash).
    let reports: AgentReport[] = [];
    try {
      reports = await readAllReports();
    } catch {}
    let verdicts: ReviewVerdictRecord[] = [];
    try {
      verdicts = await readAllReviewVerdicts();
    } catch {}

    const jobLines = plan.jobs.map((job) => {
      const base = formatJobLine(job);
      const report = latestReportForJob({ id: job.id, name: job.name }, reports);
      if (!report) return base;
      return `${base}\n    last report [${report.status}]: ${report.message}`;
    }).join('\n');

    const verdictLines = plan.jobs
      .map((job) => verdictForJob(job, verdicts))
      .filter((v): v is ReviewVerdictRecord => v !== undefined)
      .map((v) => `  • ${formatReviewVerdictLine(v)}`);

    // Same-name verdicts from previous run ids: stale, never current —
    // rendered explicitly with the old jobId so a relaunch cannot inherit
    // another run's verdict as its own.
    const staleVerdictLines = plan.jobs
      .filter((job) => verdictForJob(job, verdicts) === undefined)
      .map((job) => ({ job, stale: staleVerdictForJob(job, verdicts) }))
      .filter((e): e is { job: (typeof plan.jobs)[number]; stale: ReviewVerdictRecord } => e.stale !== undefined)
      .map(({ job, stale }) => `  • stale: existe veredito de jobId anterior ${stale.jobId} para "${job.name}" [${stale.verdict}] — não associado ao job atual (${job.id})`);

    const lines: string[] = [
      `Plan: ${plan.name} (${plan.status})`,
      `Mode: ${plan.mode}`,
      `Progress: ${progress}`,
    ];

    if (plan.checkpoint) {
      lines.push(`Checkpoint: ${plan.checkpoint}`);
      const ctx = plan.checkpointContext;
      if (ctx) {
        const touch = ctx.touchSetViolations?.length ? ` violations: ${ctx.touchSetViolations.join(', ')}` : '';
        lines.push(`Checkpoint context: job=${ctx.jobName} failure=${ctx.failureKind}${touch}`);
      }
    }

    lines.push('', 'Jobs:', jobLines, '', `Next: ${getNextActions(plan)}`);

    if (verdictLines.length > 0) {
      lines.push('', 'Review verdicts (persisted per job+versions):', ...verdictLines);
    } else {
      lines.push('', 'Review verdicts: none yet (no persisted verdict — review gate has not recorded one)');
    }
    if (staleVerdictLines.length > 0) {
      lines.push('', 'Stale review verdicts (previous run id, not current):', ...staleVerdictLines);
    }

    if (plan.prUrl) {
      lines.push(`PR: ${plan.prUrl}`);
    }

    return lines.join('\n');
  },
});
