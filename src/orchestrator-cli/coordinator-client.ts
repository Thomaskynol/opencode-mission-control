import { getJobByName, loadJobState, type Job } from '../lib/job-state';
import {
  formatReportLine,
  readAllReports,
  type AgentReport,
} from '../lib/reports';
import { getPendingQuestionsForJob } from '../lib/question-relay';
import { loadRuntimeSnapshot } from '../lib/durable-state';

/**
 * M6 human lane: read-only local client for the conversational TUI.
 * It observes exactly what the coordinator sees (job/plan state, reports,
 * pending questions) and never drives workers: no tmux, no session writes,
 * no raw pane logs. Writes happen only through the pause/resume/answer
 * tools and the coordinator loop.
 */

export interface TaskSummary {
  name: string;
  status: string;
  branch: string;
  mode: string;
  lastReport?: string;
  pendingQuestions: number;
  paused: boolean;
}

export interface Dashboard {
  running: number;
  completed: number;
  failed: number;
  stopped: number;
  paused: string[];
  alerts: string[];
  questions: Array<{ jobName: string; question: string; options: string[] }>;
  tasks: TaskSummary[];
}

function toSummary(job: Job, latest?: AgentReport): TaskSummary {
  return {
    name: job.name,
    status: job.status,
    branch: job.branch,
    mode: job.mode,
    lastReport: latest ? formatReportLine(latest) : undefined,
    pendingQuestions: getPendingQuestionsForJob(job.id).length,
    paused: latest?.status === 'paused',
  };
}

/** Short dashboard: counts + one-liners, never raw logs. */
export async function getDashboard(): Promise<Dashboard> {
  const [state, reports, sidecar] = await Promise.all([
    loadJobState(),
    readAllReports(),
    loadRuntimeSnapshot(),
  ]);

  const byJob = new Map<string, AgentReport>();
  for (const r of [...reports].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )) {
    if (!byJob.has(r.jobId)) byJob.set(r.jobId, r);
  }

  const sidecarByJob = new Map<string, number>();
  for (const q of sidecar?.pendingQuestions ?? []) {
    sidecarByJob.set(q.jobName, (sidecarByJob.get(q.jobName) ?? 0) + 1);
  }

  const questions: Dashboard['questions'] = [];
  for (const job of state.jobs.filter((j) => j.status === 'running')) {
    for (const q of getPendingQuestionsForJob(job.id)) {
      questions.push({
        jobName: job.name,
        question: q.question,
        options: q.options.map((o) => o.label),
      });
    }
    const durableOnly = (sidecarByJob.get(job.name) ?? 0) - getPendingQuestionsForJob(job.id).length;
    for (let i = 0; i < durableOnly; i++) {
      questions.push({ jobName: job.name, question: '(durable sidecar question — run mc_answer)', options: [] });
    }
  }

  return {
    running: state.jobs.filter((j) => j.status === 'running').length,
    completed: state.jobs.filter((j) => j.status === 'completed').length,
    failed: state.jobs.filter((j) => j.status === 'failed').length,
    stopped: state.jobs.filter((j) => j.status === 'stopped').length,
    // Paused reflects each job's LATEST report: an old paused report must
    // not resurface after the job later reported progress/completion.
    paused: [...byJob.values()].filter((r) => r.status === 'paused').map((r) => r.jobName),
    alerts: reports
      .filter((r) => r.status === 'blocked' || r.status === 'needs_review')
      .map((r) => formatReportLine(r)),
    questions,
    tasks: state.jobs.map((j) => toSummary(j, byJob.get(j.id))),
  };
}

/** Latest report for a job from the bulk reader (never the stubbed single reader). */
export async function readLatestReport(jobId: string): Promise<AgentReport | null> {
  const all = await readAllReports();
  let latest: AgentReport | null = null;
  for (const r of all) {
    if (r.jobId !== jobId) continue;
    if (!latest || r.timestamp > latest.timestamp) latest = r;
  }
  return latest;
}

/** One-task consult: status + last milestone line + question state. */
export async function queryTask(name: string): Promise<string> {
  const job = await getJobByName(name);
  if (!job) {
    throw new Error(`Job "${name}" not found.`);
  }
  const [report, sidecar] = await Promise.all([
    readLatestReport(job.id),
    loadRuntimeSnapshot(),
  ]);
  const pending = getPendingQuestionsForJob(job.id);
  const durable = (sidecar?.pendingQuestions ?? []).filter((q) => q.jobId === job.id);

  const lines = [
    `Task: ${job.name} [${job.status}]`,
    `Branch: ${job.branch} | Mode: ${job.mode}`,
    `Last report: ${report ? formatReportLine(report) : '(none yet)'}`,
    report?.progress !== undefined
      ? `Progress: ${report.progress}% (reported by worker)`
      : `Progress: unknown (never invented)`,
    pending.length > 0 || durable.length > 0
      ? `Pending questions: ${pending.length + durable.length} — run: answer ${job.name} <response>`
      : `Pending questions: none`,
    `Details: mc_status(name: "${job.name}") | Session: mc_attach(name: "${job.name}") (read-only, does not drive the worker)`,
  ];
  return lines.join('\n');
}
