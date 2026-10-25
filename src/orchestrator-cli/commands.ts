import { buildWorkerPrompt, decideNextJobs } from '../lib/coordinator';
import { getJobByName } from '../lib/job-state';
import { loadPlan } from '../lib/plan-state';
import { formatReportLine } from '../lib/reports';
import { mc_attach } from '../tools/attach';
import { getDashboard, queryTask, readLatestReport } from './coordinator-client';
import { listPersistedQuestions, renderQuestionForm } from './forms';
import { applyModelPlan, closeFollow, complementIntake, resumeIntake, splitCommandArgs, startIntake, type AutoCommandDeps } from './auto-commands';

/**
 * M6 human lane: conversational dispatcher for the separate human TUI.
 * Parses short operator commands and routes them to coordinator-local APIs
 * (state reads, pause/resume/answer controls). It never pilots a worker:
 * `session`/`log` return read-only pointers and milestone lines, not control.
 */

export interface HumanControls {
  pause(name: string, opts?: { detach?: boolean }): Promise<string>;
  resume(name: string, opts?: { message?: string; waitForIdle?: boolean }): Promise<string>;
  cancel(name: string): Promise<string>;
  answer(name: string, response: string): Promise<string>;
  launch(prompt: string): Promise<string>;
}

export const HELP = [
  'Human TUI commands (separate from worker sessions):',
  '  start --repo R --branch B --request "NL" [--context C] [--max-parallel N] — single autonomous run (model invoked internally, plan + workers scheduled)',
  '  start <request> [--repo R] [--branch B] [--max-parallel N] — capture NL-only intake, persist it, print the planner prompt (legacy two-step)',
  '  complement [--intake ID] <text> — extend the persisted request (same work continues)',
  '  resume [--intake ID] — retake without new JSON (no duplicated workers, no reintegration)',
  '  auto-plan --intake ID --plan-file F — advanced diagnostic only, never required for start',
  '  close                 — detach this view; coordinator/reconciler/monitor keep conducting, recording continues',
  '  send <request>        — wrap a large request with coordinator guards, ready to dispatch',
  '  follow | progress     — short dashboard without raw logs',
  '  task <name>           — consult one task (status, last milestone, questions)',
  '  add <name> <text>     — complement a job: continue the SAME session with follow-up text',
  '  pause <name> [--detach] — interrupt the session loop (code preserved)',
  '  resume <name> [text] [--wait] — continue the same session, optionally with text',
  '  cancel <name>         — stop the process, preserve the code (discard only via mc_cleanup)',
  '  answer <name> <text>  — reply to a pending question (others keep running)',
  '  questions             — list pending questions as respondable forms',
  '  order                 — preview dispatch order (priority lives in the plan lane)',
  '  session <name>        — read-only session access (does not drive the worker)',
  '  log <name>            — last milestone line (no raw log dump)',
].join('\n');

/** Preview dispatch order from coordinator state (read-only). */
export async function previewOrder(): Promise<string> {
  const plan = await loadPlan();
  if (!plan) return 'No active plan.';
  const running = plan.jobs.filter((j) => j.status === 'running').length;
  const picked = decideNextJobs(
    plan.jobs.map((j) => ({
      name: j.name,
      status: j.status,
      dependsOn: j.dependsOn,
      mergeOrder: j.mergeOrder,
      priority: j.priority,
    })),
    running,
    plan.jobs.length,
  );
  const lines = [
    `Dispatch preview (${picked.length} eligible, ${running} running):`,
    ...picked.map((j) => `- ${j.name}`),
    'Priority changes live in the plan lane (mc_plan tools).',
  ];
  return lines.join('\n');
}

export async function listQuestionForms(): Promise<string> {
  const persisted = await listPersistedQuestions();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const q of persisted) {
    const key = `${q.jobId}:${q.partId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(renderQuestionForm(q), '');
  }
  if (lines.length === 0) {
    return 'No pending questions. Workers continue; unanswered essentials auto-resolve with best judgment.';
  }
  return lines.join('\n');
}

/** Read-only log view: last milestone line only, never a raw pane dump. */
export async function readMilestoneLog(name: string): Promise<string> {
  const job = await getJobByName(name);
  if (!job) {
    throw new Error(`Job "${name}" not found.`);
  }
  const report = await readLatestReport(job.id);
  if (!report) return `No milestone reports yet for "${name}".`;
  return formatReportLine(report);
}

export async function dispatchCommand(
  input: string,
  controls: HumanControls,
  autoDeps?: AutoCommandDeps,
): Promise<string> {
  const text = input.trim();
  if (!text) return HELP;
  const [verb, ...rest] = splitCommandArgs(text);
  return dispatchTokens(verb, rest, text.slice(verb.length).trim(), controls, autoDeps);
}

/**
 * Shell argv entry: `process.argv.slice(2)` already tokenized by the shell
 * (quotes stripped, spaces preserved inside a token). Never join/re-split —
 * that loses the grouping and truncates `--request` to its first word.
 */
export async function dispatchArgv(
  argv: string[],
  controls: HumanControls,
  autoDeps?: AutoCommandDeps,
): Promise<string> {
  if (argv.length === 0) return HELP;
  const [verb, ...rest] = argv;
  if (!verb) return HELP;
  return dispatchTokens(verb, rest, rest.join(' ').trim(), controls, autoDeps);
}

async function dispatchTokens(
  verb: string,
  rest: string[],
  sendText: string,
  controls: HumanControls,
  autoDeps?: AutoCommandDeps,
): Promise<string> {
  const lower = verb.toLowerCase();

  switch (lower) {
    case 'help':
      return HELP;

    case 'start': {
      return startIntake(rest, autoDeps);
    }

    case 'complement': {
      return complementIntake(rest);
    }

    case 'auto-plan': {
      return applyModelPlan(rest);
    }

    case 'close': {
      return closeFollow();
    }

    case 'follow':
    case 'progress': {
      const d = await getDashboard();
      return [
        `Follow: ${d.running} running, ${d.completed} completed, ${d.failed} failed, ${d.stopped} stopped${d.paused.length > 0 ? `, paused: ${d.paused.join(', ')}` : ''}`,
        ...d.alerts.slice(0, 3).map((a) => `ALERT ${a}`),
        d.questions.length > 0
          ? `Questions (${d.questions.length}): ${d.questions.map((q) => q.jobName).join(', ')} — run: questions`
          : 'Questions: none',
      ].join('\n');
    }

    case 'task': {
      const name = rest[0];
      if (!name) throw new Error('Usage: task <name>');
      return queryTask(name);
    }

    case 'send': {
      const request = sendText;
      if (!request) throw new Error('Usage: send <request>');
      const prompt = buildWorkerPrompt({
        request,
        constraints: [
          'Local commits and branches only — never push, publish, or touch the global config.',
          'Report at each milestone; never invent progress percentages.',
        ],
        decisions: [],
        baseRef: 'HEAD',
        acceptance: ['Milestone reports written', 'No secrets, ports, or dirs leaked'],
      });
      return controls.launch(prompt);
    }

    case 'add': {
      const [name, ...words] = rest;
      if (!name || words.length === 0) throw new Error('Usage: add <name> <follow-up text>');
      return controls.resume(name, { message: words.join(' ') });
    }

    case 'pause': {
      const name = rest[0];
      if (!name) throw new Error('Usage: pause <name> [--detach]');
      return controls.pause(name, { detach: rest.includes('--detach') });
    }

    case 'resume': {
      if (rest.some((w) => w === '--intake')) {
        return resumeIntake(rest, autoDeps);
      }
      const name = rest[0];
      if (!name) throw new Error('Usage: resume <name> [follow-up text] [--wait] | resume --intake <id>');
      const wait = rest.includes('--wait');
      const message = rest.slice(1).filter((w) => w !== '--wait').join(' ') || undefined;
      return controls.resume(name, { message, waitForIdle: wait });
    }

    case 'cancel': {
      const name = rest[0];
      if (!name) throw new Error('Usage: cancel <name>');
      return controls.cancel(name);
    }

    case 'answer': {
      const [name, ...words] = rest;
      if (!name || words.length === 0) throw new Error('Usage: answer <name> <response>');
      return controls.answer(name, words.join(' '));
    }

    case 'questions':
      return listQuestionForms();

    case 'order':
      return previewOrder();

    case 'session': {
      const name = rest[0];
      if (!name) throw new Error('Usage: session <name>');
      const instructions = await mc_attach.execute({ name });
      return `${instructions}\n(Read-only access: observe or attach a viewer; do not pilot the worker from here.)`;
    }

    case 'log': {
      const name = rest[0];
      if (!name) throw new Error('Usage: log <name>');
      return readMilestoneLog(name);
    }

    default:
      return HELP;
  }
}
