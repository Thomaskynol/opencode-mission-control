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
} from '../lib/auto-plan';
import {
  saveAutoIntake,
  loadAutoIntake,
  loadRuntimeSnapshot,
  setAutoNextSteps,
  setAutoIntakeStatus,
  type AutoIntakeRecord,
} from '../lib/durable-state';

/**
 * Autonomous intake commands for the human TUI (public NL path).
 * Pure-ish handlers: persistence goes through the durable sidecar, the
 * model transform arrives via --plan-file (the configured model's
 * strict-JSON answer to the printed planner prompt). Nothing here
 * dispatches worker work — dispatch stays with the coordinator loop.
 */

/** Absolute CLI entry so help/answers print full copyable commands. */
export function cliPath(): string {
  return fileURLToPath(new URL('./index.ts', import.meta.url));
}

export function resumeCommand(intakeId: string): string {
  return `bun ${cliPath()} auto-plan --intake ${intakeId} --plan-file <model-output.json>`;
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

/** `start <NL...> [--repo R] [--branch B] [--max-parallel N] [--test-command C]` */
export async function startIntake(args: string[]): Promise<string> {
  const { positional, flags } = parseFlags(args);
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
  return [
    `Complement recorded on intake ${record.id} (same work continues, nothing rebuilt).`,
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
 * decide → dispatch, reconciler merges) and recording (reports,
 * questions, decisions) continue; closing never stops or discards work.
 */
export function closeFollow(): string {
  return [
    'Follow closed — the run continues.',
    'Conducting: the coordinator (observe → decide → dispatch) and the reconciler loop keep driving tasks; this view only reads state.',
    'Recording: worker reports, pending questions and decisions keep being persisted; resume anytime with:',
    `bun ${cliPath()} follow`,
    'Nothing was stopped or discarded by closing this view.',
  ].join('\n');
}
