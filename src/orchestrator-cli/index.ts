import { getJobByName } from '../lib/job-state';
import { loadConfig } from '../lib/config';
import { assertHardenedRealEntry } from '../lib/monitor';
import { createV2Client, v2Prompt } from '../lib/sdk-client';
import { mc_kill } from '../tools/kill';
import { pauseJob, livePauseOps, pauseTarget } from '../tools/job-pause';
import { resumeJob, liveResumeOps } from '../tools/job-resume';
import { answerQuestion } from './forms';
import { dispatchArgv, type HumanControls } from './commands';

/**
 * M6 human lane entry: `bun src/orchestrator-cli/index.ts <command>`.
 * Separate conversational TUI process — talks to the coordinator only via
 * local APIs (state files, coordinator pure functions, session endpoints
 * scoped to one execution). Never drives worker internals directly.
 */
export function createLiveControls(): HumanControls {
  return {
    async pause(name, opts) {
      const job = await getJobByName(name);
      if (!job) throw new Error(`Job "${name}" not found.`);
      const target = pauseTarget(job);
      const config = await loadConfig();
      return pauseJob(job, livePauseOps(createV2Client(target.port, config.serverPassword), target.sessionID), opts);
    },
    async resume(name, opts) {
      const job = await getJobByName(name);
      if (!job) throw new Error(`Job "${name}" not found.`);
      const target = pauseTarget(job);
      const config = await loadConfig();
      return resumeJob(job, liveResumeOps(createV2Client(target.port, config.serverPassword), target.sessionID), opts);
    },
    async cancel(name) {
      // Cancel = stop the process, preserve the work. Only mc_cleanup discards code.
      const result = await mc_kill.execute({ name });
      return `Canceled (process stopped, code preserved):\n${result}`;
    },
    async answer(name, response) {
      const config = await loadConfig();
      const password = config.serverPassword;
      return answerQuestion(name, response, async (port, sessionID, text) => {
        await v2Prompt(createV2Client(port, password), sessionID, text);
      });
    },
    async launch(prompt) {
      return [
        'Request wrapped with coordinator guards, ready to dispatch via mc_launch:',
        '',
        prompt,
      ].join('\n');
    },
  };
}

/**
 * R6b hardened real-entry gate: driving verbs refuse a leaked generic test
 * env fail-closed (NODE_ENV=test/VITEST=true silently disables conductor
 * fencing and the external reviewer). Read-only verbs (follow, questions,
 * order, task, log, help, close) stay available.
 *
 * Override is explicit + auditable only: `--allow-test-env` in this
 * invocation argv (recorded to test-env-override-audit.jsonl + stderr).
 * An inherited MC_ALLOW_TEST_ENV=1 alone is NOT enough (it leaks through
 * the environment) and is refused with an actionable error naming the flag.
 * Library call paths (dispatchArgv, startAutonomous, resumeIntake) stay
 * ungated so unit fakes keep working.
 */
const DRIVING_VERBS = new Set(['start', 'resume', 'approve', 'touchset']);

function stripTestEnvFlag(argv: string[]): string[] {
  return argv.filter((a) => a !== '--allow-test-env' && !a.startsWith('--allow-test-env='));
}

async function main(): Promise<void> {
  // Pass raw argv through: the shell already tokenized quotes, so a
  // multi-word --request arrives as one token. Joining + re-splitting
  // here would lose that grouping and truncate to the first word.
  const argv = process.argv.slice(2);
  const verb = (argv[0] ?? '').toLowerCase();
  if (DRIVING_VERBS.has(verb)) {
    assertHardenedRealEntry(`cli ${verb}`, { argv });
  }
  const filtered = stripTestEnvFlag(argv);
  try {
    console.log(await dispatchArgv(filtered, createLiveControls()));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
