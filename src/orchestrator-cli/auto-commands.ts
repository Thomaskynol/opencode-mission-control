import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  normalizeRequest,
  buildPlannerPrompt,
  parsePlannerOutput,
  assertSafeDestinations,
  assertAuthorizedActions,
  nextStepsFor,
  ensureBaseReady,
  createRunPlannerGenerate,
  type AutoIntakeInput,
  type PlannerGenerate,
} from '../lib/auto-plan';
import {
  saveAutoIntake,
  loadAutoIntake,
  loadRuntimeSnapshot,
  appendAutoQuestion,
  setAutoNextSteps,
  setAutoIntakeStatus,
  type AutoIntakeRecord,
} from '../lib/durable-state';
import { loadPlan } from '../lib/plan-state';

/**
 * Autonomous intake commands for the human TUI (public NL path).
 * `start --request` is the single autonomous entry: it invokes the
 * configured model internally (private `opencode run --standalone` session,
 * never the shared background service), validates with retry + backoff,
 * persists the intake, ensures the base, creates the plan via startPlan and
 * lets the coordinator/reconciler schedule workers. `auto-plan --plan-file`
 * stays only as an advanced diagnostic (never required).
 */

export interface AutoCommandDeps {
  generate?: PlannerGenerate;
  startAutonomous?: (
    input: AutoIntakeInput,
    generate: PlannerGenerate,
  ) => Promise<{ intakeId: string; tasks: string[]; launched: boolean }>;
  resumeAutonomous?: (intakeId: string) => Promise<string>;
}

/** Absolute CLI entry so help/answers print full copyable commands. */
export function cliPath(): string {
  return fileURLToPath(new URL('./index.ts', import.meta.url));
}

export function resumeCommand(intakeId: string): string {
  return `bun ${cliPath()} auto-plan --intake ${intakeId} --plan-file <model-output.json>`;
}

function splitCliArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function splitCommandArgs(input: string): string[] {
  return splitCliArgs(input);
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, '');
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function ceilingFrom(flags: Map<string, string>): AutoIntakeRecord['ceiling'] {
  const maxParallel = flags.get('max-parallel');
  const testCommand = flags.get('test-command');
  if (maxParallel === undefined && testCommand === undefined) return undefined;
  const parsed = maxParallel !== undefined ? Number.parseInt(maxParallel, 10) : undefined;
  return {
    ...(parsed !== undefined && Number.isFinite(parsed) ? { maxParallel: parsed } : {}),
    ...(testCommand !== undefined && testCommand !== '' ? { testCommand } : {}),
  };
}

/** `start <NL...> [--repo R] [--branch B] [--max-parallel N]` (legacy, two-step) or
 * `start --repo R --branch B --request "NL" [--context C] [--max-parallel N] [--test-command C]`
 * (single autonomous run: model invoked internally, plan created, workers scheduled). */
export async function startIntake(args: string[], deps?: AutoCommandDeps): Promise<string> {
  const { positional, flags } = parseFlags(args);
  const requested = (flags.get('request') ?? '').trim();
  if (requested) {
    return startAutonomous(args, deps);
  }
  const request = normalizeRequest(positional.join(' '));
  const now = new Date().toISOString();
  const record: AutoIntakeRecord = {
    id: randomUUID(),
    request,
    repo: flags.get('repo') || undefined,
    targetBranch: flags.get('branch') || undefined,
    ceiling: ceilingFrom(flags),
    requirements: [],
    decisions: [],
    questions: [],
    nextSteps: [],
    status: 'awaiting-plan',
    createdAt: now,
    updatedAt: now,
  };
  const plannerPrompt = buildPlannerPrompt(record);
  record.nextSteps = [
    'Feed the planner prompt below to the configured model, save its strict-JSON answer to a file, then run:',
    resumeCommand(record.id),
  ];
  await saveAutoIntake(record);
  return [
    `Intake ${record.id} persisted (awaiting-plan).`,
    `Request: ${request}`,
    ...(record.targetBranch ? [`Destination branch: ${record.targetBranch}`] : []),
    '',
    'Planner prompt for the configured model:',
    plannerPrompt,
    '',
    'Resume with:',
    resumeCommand(record.id),
  ].join('\n');
}

async function resolveIntake(flags: Map<string, string>): Promise<AutoIntakeRecord> {
  const id = flags.get('intake');
  if (id) {
    const record = await loadAutoIntake(id);
    if (!record) throw new Error(`No intake "${id}" persisted — start one with: start <request>`);
    return record;
  }
  const snapshot = await loadRuntimeSnapshot();
  if (!snapshot?.autoIntake) {
    throw new Error('No active intake — start one with: start <request>');
  }
  return snapshot.autoIntake;
}

/** `complement [--intake ID] <follow-up text>` — same work continues, nothing rebuilt. */
export async function complementIntake(args: string[]): Promise<string> {
  const { positional, flags } = parseFlags(args);
  const text = positional.join(' ').trim();
  if (!text) throw new Error('Usage: complement [--intake <id>] <follow-up text>');
  const record = await resolveIntake(flags);
  await saveAutoIntake({
    ...record,
    request: `${record.request}\nFollow-up: ${text}`,
    updatedAt: new Date().toISOString(),
  });
  // Pause-aware: a paused/blocked plan keeps its decision; the free-text
  // follow-up is recorded as a question (content, never approve/deny).
  // A running plan takes the complement into the scheduler — the
  // coordinator/reconciler advance eligible work with no manual resume.
  const plan = await loadPlan().catch(() => null);
  const paused = !!plan && (plan.status === 'paused' || !!plan.checkpoint);
  if (paused) {
    await appendAutoQuestion(record.id, text).catch(() => {});
    return [
      `Complement recorded on intake ${record.id} (same work continues, nothing rebuilt).`,
      `Plan is paused — pause respected, follow-up kept as an open question (free text, not approve/deny).`,
      `Request now ends with: "Follow-up: ${text}"`,
    ].join('\n');
  }
  return [
    `Complement recorded on intake ${record.id} (same work continues, nothing rebuilt).`,
    `Running: follow-up enters the scheduler — coordinator/reconciler advance eligible work, no manual resume needed.`,
    `Request now ends with: "Follow-up: ${text}"`,
  ].join('\n');
}

/**
 * `auto-plan --intake ID --plan-file <model-output.json>`
 * Validates the configured model's answer into dispatchable tasks and
 * persists requirements/decisions/questions/next steps. Invalid output
 * fails explicitly — no tasks are created from it.
 */
export async function applyModelPlan(args: string[]): Promise<string> {
  const { flags } = parseFlags(args);
  const intakeId = flags.get('intake');
  const planFile = flags.get('plan-file');
  if (!intakeId || !planFile) {
    throw new Error('Usage: auto-plan --intake <id> --plan-file <model-output.json>');
  }
  const record = await loadAutoIntake(intakeId);
  if (!record) throw new Error(`No intake "${intakeId}" persisted — start one with: start <request>`);

  const raw = await Bun.file(planFile).text().catch(() => {
    throw new Error(`Cannot read plan file "${planFile}".`);
  });
  const draft = parsePlannerOutput(raw);
  assertSafeDestinations(draft);
  assertAuthorizedActions(draft);

  const base = await ensureBaseReady(record.repo ?? process.cwd(), record.targetBranch);

  await saveAutoIntake({
    ...record,
    requirements: draft.requirements.map((r) => ({ ...r })),
    decisions: [...record.decisions, ...draft.decisions],
    questions: [...record.questions, ...draft.questions],
    nextSteps: nextStepsFor(draft),
    status: 'planned',
    updatedAt: new Date().toISOString(),
  });
  await setAutoNextSteps(record.id, nextStepsFor(draft));
  await setAutoIntakeStatus(record.id, 'planned');

  const taskLines = draft.tasks.map((t) => {
    const deps = t.dependsOn?.length ? ` (depends on: ${t.dependsOn.join(', ')})` : '';
    return `  - ${t.name}${deps}\n    acceptance: ${t.acceptance.join('; ')}`;
  });
  return [
    `Plan validated for intake ${record.id}: ${draft.tasks.length} task(s), ${draft.requirements.length} requirement(s).`,
    `Base ready: ${base.baseBranch}@${base.baseCommit.slice(0, 8)}${base.createdBranch ? ' (destination branch created locally)' : ''}`,
    '',
    'Tasks:',
    ...taskLines,
    ...(draft.questions.length > 0
      ? ['', 'Open questions (answer with free text, blocking nothing else):', ...draft.questions.map((q) => `  ? ${q}`)]
      : []),
    '',
    'Next steps:',
    ...nextStepsFor(draft).map((s) => `  - ${s}`),
    '',
    'Dispatch stays with the coordinator loop; track it with:',
    `bun ${cliPath()} follow`,
  ].join('\n');
}

/**
 * `close` — detach the follow view. Conducting (coordinator observe →
 * decide → dispatch, reconciler merges, monitor records) and recording
 * (reports, questions, decisions) continue; closing never stops, cancels
 * or discards work. `close` is explicit and never a silent cancel.
 */
export function closeFollow(): string {
  return [
    'Follow closed — the run continues.',
    'Conducting: the coordinator (observe → decide → dispatch), the reconciler loop (merges), and the monitor (reports) keep driving tasks; this view only reads state.',
    'Recording: worker reports, pending questions and decisions keep being persisted; resume anytime with:',
    `bun ${cliPath()} follow`,
    'Nothing was stopped or discarded by closing this view.',
  ].join('\n');
}

/**
 * Single autonomous run:
 * `start --repo R --branch B --request "NL" [--context C] [--max-parallel N] [--test-command C]`.
 * Invokes the configured model internally on a private session, validates
 * with retry + backoff, persists the intake, ensures the base, creates the
 * plan via startPlan and lets the coordinator/reconciler schedule workers.
 * Invalid model output retries, then fails explicitly — never wrong work.
 */
export async function startAutonomous(args: string[], deps?: AutoCommandDeps): Promise<string> {
  const { positional, flags } = parseFlags(args);
  const rawRequest = (flags.get('request') ?? positional.join(' ')).trim();
  const request = normalizeRequest(rawRequest);
  const repo = flags.get('repo') || undefined;
  const targetBranch = flags.get('branch') || undefined;
  const context = flags.get('context');
  const docs = context ? [context] : undefined;
  const input: AutoIntakeInput = {
    request,
    repo,
    targetBranch,
    docs,
    ceiling: ceilingFrom(flags),
  };
  const generate = deps?.generate ?? createRunPlannerGenerate();
  const startFn =
    deps?.startAutonomous ??
    (async (inp: AutoIntakeInput, gen: PlannerGenerate) => {
      const [{ Orchestrator }, { JobMonitor }, { loadConfig }] = await Promise.all([
        import('../lib/orchestrator'),
        import('../lib/monitor'),
        import('../lib/config'),
      ]);
      const config = await loadConfig();
      const orchestrator = new Orchestrator(new JobMonitor(), config);
      return orchestrator.startAutonomousPlan(inp, gen);
    });
  try {
    const { intakeId, tasks, launched } = await startFn(input, generate);
    return [
      `Intake ${intakeId} persisted (running).`,
      `Request: ${request}`,
      ...(targetBranch ? [`Destination branch: ${targetBranch}`] : []),
      `Plan launched: ${tasks.length} task(s) [${tasks.join(', ')}]${launched ? '' : ' (launch deferred)'}.`,
      'Conducting: coordinator (observe → decide → dispatch) + reconciler (merge) + monitor (reports).',
      'Track with:',
      `bun ${cliPath()} follow`,
      'Detaching is safe:',
      `bun ${cliPath()} close   # view only; never cancels the run`,
    ].join('\n');
  } catch (error) {
    // Preserve state for a public resume: keep the NL request as an
    // awaiting-plan intake so `resume --intake <id>` retries the model
    // without new JSON. No tasks, branches or workers are created here.
    const now = new Date().toISOString();
    const record: AutoIntakeRecord = {
      id: randomUUID(),
      request,
      repo,
      targetBranch,
      ceiling: input.ceiling,
      requirements: [],
      decisions: [`model failed: ${error instanceof Error ? error.message : String(error)}`],
      questions: [],
      nextSteps: [`resume without new JSON: bun ${cliPath()} resume --intake <id>`],
      status: 'awaiting-plan',
      createdAt: now,
      updatedAt: now,
    };
    await saveAutoIntake(record).catch(() => {});
    throw new Error(
      `Autonomous start failed (intake ${record.id} kept for resume): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `resume [--intake ID]` — public retake without new JSON. A disposable
 * coordinator process may be killed; this resumes from persisted
 * intake + plan, never duplicates workers and never reintegrates merged
 * work. Never restarts the machine, never touches user sessions.
 */
export async function resumeIntake(args: string[], deps?: AutoCommandDeps): Promise<string> {
  const { flags } = parseFlags(args);
  const record = await resolveIntake(flags);
  const resumeFn =
    deps?.resumeAutonomous ??
    (async (intakeId: string) => {
      const [{ Orchestrator }, { JobMonitor }, { loadConfig }] = await Promise.all([
        import('../lib/orchestrator'),
        import('../lib/monitor'),
        import('../lib/config'),
      ]);
      const config = await loadConfig();
      const orchestrator = new Orchestrator(new JobMonitor(), config);
      return orchestrator.resumeAutonomousIntake(intakeId);
    });
  const progress = await resumeFn(record.id);
  return [
    `Resumed intake ${record.id} without new JSON (no duplicated workers, no reintegration).`,
    progress,
  ].join('\n');
}
