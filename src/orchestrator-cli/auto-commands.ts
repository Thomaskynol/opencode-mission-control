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
import {
  getActiveRepoRoot,
  withRepoRoot,
  resolveRepoRoot,
  getDataDir,
  getXdgDataDir,
} from '../lib/paths';

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
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const key = body;
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next);
          i++;
        } else {
          flags.set(key, '');
        }
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
  // F04: validate explicitly — invalid ceilings fail, explicit 1 is kept (no 4–8 reinterpretation).
  let parsed: number | undefined;
  if (maxParallel !== undefined) {
    parsed = Number.parseInt(maxParallel, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Invalid --max-parallel "${maxParallel}": must be an integer >= 1.`);
    }
  }
  if (testCommand !== undefined && testCommand !== '' && !testCommand.trim()) {
    throw new Error('Invalid --test-command: must be a non-empty string.');
  }
  return {
    ...(parsed !== undefined && Number.isFinite(parsed) ? { maxParallel: parsed } : {}),
    ...(testCommand !== undefined && testCommand !== '' ? { testCommand: testCommand.trim() } : {}),
  };
}

/** F02: find an intake by id across all repo scopes (third-folder resume). */
async function findIntakeAcrossRepos(id: string): Promise<AutoIntakeRecord | null> {
  // Fast path: current scope (explicit --repo, active context, or cwd).
  const direct = await loadAutoIntake(id).catch(() => null);
  if (direct) return direct;
  // Slow path: scan XDG project dirs for a runtime-state.json holding this id.
  try {
    const fs = await import('fs');
    const { join } = await import('path');
    const base = getXdgDataDir();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const candidate = join(base, entry, 'state', 'runtime-state.json');
      try {
        if (!fs.existsSync(candidate)) continue;
        const text = fs.readFileSync(candidate, 'utf8');
        if (!text.includes(id)) continue;
        const parsed = JSON.parse(text) as { autoIntake?: AutoIntakeRecord };
        if (parsed?.autoIntake?.id === id) return parsed.autoIntake;
      } catch {
        continue;
      }
    }
  } catch {
    // Best-effort: fall through to null.
  }
  return null;
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
  // F02: explicit repo scope (canonical) — never persist intake in the launcher cwd.
  const repoRoot = resolveRepoRoot(flags.get('repo') || getActiveRepoRoot() || undefined);
  const ceiling = ceilingFrom(flags);
  return await withRepoRoot(repoRoot, async () => {
    const now = new Date().toISOString();
    const record: AutoIntakeRecord = {
      id: randomUUID(),
      request,
      repo: repoRoot,
      targetBranch: flags.get('branch') || undefined,
      ceiling,
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
  });
}

async function resolveIntake(flags: Map<string, string>): Promise<AutoIntakeRecord> {
  // Explicit --repo wins (third-folder resume); else active scope; else search all scopes by id.
  const repoFlag = flags.get('repo');
  if (repoFlag) {
    const repoRoot = resolveRepoRoot(repoFlag);
    return await withRepoRoot(repoRoot, async () => {
      const id = flags.get('intake');
      if (id) {
        const record = (await findIntakeAcrossRepos(id)) ?? (await loadAutoIntake(id).catch(() => null));
        if (!record) throw new Error(`No intake "${id}" persisted — start one with: start <request>`);
        return record;
      }
      const snapshot = await loadRuntimeSnapshot();
      if (!snapshot?.autoIntake) {
        throw new Error('No active intake — start one with: start <request>');
      }
      return snapshot.autoIntake;
    });
  }
  const id = flags.get('intake');
  if (id) {
    const record = (await findIntakeAcrossRepos(id)) ?? (await loadAutoIntake(id).catch(() => null));
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
export async function complementIntake(args: string[], deps?: AutoCommandDeps): Promise<string> {
  const { positional, flags } = parseFlags(args);
  const text = positional.join(' ').trim();
  if (!text) throw new Error('Usage: complement [--intake <id>] <follow-up text>');
  const record = await resolveIntake(flags);
  // F02: operate inside the intake's repo scope (never the launcher cwd).
  const repoRoot = resolveRepoRoot((record as unknown as { repo?: string }).repo ?? getActiveRepoRoot() ?? undefined);
  return await withRepoRoot(repoRoot, async () => {
    // Robust: persist Follow-up first via the already-resolved record (same mocked scope as the test/CLI),
    // so the request version survives even if the revision below fails or resolves another scope.
    try {
      const cur = (await loadAutoIntake(record.id).catch(() => null)) ?? record;
      if (!cur.request.endsWith(`Follow-up: ${text}`)) {
        await saveAutoIntake({ ...cur, request: `${cur.request}\nFollow-up: ${text}`, updatedAt: new Date().toISOString() });
      }
    } catch {}
    const [{ Orchestrator }, { JobMonitor }, { loadConfig }] = await Promise.all([
      import('../lib/orchestrator'),
      import('../lib/monitor'),
      import('../lib/config'),
    ]);
    const config = await loadConfig();
    const orchestrator = new Orchestrator(new JobMonitor(), config);
    (orchestrator as unknown as { repoRoot: string }).repoRoot = repoRoot;
    // F03: real revision via the model (same slot as intake) — never only Follow-up.
    const generate = deps?.generate ?? (await import('../lib/auto-plan')).createRunPlannerGenerate();
    // One-shot: shut down whatever loops this call started so the CLI exits
    // instead of lingering as a secondary coordinator (own loops only,
    // never another process).
    try {
      try {
        const res = await (orchestrator as unknown as {
          complementAutonomousRequest: (id: string, t: string, g: unknown) => Promise<{ added: string[]; message: string }>;
        }).complementAutonomousRequest(record.id, text, generate);
        return [
          `${res.message}`,
          `Request now ends with: "Follow-up: ${text}"`,
        ].join('\n');
      } catch (e) {
        // Model revision failed explicitly — Follow-up persisted, pause/decisions preserved.
        const msg = e instanceof Error ? e.message : String(e);
        return [
          `Complement recorded on intake ${record.id} (revision failed explicitly: ${msg}).`,
          `Request now ends with: "Follow-up: ${text}"`,
        ].join('\n');
      }
    } finally {
      try {
        (orchestrator as unknown as { shutdown?: () => void }).shutdown?.();
      } catch {}
    }
  });
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
  // F02: resolve intake across repos (third-folder diagnostic), then operate in its repo scope.
  const initial = (await findIntakeAcrossRepos(intakeId)) ?? (await loadAutoIntake(intakeId).catch(() => null));
  if (!initial) throw new Error(`No intake "${intakeId}" persisted — start one with: start <request>`);
  const repoRoot = resolveRepoRoot((initial as unknown as { repo?: string }).repo ?? getActiveRepoRoot() ?? undefined);
  return await withRepoRoot(repoRoot, async () => {
    const record = (await findIntakeAcrossRepos(intakeId)) ?? (await loadAutoIntake(intakeId).catch(() => null));
    if (!record) throw new Error(`No intake "${intakeId}" persisted — start one with: start <request>`);

    const raw = await Bun.file(planFile).text().catch(() => {
      throw new Error(`Cannot read plan file "${planFile}".`);
    });
    const draft = parsePlannerOutput(raw);
    assertSafeDestinations(draft);
    assertAuthorizedActions(draft);

    const base = await ensureBaseReady(repoRoot, record.targetBranch);

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
  });
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
    'Closing ends only this view; the run continues untouched (nothing stopped, nothing discarded).',
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
  // Shell already strips quotes before index.ts sees argv; when the input
  // went through join/split the multi-word value spills into positional.
  // Rejoin the spill so --request keeps its full text either way.
  const requestFlag = flags.get('request');
  const rawRequest = (requestFlag !== undefined ? [requestFlag, ...positional].join(' ') : positional.join(' ')).trim();
  const request = normalizeRequest(rawRequest);
  // F02: canonical repo scope (never bare cwd downstream).
  const repo = resolveRepoRoot(flags.get('repo') || getActiveRepoRoot() || undefined);
  const targetBranch = flags.get('branch') || undefined;
  const context = flags.get('context');
  const docs = context ? [context] : undefined;
  const ceiling = ceilingFrom(flags);
  const input: AutoIntakeInput = {
    request,
    repo,
    targetBranch,
    docs,
    ceiling,
  };
  const generate = deps?.generate ?? createRunPlannerGenerate();
  const startFn =
    deps?.startAutonomous ??
    (async (inp: AutoIntakeInput, gen: PlannerGenerate) => {
      return await withRepoRoot(repo, async () => {
        const [{ Orchestrator }, { JobMonitor }, { loadConfig }] = await Promise.all([
          import('../lib/orchestrator'),
          import('../lib/monitor'),
          import('../lib/config'),
        ]);
        const config = await loadConfig();
        const orchestrator = new Orchestrator(new JobMonitor(), config);
        return orchestrator.startAutonomousPlan(inp, gen);
      });
    });
  try {
    const { intakeId, tasks, launched } = await withRepoRoot(repo, async () => startFn(input, generate));
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
    // F02: preserve inside the explicit repo scope, never the launcher cwd.
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
    await withRepoRoot(repo, async () => saveAutoIntake(record)).catch(() => {});
    throw new Error(
      `Autonomous start failed (intake ${record.id} kept for resume): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Apply the persisted effective config (ceiling + pinned model) to a fresh
 * CLI orchestrator — the same restoration resumeAutonomousIntake performs.
 * Without the ceiling the reactivated reconciler reviews without testCommand.
 */
function applyEffectiveConfig(
  orchestrator: {
    applyCeiling: (c: { maxParallel?: number; testCommand?: string }) => void;
    setPlanModelSnapshot: (m: unknown) => void;
  },
  record: AutoIntakeRecord,
  fallbackModel: unknown,
): void {
  const rec = record as unknown as {
    ceiling?: { maxParallel?: number; testCommand?: string };
    effectiveModel?: string;
    effectiveVariant?: string;
  };
  orchestrator.applyCeiling(rec.ceiling);
  const eff = rec.effectiveModel?.trim();
  if (eff) {
    const slash = eff.indexOf('/');
    const ref =
      slash > 0
        ? { providerID: eff.slice(0, slash), id: eff.slice(slash + 1) }
        : { providerID: 'unknown', id: eff };
    orchestrator.setPlanModelSnapshot(rec.effectiveVariant ? { ...ref, variant: rec.effectiveVariant } : ref);
  } else if (fallbackModel !== undefined) {
    try {
      orchestrator.setPlanModelSnapshot(fallbackModel);
    } catch {}
  }
}

/**
 * `approve [--intake ID] [--retry <job> | --relaunch <job>] [--checkpoint <type>]`
 * Public CLI equivalent of `mc_plan_approve` (which is MCP-only): clears an
 * `on_error` (or supervisor) pause so `resume --intake` can proceed, or
 * approves a retry/relaunch after a manual/agent fix. Same validation and
 * authorization as the MCP path: retry/relaunch are mutually exclusive,
 * the target must exist and be in a retryable state, touchSet relaunch is
 * restricted to touchSet failures, and manual-fix retries re-validate the
 * touchSet before proceeding. Fail-closed: unknown intake, missing plan,
 * or a non-paused plan throws explicitly — never a silent success.
 */
export async function approveIntake(args: string[], deps?: AutoCommandDeps): Promise<string> {
  void deps;
  const { flags } = parseFlags(args);
  const retry = flags.get('retry');
  const relaunch = flags.get('relaunch');
  const checkpointFlag = flags.get('checkpoint');
  if (retry !== undefined && retry !== '' && relaunch !== undefined && relaunch !== '') {
    throw new Error('Cannot specify both "retry" and "relaunch". Use "retry" for manual fixes (re-validates) or "relaunch" to spawn an agent to fix violations.');
  }
  const record = await resolveIntake(flags);
  const repoRoot = resolveRepoRoot((record as unknown as { repo?: string }).repo ?? getActiveRepoRoot() ?? undefined);
  return await withRepoRoot(repoRoot, async () => {
    const [{ loadPlan, savePlan }, { loadConfig }, { validateTouchSet }] = await Promise.all([
      import('../lib/plan-state'),
      import('../lib/config'),
      import('../lib/merge-train'),
    ]);
    const plan = await loadPlan(repoRoot);
    if (!plan) {
      throw new Error('No active plan to approve');
    }
    const targetJobName = (retry !== undefined && retry !== '' ? retry : undefined) ?? (relaunch !== undefined && relaunch !== '' ? relaunch : undefined);
    if (targetJobName) {
      const job = plan.jobs.find((j) => j.name === targetJobName);
      if (!job) {
        throw new Error(`Job "${targetJobName}" not found in plan`);
      }
      if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
        throw new Error(`Job "${targetJobName}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
      }
    }

    if (plan.status === 'paused' && plan.checkpoint) {
      const checkpoint = (checkpointFlag || plan.checkpoint) as 'pre_merge' | 'on_error' | 'pre_pr';
      const config = await loadConfig();

      if (relaunch !== undefined && relaunch !== '') {
        const ctx = plan.checkpointContext;
        if (!ctx || ctx.failureKind !== 'touchset') {
          throw new Error(`Job "${relaunch}" was not failed due to a touchSet violation — use "retry" instead.`);
        }
        if (ctx.jobName !== relaunch) {
          throw new Error(`Checkpoint was set for job "${ctx.jobName}", not "${relaunch}".`);
        }
        plan.status = 'running';
        plan.checkpoint = null;
        plan.checkpointContext = null;
        await savePlan(plan, repoRoot);
        const [{ Orchestrator }, { JobMonitor }, { getCurrentModel }] = await Promise.all([
          import('../lib/orchestrator'),
          import('../lib/monitor'),
          import('../lib/model-tracker'),
        ]);
        const orchestrator = new Orchestrator(new JobMonitor(), config);
        const ctl = orchestrator as unknown as {
          setRepoRoot: (r: string) => void;
          applyCeiling: (c: { maxParallel?: number; testCommand?: string }) => void;
          setPlanModelSnapshot: (m: unknown) => void;
          relaunchJobForCorrection: (name: string, violations: string[], patterns: string[]) => Promise<void>;
          resumePlan: (r?: string) => Promise<void>;
          shutdown: () => void;
        };
        ctl.setRepoRoot(repoRoot);
        applyEffectiveConfig(ctl, record, (() => { try { return getCurrentModel(); } catch { return undefined; } })());
        await ctl.relaunchJobForCorrection(relaunch, ctx.touchSetViolations ?? [], ctx.touchSetPatterns ?? []);
        try {
          await ctl.resumePlan(repoRoot);
        } finally {
          ctl.shutdown();
        }
        return [
          `Checkpoint "${checkpoint}" cleared. Job "${relaunch}" relaunched with correction prompt.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'The agent will fix touchSet violations in the existing worktree.',
          'Use follow to monitor progress.',
        ].join('\n');
      }

      if (retry !== undefined && retry !== '') {
        const job = plan.jobs.find((j) => j.name === retry)!;
        const ctx = plan.checkpointContext;
        if (ctx?.failureKind === 'touchset' && ctx.jobName === retry) {
          if (job.touchSet && job.touchSet.length > 0 && job.branch && plan.integrationBranch) {
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet);
            if (!validation.valid && validation.violations) {
              throw new Error(
                `Job "${retry}" still has touchSet violations after manual fix:\n` +
                `  Violations: ${validation.violations.join(', ')}\n` +
                `  Allowed: ${job.touchSet.join(', ')}\n` +
                `Fix the remaining violations and retry again.`,
              );
            }
          }
        }
        const retryJob = plan.jobs.find((j) => j.name === retry)!;
        retryJob.status = 'ready_to_merge';
        retryJob.error = undefined;
        plan.status = 'running';
        plan.checkpoint = null;
        plan.checkpointContext = null;
        await savePlan(plan, repoRoot);
        const [{ Orchestrator }, { JobMonitor }, { getCurrentModel }] = await Promise.all([
          import('../lib/orchestrator'),
          import('../lib/monitor'),
          import('../lib/model-tracker'),
        ]);
        const orchestrator = new Orchestrator(new JobMonitor(), config);
        const ctl = orchestrator as unknown as {
          setRepoRoot: (r: string) => void;
          applyCeiling: (c: { maxParallel?: number; testCommand?: string }) => void;
          setPlanModelSnapshot: (m: unknown) => void;
          resumePlan: (r?: string) => Promise<void>;
          shutdown: () => void;
        };
        ctl.setRepoRoot(repoRoot);
        applyEffectiveConfig(ctl, record, (() => { try { return getCurrentModel(); } catch { return undefined; } })());
        try {
          await ctl.resumePlan(repoRoot);
        } finally {
          ctl.shutdown();
        }
        return [
          `Checkpoint "${checkpoint}" cleared. Job "${retry}" reset to ready_to_merge.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'Use follow to monitor progress.',
        ].join('\n');
      }

      const ctx = plan.checkpointContext;
      if (ctx?.failureKind === 'touchset') {
        const job = plan.jobs.find((j) => j.name === ctx.jobName);
        if (job && job.status === 'failed') {
          job.status = 'ready_to_merge';
          job.error = undefined;
        }
      }
      plan.status = 'running';
      plan.checkpoint = null;
      plan.checkpointContext = null;
      await savePlan(plan, repoRoot);
      const [{ Orchestrator }, { JobMonitor }, { getCurrentModel }] = await Promise.all([
        import('../lib/orchestrator'),
        import('../lib/monitor'),
        import('../lib/model-tracker'),
      ]);
      const orchestrator = new Orchestrator(new JobMonitor(), config);
      const ctl = orchestrator as unknown as {
        setRepoRoot: (r: string) => void;
        applyCeiling: (c: { maxParallel?: number; testCommand?: string }) => void;
        setPlanModelSnapshot: (m: unknown) => void;
        resumePlan: (r?: string) => Promise<void>;
        shutdown: () => void;
      };
      ctl.setRepoRoot(repoRoot);
      applyEffectiveConfig(ctl, record, (() => { try { return getCurrentModel(); } catch { return undefined; } })());
      try {
        await ctl.resumePlan(repoRoot);
      } finally {
        ctl.shutdown();
      }
      const acceptMsg = ctx?.failureKind === 'touchset' ? ` TouchSet violations for job "${ctx.jobName}" accepted.` : '';
      return [
        `Checkpoint "${checkpoint}" cleared.${acceptMsg} Plan "${plan.name}" resuming (intake ${record.id}).`,
        '',
        `  ID:   ${plan.id}`,
        `  Mode: ${plan.mode}`,
        '',
        'Use follow to monitor progress.',
      ].join('\n');
    }

    if (plan.status !== 'pending') {
      throw new Error(`Plan "${plan.name}" is not pending or paused (current status: ${plan.status})`);
    }

    const [{ loadConfig: loadCfg }, { createIntegrationBranch }, { resolvePostCreateHook }] = await Promise.all([
      import('../lib/config'),
      import('../lib/integration'),
      import('../lib/worktree-setup'),
    ]);
    const config = await loadCfg();
    const integrationPostCreate = resolvePostCreateHook(config.worktreeSetup);
    const integration = plan.baseBranch
      ? await createIntegrationBranch(plan.id, integrationPostCreate, plan.baseBranch)
      : await createIntegrationBranch(plan.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;
    plan.status = 'running';
    await savePlan(plan, repoRoot);
    const [{ Orchestrator }, { JobMonitor }, { getCurrentModel }] = await Promise.all([
      import('../lib/orchestrator'),
      import('../lib/monitor'),
      import('../lib/model-tracker'),
    ]);
    const orchestrator = new Orchestrator(new JobMonitor(), config);
    const ctl = orchestrator as unknown as {
      setRepoRoot: (r: string) => void;
      applyCeiling: (c: { maxParallel?: number; testCommand?: string }) => void;
      setPlanModelSnapshot: (m: unknown) => void;
      resumePlan: (r?: string) => Promise<void>;
      shutdown: () => void;
    };
    ctl.setRepoRoot(repoRoot);
    applyEffectiveConfig(ctl, record, (() => { try { return getCurrentModel(); } catch { return undefined; } })());
    try {
      await ctl.resumePlan(repoRoot);
    } finally {
      ctl.shutdown();
    }
    return [
      `Plan "${plan.name}" approved and started (intake ${record.id}).`,
      '',
      `  ID:   ${plan.id}`,
      `  Mode: ${plan.mode}`,
      `  Jobs: ${plan.jobs.length}`,
      '',
      'Use follow to monitor progress.',
    ].join('\n');
  });
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
  // F02: resume inside the intake's repo scope (third-folder resume never touches launcher state).
  const repoRoot = resolveRepoRoot((record as unknown as { repo?: string }).repo ?? getActiveRepoRoot() ?? undefined);
  const generate = deps?.generate ?? (await import('../lib/auto-plan')).createRunPlannerGenerate();
  const resumeFn =
    deps?.resumeAutonomous ??
    (async (intakeId: string) => {
      return await withRepoRoot(repoRoot, async () => {
        const [{ Orchestrator }, { JobMonitor }, { loadConfig }] = await Promise.all([
          import('../lib/orchestrator'),
          import('../lib/monitor'),
          import('../lib/config'),
        ]);
        const config = await loadConfig();
        const orchestrator = new Orchestrator(new JobMonitor(), config);
        // F07: awaiting-plan generates via the model (never "no active plan" vazio).
        return (orchestrator as unknown as { resumeAutonomousIntake: (id: string, g?: unknown) => Promise<string> }).resumeAutonomousIntake(intakeId, generate);
      });
    });
  const progress = await withRepoRoot(repoRoot, async () => resumeFn(record.id));
  return [
    `Resumed intake ${record.id} without new JSON (no duplicated workers, no reintegration).`,
    progress,
  ].join('\n');
}
