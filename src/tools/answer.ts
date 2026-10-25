import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { createV2Client, v2Prompt } from '../lib/sdk-client';
import { loadConfig } from '../lib/config';
import { answerQuestion } from '../orchestrator-cli/forms';

export const mc_answer: ToolDefinition = tool({
  description:
    'Answer a pending question from a background job. Checks the live relay first, then the durable sidecar (survives restarts). Unblocks only the asking job; independent fronts keep running.',
  args: {
    name: tool.schema
      .string()
      .describe('Job name that asked the question'),
    response: tool.schema
      .string()
      .describe('Your answer to the question. For option-based questions, provide the option label(s). For open-ended questions, provide your response text.'),
  },
  async execute(args) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found.`);
    }

    if (job.status !== 'running') {
      throw new Error(`Job "${args.name}" is not running (status: ${job.status}).`);
    }

    if (!job.remoteSessionID || !job.port) {
      throw new Error(`Job "${args.name}" is not a serve-mode job or missing session info.`);
    }

    const config = await loadConfig();
    const password = config.serverPassword;
    // The 2.x server only serves the /api surface: answers travel as a
    // session text prompt via the v2 client (forms); only permission.*
    // uses the reply endpoint.
    return answerQuestion(args.name, args.response, async (port, sessionID, response) => {
      const client = createV2Client(port, password);
      await v2Prompt(client, sessionID, response);
    });
  },
});
