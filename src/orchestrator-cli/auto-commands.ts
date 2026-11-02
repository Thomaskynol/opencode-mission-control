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
  appendAutoDecision,
  appendAutoQuestion,
  setAutoNextSteps,
  setAutoIntakeStatus,
  type AutoIntakeRecord,
} from '../lib/durable-state';
import {
  loadPlan,
  claimConductorLease,
  readConductorLease,
  verifyConductorLease,
  recordHeartbeat,
  isConductorPidAlive,
  reapConductorLeaseIfDead,
  takeoverConductorLease,
  type PlanFencing,
  DEFAULT_CONDUCTOR_MAX_HEARTBEAT_MS,
  DEFAULT_CONDUCTOR_MAX_PROGRESS_MS,
} from '../lib/plan-state';
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

export interface ConductorEvidence {
  live: number;
  total: number;
}

export interface AutoCommandDeps {
  generate?: PlannerGenerate;
  startAutonomous?: (
    input: AutoIntakeInput,
    generate: PlannerGenerate,
  ) => Promise<{ intakeId: string; tasks: string[]; launched: boolean }>;
  resumeAutonomous?: (intakeId: string) => Promise<string>;
  /**
   * Independent worker-liveness check used by the approve handoff. Defaults
   * to a best-effort tmux pane scan (never throws). Tests inject a stub.
   */
  verifyWorkers?: () => Promise<ConductorEvidence>;
  /**
   * Persistent-conductor starter used by the approve handoff. Defaults to a
   * detached `resume --intake` driver that survives the one-shot controller's
   * shutdown (child_process + CLI only — no orchestrator.ts dependency: the
   * transfer never relies on the temp instance staying alive). Tests inject a
   * stub that spawns a real lightweight child (no tmux needed) so possession
   * is verifiable via pid liveness.
   */
  spawnConductor?: (intakeId: string, repoRoot: string) => Promise<PersistentConductor>;
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
    // R04: the kept entry already carries docs/context, ceiling and the
    // effective model — a crash here still resumes the complete entry.
    const now = new Date().toISOString();
    let effModel: string | undefined;
    let effVariant: string | undefined;
    try {
      const { resolveEffectiveModelRef } = await import('../lib/auto-plan');
      const eff = resolveEffectiveModelRef();
      effModel = `${eff.providerID}/${eff.id}`;
      effVariant = eff.variant;
    } catch {}
    const record: AutoIntakeRecord = {
      id: randomUUID(),
      request,
      repo,
      targetBranch,
      ceiling: input.ceiling,
      ...(input.docs?.length ? { docs: input.docs } : {}),
      requirements: [],
      decisions: [`model failed: ${error instanceof Error ? error.message : String(error)}`],
      questions: [],
      nextSteps: [`resume without new JSON: bun ${cliPath()} resume --intake <id>`],
      status: 'awaiting-plan',
      createdAt: now,
      updatedAt: now,
      ...(effModel ? { effectiveModel: effModel } : {}),
      ...(effVariant ? { effectiveVariant: effVariant } : {}),
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
  try {
    (orchestrator as unknown as { applyCeiling?: (c: unknown) => void }).applyCeiling?.(rec.ceiling);
  } catch {}
  const eff = rec.effectiveModel?.trim();
  if (eff) {
    // Same `provider/model[#variant]` grammar as parseModelRef: the persisted
    // effectiveModel string is variant-less (variant rides effectiveVariant),
    // but a `#variant` suffix must survive instead of polluting the id.
    const hash = eff.indexOf('#');
    const base = hash > 0 ? eff.slice(0, hash) : eff;
    const inlineVariant = hash > 0 ? eff.slice(hash + 1).trim() : undefined;
    const slash = base.indexOf('/');
    const ref =
      slash > 0
        ? { providerID: base.slice(0, slash), id: base.slice(slash + 1) }
        : { providerID: 'unknown', id: base };
    const variant = rec.effectiveVariant || inlineVariant;
    try {
      (orchestrator as unknown as { setPlanModelSnapshot?: (m: unknown) => void }).setPlanModelSnapshot?.(
        variant ? { ...ref, variant } : ref,
      );
    } catch {}
  } else if (fallbackModel !== undefined) {
    try {
      orchestrator.setPlanModelSnapshot(fallbackModel);
    } catch {}
  }
}

/**
 * Best-effort worker continuity check: counts running-job tmux panes that
 * are still alive. Independent of any single Orchestrator instance's
 * self-report, so a dying temp controller cannot vouch for itself. Never
 * throws — unknown liveness is reported as 0/0, not as a false negative.
 */
async function checkWorkerContinuity(): Promise<ConductorEvidence> {
  try {
    const [{ getRunningJobs }, { isPaneRunning }] = await Promise.all([
      import('../lib/job-state'),
      import('../lib/tmux'),
    ]);
    const jobs = await getRunningJobs().catch(() => []);
    let live = 0;
    for (const job of jobs) {
      try {
        if (job.tmuxTarget && (await isPaneRunning(job.tmuxTarget))) live++;
      } catch {
        // Best-effort per pane: one unreadable target never fails the check.
      }
    }
    return { live, total: jobs.length };
  } catch {
    // Best-effort: without job state there is no evidence either way.
    return { live: 0, total: 0 };
  }
}

/**
 * R04: verifiable conductor handoff after a CLI resumePlan.
 * A one-shot CLI cannot stay alive as the conductor, so approve/resume must
 * not do resumePlan+shutdown silently: this re-reads the plan AFTER the
 * resume, verifies what actually continues (independent worker liveness +
 * plan state, never the temp instance's self-report alone), persists the
 * transfer as an intake decision, and returns the proof. The record is
 * fail-closed: when it cannot persist, this throws instead of reporting a
 * handoff that never landed. The caller shuts down its own loops only after
 * this confirmation (CLI hygiene), but continuity never depends on the temp
 * instance: in-flight workers persist in tmux and the next driver pass
 * resumes the persisted plan without duplicating them.
 */
export interface PersistentConductor {
  pid: number;
  command: string;
  /** Fencing identity: the lease token at spawn time (proves assumption). */
  token?: string;
  /** Fencing identity: the lease epoch at spawn time (old leaders rejected). */
  epoch?: number;
}

/** True when the pid answers to signal 0 (alive). Never throws. */
export function isConductorAlive(pid: number): boolean {
  // pid <= 0 is never a conductor: kill(-1, 0) addresses every process the
  // user may signal instead of probing one pid, so it must not count as alive.
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * G2 legitimate takeover for approve: never `rm` the lease manually.
 * - No lease (or foreign plan): no fencing needed → undefined.
 * - Same pid: already the owner → explicit fencing for the write.
 * - Dead holder: auto-reap (safe direction only, audited) → fencing.
 * - Live holder: requires explicit `takeover: true` (i.e. `--takeover`);
 *   without it this throws fail-closed with an actionable message naming
 *   the flag. With it, epoch bump + rotation + `conductor-takeover` audit.
 */
export async function ensureApproveFencing(
  planId: string,
  repoRoot: string,
  opts?: { takeover?: boolean; command?: string },
): Promise<PlanFencing | undefined> {
  const lease = await readConductorLease(repoRoot).catch(() => null);
  if (!lease || lease.planId !== planId) return undefined;
  if (lease.pid === process.pid) {
    return { token: lease.token, epoch: lease.epoch, pid: process.pid };
  }
  if (!isConductorPidAlive(lease.pid)) {
    const reaped = await reapConductorLeaseIfDead(planId, repoRoot, {
      pid: process.pid,
      command: opts?.command ?? 'approve (auto-reap dead holder)',
      owner: 'approve:auto-reap',
    }).catch(() => null);
    if (reaped?.reaped && reaped.next) {
      return { token: reaped.next.token, epoch: reaped.next.epoch, pid: process.pid };
    }
    // Race: holder came alive or no lease — re-read once; a live holder
    // still needs the explicit flag below.
    const fresh = await readConductorLease(repoRoot).catch(() => null);
    if (!fresh || fresh.planId !== planId) return undefined;
    if (fresh.pid === process.pid) return { token: fresh.token, epoch: fresh.epoch, pid: process.pid };
    if (!isConductorPidAlive(fresh.pid)) return undefined;
    if (!opts?.takeover) {
      throw new Error(
        `Conductor lease held by live pid ${fresh.pid} (epoch ${fresh.epoch}, owner ${fresh.owner}). ` +
          `Refusing approve without explicit takeover — retry with --takeover to assume ownership ` +
          `(epoch bump + audit, stale holder fenced). Without --takeover this stays fail-closed; never rm the lease manually.`,
      );
    }
    const take = await takeoverConductorLease(planId, process.pid, opts.command ?? 'approve --takeover', 'approve:takeover', repoRoot, 'approve --takeover (explicit operator intent)');
    return { token: take.lease.token, epoch: take.lease.epoch, pid: process.pid };
  }
  if (!opts?.takeover) {
    throw new Error(
      `Conductor lease held by live pid ${lease.pid} (epoch ${lease.epoch}, owner ${lease.owner}). ` +
        `Refusing approve without explicit takeover — retry with --takeover to assume ownership ` +
        `(epoch bump + audit, stale holder fenced). Without --takeover this stays fail-closed; never rm the lease manually.`,
    );
  }
  const take = await takeoverConductorLease(planId, process.pid, opts.command ?? 'approve --takeover', 'approve:takeover', repoRoot, 'approve --takeover (explicit operator intent)');
  return { token: take.lease.token, epoch: take.lease.epoch, pid: process.pid };
}

/**
 * Conductor freshness budgets (configurable via env, else plan-state
 * defaults). Handoff verification rejects stale holders — pid-alive alone
 * never suffices, and an old leader with a smaller epoch never passes.
 */
export const CONDUCTOR_MAX_HEARTBEAT_MS = DEFAULT_CONDUCTOR_MAX_HEARTBEAT_MS;
export const CONDUCTOR_MAX_PROGRESS_MS = DEFAULT_CONDUCTOR_MAX_PROGRESS_MS;

function conductorStaleOpts(): { maxHeartbeatMs: number; maxProgressMs: number } {
  const hb = Number(process.env.MC_MAX_HEARTBEAT_MS ?? process.env.MC_CONDUCTOR_MAX_HEARTBEAT_MS ?? CONDUCTOR_MAX_HEARTBEAT_MS);
  const pg = Number(process.env.MC_MAX_PROGRESS_MS ?? process.env.MC_CONDUCTOR_MAX_PROGRESS_MS ?? CONDUCTOR_MAX_PROGRESS_MS);
  return {
    maxHeartbeatMs: Number.isFinite(hb) && hb > 0 ? hb : CONDUCTOR_MAX_HEARTBEAT_MS,
    maxProgressMs: Number.isFinite(pg) && pg > 0 ? pg : CONDUCTOR_MAX_PROGRESS_MS,
  };
}

/**
 * Spawn the persistent conductor: a detached `resume --intake` driver that
 * survives this one-shot controller's shutdown. child_process + CLI only —
 * the transfer never depends on orchestrator.ts instance state (the temp
 * instance is shut down right after this confirms). Throws explicitly when
 * no live pid comes up, so the caller fails closed instead of declaring a
 * handoff nobody owns.
 */
export async function spawnPersistentConductor(
  intakeId: string,
  repoRoot: string,
  planId?: string,
): Promise<PersistentConductor> {
  const { spawn } = await import('node:child_process');
  const command = `resume --intake ${intakeId}`;
  // G3: silent death is forbidden. The detached driver logs stdout/stderr to
  // a persistent file (never stdio:ignore), so a crash leaves the reason on
  // disk; the handoff still fails closed when the lease never appears, but
  // the log explains WHY instead of dying mute. Masked spawn exceptions are
  // re-thrown with the log path attached — never swallowed.
  let logPath = '';
  let outFd: number | undefined;
  let errFd: number | undefined;
  try {
    const fs = await import('fs');
    const pathMod = await import('path');
    const dataDir = await getDataDir(repoRoot).catch(() => null);
    const dir = dataDir ?? repoRoot;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    logPath = pathMod.join(dir, `conductor-${intakeId}.log`);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn ${command} (by pid ${process.pid})\n`);
    outFd = fs.openSync(logPath, 'a');
    errFd = fs.openSync(logPath, 'a');
  } catch (error) {
    try { if (outFd !== undefined) (await import('fs')).closeSync(outFd); } catch {}
    try { if (errFd !== undefined && errFd !== outFd) (await import('fs')).closeSync(errFd); } catch {}
    throw new Error(
      `persistent conductor for intake ${intakeId} did not start: cannot open conductor log (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [cliPath(), 'resume', '--intake', intakeId], {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      cwd: repoRoot,
      env: { ...process.env },
    });
  } catch (error) {
    try { (await import('fs')).appendFileSync(logPath, `[${new Date().toISOString()}] spawn failed: ${error instanceof Error ? error.message : String(error)}\n`); } catch {}
    try { if (outFd !== undefined) (await import('fs')).closeSync(outFd); } catch {}
    try { if (errFd !== undefined && errFd !== outFd) (await import('fs')).closeSync(errFd); } catch {}
    throw new Error(
      `persistent conductor for intake ${intakeId} did not start: ${error instanceof Error ? error.message : String(error)} (log: ${logPath})`,
    );
  }
  try {
    child.unref();
  } catch {
    // Best-effort: detachment already requested; an unref failure must not
    // mask a live pid.
  }
  // Parent no longer needs the fds; the child keeps its own copies.
  try { (await import('fs')).closeSync(outFd!); } catch {}
  try { if (errFd !== outFd) (await import('fs')).closeSync(errFd!); } catch {}
  try { (await import('fs')).appendFileSync(logPath, `[${new Date().toISOString()}] spawned pid ${child.pid}\n`); } catch {}
  const pid = child.pid;
  if (!pid || !isConductorAlive(pid)) {
    try { (await import('fs')).appendFileSync(logPath, `[${new Date().toISOString()}] no live pid after spawn\n`); } catch {}
    throw new Error(
      `persistent conductor for intake ${intakeId} did not start (no live pid; log: ${logPath}).`,
    );
  }
  // Provisional possession: the new driver claims the lease itself on boot
  // (the integrator wires claimConductorLease into the resume path). Until
  // then the spawner records its intent so the handoff can verify a durable
  // claim exists — pid-alive alone never counts (the handoff re-reads the
  // lease with token/epoch+frescor and fails closed when it is absent).
  if (planId) {
    try {
      const lease = await claimConductorLease(planId, pid, command, `driver-spawn:${process.pid}`, repoRoot);
      try {
        const confirmed = await readConductorLease(repoRoot).catch(() => null);
        if (confirmed && confirmed.planId === planId && confirmed.pid === pid) {
          return { pid, command, token: confirmed.token, epoch: confirmed.epoch };
        }
      } catch {}
      return { pid, command, token: lease.token, epoch: lease.epoch };
    } catch (error) {
      // G3: never mask — record why the provisional claim failed; the
      // handoff verification below still reports absence fail-closed, but
      // the reason is now visible instead of swallowed.
      console.warn(`[MC] provisional conductor claim failed for plan ${planId} pid ${pid}: ${error instanceof Error ? error.message : String(error)} (log: ${logPath})`);
    }
  }
  return { pid, command };
}

/**
 * Wait for the new conductor's proof of assumption: a lease with the same
 * planId+pid re-readable from disk, verified with token/epoch+frescor
 * (stale holders and old leaders with a smaller epoch are rejected — never
 * assumed). The driver writes it via claimConductorLease on boot; the temp
 * confirms before detaching. Returns the lease owner+timestamp for the
 * handoff line, or null on timeout.
 */
async function awaitConductorLease(
  planId: string,
  pid: number,
  repoRoot: string,
  timeoutMs = 2000,
  expected?: { token?: string; epoch?: number },
): Promise<{ owner: string; acquiredAt: string; epoch: number; lastHeartbeat: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const owned = await verifyConductorLease(planId, pid, repoRoot, {
      ...(expected?.token !== undefined ? { token: expected.token } : {}),
      ...(expected?.epoch !== undefined ? { epoch: expected.epoch } : {}),
      ...conductorStaleOpts(),
    }).catch(() => false);
    if (owned) {
      const lease = await readConductorLease(repoRoot).catch(() => null);
      if (lease && lease.planId === planId && lease.pid === pid) {
        return { owner: lease.owner, acquiredAt: lease.acquiredAt, epoch: lease.epoch, lastHeartbeat: lease.lastHeartbeat };
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Profile/model line preserved in every handoff (never silently dropped):
 * the effective triple (variant included) plus the ceiling the reactivated
 * reconciler runs under. Unpinned is stated explicitly, never implied.
 */
function formatEffectiveConfigForHandoff(record: AutoIntakeRecord): string {
  const rec = record as unknown as {
    effectiveModel?: string;
    effectiveVariant?: string;
    ceiling?: { maxParallel?: number; testCommand?: string };
  };
  const model = rec.effectiveModel?.trim();
  const variant = rec.effectiveVariant?.trim();
  const triple = model ? `${model}${variant ? `#${variant}` : ''}` : '(unpinned, TUI default)';
  const c = rec.ceiling;
  const ceiling = c
    ? `maxParallel=${c.maxParallel ?? 'default'} testCommand=${c.testCommand ?? 'none'}`
    : 'default';
  return `model ${triple}, ceiling ${ceiling}`;
}
async function recordConductorHandoff(
  ctl: {
    resumePlan: (r?: string) => Promise<void>;
    autonomousProgress?: (id?: string) => Promise<string>;
  },
  record: AutoIntakeRecord,
  repoRoot: string,
  action: string,
  opts?: {
    verifyWorkers?: () => Promise<ConductorEvidence>;
    spawnConductor?: (intakeId: string, repoRoot: string) => Promise<PersistentConductor>;
  },
): Promise<string> {
  await ctl.resumePlan(repoRoot);
  const { loadPlan } = await import('../lib/plan-state');
  const plan = await loadPlan(repoRoot).catch(() => null);
  let workers: ConductorEvidence = { live: 0, total: 0 };
  try {
    workers = await (opts?.verifyWorkers ?? checkWorkerContinuity)();
  } catch {
    // Best-effort: worker evidence is reported, never fatal.
    workers = { live: 0, total: 0 };
  }
  const profileLine = formatEffectiveConfigForHandoff(record);
  let handoff: string;
  if (!plan) {
    handoff = `${action}: no active plan in ${repoRoot} — nothing to conduct (intake ${record.id} kept). ${profileLine}.`;
  } else if (plan.status === 'paused' || plan.checkpoint) {
    handoff = `${action}: pause respected (plan ${plan.id} [${plan.status}] checkpoint ${plan.checkpoint ?? 'none'}) — no conductor started; approve to continue. ${profileLine}.`;
  } else if (plan.status === 'completed' || plan.status === 'failed' || plan.status === 'canceled') {
    handoff = `${action}: plan ${plan.id} [${plan.status}] is terminal — no conductor needed; see the final report. ${profileLine}.`;
  } else {
    // Active plan: a persistent conductor must own the work BEFORE the
    // one-shot controller detaches. Workers alive in tmux never assume the
    // coordinator role on their own, and the temp instance dies on shutdown —
    // so spawn/confirm a detached driver (auto-spawned, never a manual step
    // for the user) and fail explicitly when nobody assumes responsibility.
    // Any active plan with unfinished work needs an owner — including
    // queued/waiting_deps/completed/ready_to_merge with zero live workers
    // (sonda 12): there is no "next pass" without someone to drive it.
    const running = (plan.jobs ?? []).filter(
      (j) => j.status === 'running' || j.status === 'merging',
    ).length;
    // Idempotent reuse: a live lease for the same plan is the owner — never
    // spawn a second driver when the first is still alive. Verified with
    // token/epoch+frescor: an old leader with a smaller epoch is rejected,
    // never reused (fencing).
    const existing = await readConductorLease(repoRoot).catch(() => null);
    let conductor: PersistentConductor | null = null;
    let leaseProof: { owner: string; acquiredAt: string; epoch: number; lastHeartbeat: string } | null = null;
    if (existing && existing.planId === plan.id && isConductorAlive(existing.pid)) {
      const stillOwned = await verifyConductorLease(plan.id, existing.pid, repoRoot, {
        token: existing.token,
        epoch: existing.epoch,
        ...conductorStaleOpts(),
      }).catch(() => false);
      if (stillOwned) {
        conductor = { pid: existing.pid, command: existing.command, token: existing.token, epoch: existing.epoch };
        leaseProof = { owner: existing.owner, acquiredAt: existing.acquiredAt, epoch: existing.epoch, lastHeartbeat: existing.lastHeartbeat };
        // Periodic liveness on reuse: the re-verified owner heartbeats now.
        try {
          await recordHeartbeat(plan.id, existing.pid, repoRoot, { token: existing.token });
        } catch {
          // Best-effort: the verify above already proved ownership.
        }
      }
    }
    if (!conductor) {
      const spawnFn = opts?.spawnConductor ?? ((id, root) => spawnPersistentConductor(id, root, plan.id));
      try {
        conductor = await spawnFn(record.id, repoRoot);
      } catch (error) {
        throw new Error(
          `handoff not confirmed for intake ${record.id}: no persistent conductor assumed responsibility ` +
            `(spawn failed: ${error instanceof Error ? error.message : String(error)}; ` +
            `workers live ${workers.live}/${workers.total}, ${running} job(s) in flight) — refusing to declare success.`,
        );
      }
      if (!conductor || !Number.isFinite(conductor.pid) || !isConductorAlive(conductor.pid)) {
        throw new Error(
          `handoff not confirmed for intake ${record.id}: conductor pid ${conductor?.pid} not alive after spawn ` +
            `(workers live ${workers.live}/${workers.total}) — refusing to declare success.`,
        );
      }
      // Possession proof: pid-alive alone never suffices — the new conductor
      // must have claimed the plan lease (it writes it on boot; the default
      // spawner records a provisional claim with token/epoch). The temp
      // re-reads with token/epoch+frescor before detaching and fails closed
      // on absence or fencing mismatch (sonda 13).
      leaseProof = await awaitConductorLease(plan.id, conductor.pid, repoRoot, 2000, {
        ...(conductor.token !== undefined ? { token: conductor.token } : {}),
        ...(conductor.epoch !== undefined ? { epoch: conductor.epoch } : {}),
      });
      if (!leaseProof) {
        throw new Error(
          `handoff not confirmed for intake ${record.id}: conductor pid ${conductor.pid} alive but never claimed plan ${plan.id} ` +
            `(no lease; workers live ${workers.live}/${workers.total}) — refusing to declare success. ` +
            `Plan stays ${plan.status}; the next resume may assume it.`,
        );
      }
    }
    handoff =
      `${action}: conductor detached driver pid ${conductor.pid} (${conductor.command}, auto-spawned by reporter pid ${process.pid}, lease ${leaseProof.owner}@${leaseProof.acquiredAt} epoch ${leaseProof.epoch} token-verified heartbeat ${leaseProof.lastHeartbeat}) — ` +
      `plan ${plan.id} [${plan.status}] owned via persisted state (intake ${record.id}); ` +
      `workers live ${workers.live}/${workers.total} (tmux); ${profileLine}; ` +
      `one-shot controller detaches after this sync pass — ` +
      `in-flight workers persist and the next driver pass resumes without duplication.`;
  }
  // Fail-closed: a handoff that cannot persist is thrown, never announced.
  try {
    await appendAutoDecision(record.id, `handoff: ${handoff}`);
  } catch (error) {
    throw new Error(
      `handoff not confirmed for intake ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let progress = '';
  try {
    if (ctl.autonomousProgress) progress = await ctl.autonomousProgress(record.id);
  } catch {}
  return [handoff, progress].filter(Boolean).join('\n');
}

/**
 * `approve [--intake ID] [--retry <job> | --relaunch <job>] [--checkpoint <type>] [--takeover]`
 * Public CLI equivalent of `mc_plan_approve` (which is MCP-only): clears an
 * `on_error` (or supervisor) pause so `resume --intake` can proceed, or
 * approves a retry/relaunch after a manual/agent fix. Same validation and
 * authorization as the MCP path: retry/relaunch are mutually exclusive,
 * the target must exist and be in a retryable state, touchSet relaunch is
 * restricted to touchSet failures, and manual-fix retries re-validate the
 * touchSet before proceeding. Fail-closed: unknown intake, missing plan,
 * or a non-paused plan throws explicitly — never a silent success.
 *
 * G2: when a conductor lease is held by another live pid, approve without
 * `--takeover` is rejected fail-closed (never `rm` the lease manually);
 * `approve --takeover` explicitly assumes ownership (epoch bump + rotation
 * + `conductor-takeover` audit) and then proceeds. A dead holder is
 * auto-reaped (safe direction, audited) without requiring the flag.
 */
export async function approveIntake(args: string[], deps?: AutoCommandDeps): Promise<string> {
  const { flags } = parseFlags(args);
  const retry = flags.get('retry');
  const relaunch = flags.get('relaunch');
  const checkpointFlag = flags.get('checkpoint');
  const wantTakeover = flags.has('takeover');
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
    // Idempotent repetition: a plan already running without checkpoint already
    // applied the approve — re-verify the conductor (reusing the live lease)
    // instead of throwing or duplicating work. A new retry/relaunch target on
    // a running plan still falls through to the explicit errors below.
    if (plan.status === 'running' && !plan.checkpoint) {
      // Guard: a running plan with no plan.json in this repo's scope is a leaked
      // `loadPlan` mock from another suite (full-run pollution), not this intake's
      // plan — fail closed like HEAD ("not pending or paused") instead of handing
      // off a phantom. Real repeats always persist plan.json via savePlan/startPlan.
      let planFileExists = true;
      try {
        const dd = await getDataDir(repoRoot).catch(() => null);
        if (dd) {
          const { join } = await import('path');
          planFileExists = await Bun.file(join(dd, 'plan.json')).exists();
        }
      } catch {
        planFileExists = true;
      }
      const target = targetJobName ? plan.jobs.find((j) => j.name === targetJobName) : undefined;
      const targetDone =
        !targetJobName ||
        target?.status === 'ready_to_merge' ||
        target?.status === 'running' ||
        target?.status === 'merging' ||
        target?.status === 'merged';
      if (targetJobName && !target) {
        throw new Error(`Job "${targetJobName}" not found in plan`);
      }
      if (targetDone && planFileExists) {
        const [{ loadConfig: loadCfgIdem }] = await Promise.all([import('../lib/config')]);
        const configIdem = await loadCfgIdem();
        const [{ Orchestrator: OrchIdem }, { JobMonitor: MonIdem }, { getCurrentModel: curModelIdem }] =
          await Promise.all([
            import('../lib/orchestrator'),
            import('../lib/monitor'),
            import('../lib/model-tracker'),
          ]);
        const orchestratorIdem = new OrchIdem(new MonIdem(), configIdem);
        const ctlIdem = orchestratorIdem as unknown as {
          setRepoRoot?: (r: string) => void;
          repoRoot?: string;
          applyCeiling: (c: { maxParallel?: number; testCommand?: string }) => void;
          setPlanModelSnapshot: (m: unknown) => void;
          resumePlan: (r?: string) => Promise<void>;
          shutdown?: () => void;
        };
        // Robust construction: real Orchestrator has setRepoRoot; a leaked test
        // double may only carry the property. Never throw "not a function" here.
        try {
          if (typeof ctlIdem.setRepoRoot === 'function') ctlIdem.setRepoRoot(repoRoot);
          else ctlIdem.repoRoot = repoRoot;
        } catch {
          (ctlIdem as unknown as { repoRoot: string }).repoRoot = repoRoot;
        }
        applyEffectiveConfig(ctlIdem as never, record, (() => { try { return curModelIdem(); } catch { return undefined; } })());
        let idemHandoff: string;
        try {
          idemHandoff = await recordConductorHandoff(ctlIdem as never, record, repoRoot, `approve/repeat ${targetJobName ?? 'resume'}`, { verifyWorkers: deps?.verifyWorkers, spawnConductor: deps?.spawnConductor });
        } catch (error) {
          try { ctlIdem.shutdown?.(); } catch {}
          throw error;
        }
        try { ctlIdem.shutdown?.(); } catch {}
        return [
          `Plan "${plan.name}" already running (intake ${record.id}) — handoff re-verified, no duplicate work.`,
          idemHandoff,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'Use follow to monitor progress.',
        ].join('\n');
      }
    }
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
      // G2: legitimate fencing for the approve write. Live holder without
      // --takeover throws here fail-closed (never manual rm); dead holder is
      // auto-reaped; --takeover bumps the epoch with audit.
      const approveFencing = await ensureApproveFencing(plan.id, repoRoot, {
        ...(wantTakeover ? { takeover: true as const } : {}),
        command: `approve${wantTakeover ? ' --takeover' : ''}${retry ? ` --retry ${retry}` : ''}${relaunch ? ` --relaunch ${relaunch}` : ''}`,
      });
      if (wantTakeover && approveFencing) {
        try {
          const held = await readConductorLease(repoRoot).catch(() => null);
          await appendAutoDecision(record.id, `conductor takeover: approve --takeover assumed plan ${plan.id} (epoch ${held?.epoch ?? '?'}, pid ${process.pid})`).catch(() => {});
        } catch {}
      }

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
        await savePlan(plan, repoRoot, approveFencing);
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
        let handoff: string;
        try {
          handoff = await recordConductorHandoff(ctl, record, repoRoot, `approve/relaunch ${relaunch}`, { verifyWorkers: deps?.verifyWorkers, spawnConductor: deps?.spawnConductor });
        } catch (error) {
          ctl.shutdown();
          throw error;
        }
        ctl.shutdown();
        return [
          `Checkpoint "${checkpoint}" cleared. Job "${relaunch}" relaunched with correction prompt.`,
          handoff,
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
        await savePlan(plan, repoRoot, approveFencing);
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
        let retryHandoff: string;
        try {
          retryHandoff = await recordConductorHandoff(ctl, record, repoRoot, `approve/retry ${retry}`, { verifyWorkers: deps?.verifyWorkers, spawnConductor: deps?.spawnConductor });
        } catch (error) {
          ctl.shutdown();
          throw error;
        }
        ctl.shutdown();
        return [
          `Checkpoint "${checkpoint}" cleared. Job "${retry}" reset to ready_to_merge.`,
          retryHandoff,
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
      await savePlan(plan, repoRoot, approveFencing);
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
      let clearHandoff: string;
      try {
        clearHandoff = await recordConductorHandoff(ctl, record, repoRoot, 'approve/clear', { verifyWorkers: deps?.verifyWorkers, spawnConductor: deps?.spawnConductor });
      } catch (error) {
        ctl.shutdown();
        throw error;
      }
      ctl.shutdown();
      const acceptMsg = ctx?.failureKind === 'touchset' ? ` TouchSet violations for job "${ctx.jobName}" accepted.` : '';
      return [
        `Checkpoint "${checkpoint}" cleared.${acceptMsg} Plan "${plan.name}" resuming (intake ${record.id}).`,
        clearHandoff,
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
    // G2: pending start also respects an existing lease (stale holder fenced).
    const startFencing = await ensureApproveFencing(plan.id, repoRoot, {
      ...(wantTakeover ? { takeover: true as const } : {}),
      command: `approve${wantTakeover ? ' --takeover' : ''} --start`,
    });
    await savePlan(plan, repoRoot, startFencing);
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
    let startHandoff: string;
    try {
      startHandoff = await recordConductorHandoff(ctl, record, repoRoot, 'approve/start', { verifyWorkers: deps?.verifyWorkers, spawnConductor: deps?.spawnConductor });
    } catch (error) {
      ctl.shutdown();
      throw error;
    }
    ctl.shutdown();
    return [
      `Plan "${plan.name}" approved and started (intake ${record.id}).`,
      startHandoff,
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
  // R04: verifiable handoff — `resume` stays as coordinator while driving an
  // active plan, so verify what is actually live and persist the transfer.
  const handoff = await withRepoRoot(repoRoot, async () => {
    const plan = await loadPlan(repoRoot).catch(() => null);
    let line: string;
    if (!plan) {
      line = `resume: no active plan in ${repoRoot} — nothing to conduct (intake ${record.id} kept).`;
    } else if (plan.status === 'paused' || plan.checkpoint) {
      line = `resume: pause respected (plan ${plan.id} [${plan.status}]) — returning without dispatch, approve to continue.`;
    } else if (plan.status === 'completed' || plan.status === 'failed' || plan.status === 'canceled') {
      line = `resume: plan ${plan.id} [${plan.status}] is terminal — no conductor needed; see the final report.`;
    } else {
      const running = plan.jobs.filter((j) => j.status === 'running' || j.status === 'merging').length;
      // Possession proof: the staying coordinator claims the lease for its own
      // pid (idempotent overwrite) and verifies it with token/epoch+frescor —
      // a resume that cannot persist its ownership fails explicitly instead
      // of declaring continuity. An old leader with a smaller epoch never
      // verifies here (fencing).
      try {
        const lease = await claimConductorLease(plan.id, process.pid, `resume --intake ${record.id}`, 'resume', repoRoot);
        const owned = await verifyConductorLease(plan.id, process.pid, repoRoot, {
          token: lease.token,
          epoch: lease.epoch,
          ...conductorStaleOpts(),
        }).catch(() => false);
        if (!owned) {
          throw new Error('lease failed fencing verification after claim (stale token/epoch)');
        }
        const confirmed = await readConductorLease(repoRoot).catch(() => null);
        if (!confirmed || confirmed.planId !== plan.id || confirmed.pid !== process.pid) {
          throw new Error('lease not re-readable after claim');
        }
        // Periodic proof from here on: heartbeat now, progress with the pass.
        try {
          await recordHeartbeat(plan.id, process.pid, repoRoot, { token: confirmed.token });
        } catch {}
        line = `resume: conductor live (plan ${plan.id} [${plan.status}], pid ${process.pid} lease resume@${confirmed.acquiredAt} epoch ${confirmed.epoch} token-verified heartbeat ${confirmed.lastHeartbeat}, ${running} job(s) in flight, state persisted; follow detaches, close never cancels).`;
      } catch (error) {
        throw new Error(
          `resume not confirmed for intake ${record.id}: conductor ownership failed (${error instanceof Error ? error.message : String(error)}). Plan stays ${plan.status}; retry resume to assume it.`,
        );
      }
    }
    await appendAutoDecision(record.id, `handoff: ${line}`).catch(() => {});
    return line;
  }).catch(() => '');
  return [
    `Resumed intake ${record.id} without new JSON (no duplicated workers, no reintegration).`,
    handoff,
    progress,
  ].filter(Boolean).join('\n');
}
