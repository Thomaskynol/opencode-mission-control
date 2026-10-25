import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName, type Job } from '../lib/job-state';
import { loadConfig } from '../lib/config';
import {
  createV2Client,
  v2Background,
  v2Interrupt,
  type V2Client,
} from '../lib/sdk-client';
import { writeMilestoneReport } from '../lib/reports';

/**
 * M6 human lane: standalone pause via session.interrupt (+background).
 * The loop stops, the code stays: job status remains `running`
 * (JobSchema has no paused state) and a `paused` milestone marks it.
 * Tmux jobs have no session loop — stop those with mc_kill (also preserves work).
 */

export interface PauseOps {
  interrupt(): Promise<unknown>;
  background(): Promise<unknown>;
}

export interface PauseOptions {
  /** Also detach blocking subagents into the background. */
  detach?: boolean;
}

/** Narrow to a pausable serve-mode target or throw with guidance. */
export function pauseTarget(job: Job): { port: number; sessionID: string } {
  if (!job.port || !job.remoteSessionID) {
    throw new Error(
      `Job "${job.name}" is not a serve-mode job: pause needs session.interrupt; stop tmux jobs with mc_kill (work is preserved).`,
    );
  }
  if (job.status !== 'running') {
    throw new Error(`Job "${job.name}" is not running (status: ${job.status}).`);
  }
  return { port: job.port, sessionID: job.remoteSessionID };
}

export function livePauseOps(client: V2Client, sessionID: string): PauseOps {
  return {
    interrupt: () => v2Interrupt(client, sessionID),
    background: () => v2Background(client, sessionID),
  };
}

export async function pauseJob(
  job: Job,
  ops: PauseOps,
  opts: PauseOptions = {},
): Promise<string> {
  pauseTarget(job);
  await ops.interrupt();
  if (opts.detach) {
    await ops.background();
  }
  await writeMilestoneReport(job.id, job.name,
    `Paused${opts.detach ? ' and detached to background' : ''}. Work preserved; resume with mc_job_resume.`,
    { status: 'paused' },
  );
  return `Job "${job.name}" paused (loop interrupted, code untouched). Status stays "running". Resume with mc_job_resume.`;
}

export const mc_job_pause: ToolDefinition = tool({
  description:
    'Pause a running serve-mode job via session.interrupt (loop stops, code preserved). Status stays "running"; resume with mc_job_resume. For tmux jobs use mc_kill.',
  args: {
    name: tool.schema.string().describe('Job name'),
    detach: tool.schema
      .boolean()
      .optional()
      .describe('Also detach blocking subagents into the background (session.background).'),
  },
  async execute(args) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found.`);
    }
    const target = pauseTarget(job);
    const config = await loadConfig();
    const client = createV2Client(target.port, config.serverPassword);
    return pauseJob(job, livePauseOps(client, target.sessionID), {
      detach: args.detach,
    });
  },
});
