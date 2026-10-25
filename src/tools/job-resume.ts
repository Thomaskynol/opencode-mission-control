import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName, type Job } from '../lib/job-state';
import { loadConfig } from '../lib/config';
import {
  createV2Client,
  v2Interrupt,
  v2Prompt,
  v2Wait,
  type V2Client,
} from '../lib/sdk-client';
import { writeMilestoneReport } from '../lib/reports';
import { pauseTarget } from './job-pause';

/**
 * M6 human lane: standalone resume. Continues the SAME session
 * (corrections continue the session; distinct tasks start a new one),
 * optionally with follow-up text, without blocking by default.
 */

export interface ResumeOps {
  resume(): Promise<unknown>;
  prompt(text: string): Promise<unknown>;
  wait(): Promise<unknown>;
}

export interface ResumeOptions {
  /** Follow-up text sent to the same session before resuming. */
  message?: string;
  /** Also block until the loop goes idle (session.wait). Off by default. */
  waitForIdle?: boolean;
}

export function liveResumeOps(client: V2Client, sessionID: string): ResumeOps {
  return {
    resume: () => v2Interrupt(client, sessionID, true),
    prompt: (text: string) => v2Prompt(client, sessionID, text),
    wait: () => v2Wait(client, sessionID),
  };
}

function truncate(text: string, maxLength = 120): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export async function resumeJob(
  job: Job,
  ops: ResumeOps,
  opts: ResumeOptions = {},
): Promise<string> {
  pauseTarget(job);
  if (opts.message) {
    await ops.prompt(opts.message);
  }
  await ops.resume();
  if (opts.waitForIdle) {
    await ops.wait();
  }
  await writeMilestoneReport(
    job.id,
    job.name,
    opts.message ? `Resumed with follow-up: ${truncate(opts.message)}` : 'Resumed.',
  );
  return `Job "${job.name}" resumed on the same session${opts.message ? ' with follow-up text' : ''}.`;
}

export const mc_job_resume: ToolDefinition = tool({
  description:
    'Resume a paused serve-mode job on the same session (session.interrupt resume). Accepts optional follow-up text. Returns immediately unless wait is set.',
  args: {
    name: tool.schema.string().describe('Job name'),
    message: tool.schema
      .string()
      .optional()
      .describe('Follow-up text sent to the same session before resuming.'),
    wait: tool.schema
      .boolean()
      .optional()
      .describe('Block until the session loop goes idle (session.wait).'),
  },
  async execute(args) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found.`);
    }
    const target = pauseTarget(job);
    const config = await loadConfig();
    const client = createV2Client(target.port, config.serverPassword);
    return resumeJob(job, liveResumeOps(client, target.sessionID), {
      message: args.message,
      waitForIdle: args.wait,
    });
  },
});
