/**
 * M3 coordinator: the single judge of the observe → decide → dispatch →
 * gate → enqueue loop (scope: `m3-coordinator`).
 *
 * Read-only against M1/M2 lanes: it observes durable-state / jobs / plan
 * and monitor snapshots, decides with the same pinned Model.Ref triple
 * (never a silent fallback), dispatches through InstanceManager, holds
 * the merge behind a future reviewer gate, and only then enqueues into
 * the integration train. Parallelism is capped at 4–8.
 *
 * Guards enforced here: depth / fanout / no-push / no-fallback /
 * no-recursion. Outcome states stay explicit so an idle process is never
 * confused with a terminated model response, and a concluded job is
 * never confused with a verified or integrated one.
 */

import type { V2ModelRef } from './sdk-client.js';
import { evaluateDepthGuard, readInstanceDepth } from './instance-manager.js';

export const MIN_PARALLEL = 4;
export const MAX_PARALLEL = 8;

export interface ParallelBounds {
  /** Floor. Defaults to MIN_PARALLEL (4). */
  min?: number;
  /** Ceiling. Defaults to MAX_PARALLEL (8). */
  max?: number;
  /** Returned for undefined/non-finite input. Defaults to the active `min`. */
  defaultValue?: number;
}

/**
 * Clamp the configured parallelism into the contract window.
 * Defaults to the 4–8 window with a 4 fallback; pass `bounds` to run a
 * different window (smaller for debugging, larger for big machines).
 * Neither 4 nor 8 is hard-coded at the call sites.
 */
export function clampMaxParallel(raw?: number, bounds?: ParallelBounds): number {
  const min = bounds?.min ?? MIN_PARALLEL;
  const max = bounds?.max ?? MAX_PARALLEL;
  const fallback = bounds?.defaultValue ?? min;
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

/** Guards: refuse to fan out beyond the remaining parallel budget. */
export function evaluateFanoutGuard(requested: number, budget: number): void {
  if (requested > budget) {
    throw new Error(
      `Fanout guard: requested ${requested} dispatches but only ${budget} slot(s) remain within the parallel cap`,
    );
  }
}

const QUOTED_PATH = `"[^"]*"|'[^']*'|\\S+`;
const QUOTED_VALUE = `(?:"[^"]*"|'[^']*'|\\S+)`;
const PM_FLAGS = `(\\s+--\\S+(\\s+${QUOTED_VALUE})?)*`;

const PUSH_PATTERN = new RegExp(
  `(^|\\s)(git(\\s+-C\\s+(?:${QUOTED_PATH}))*\\s+push|gh\\s+(pr\\s+(create|merge)|repo\\s+fork)|(npm|pnpm|yarn)${PM_FLAGS}\\s+publish)(\\s|$)`,
  'i',
);

/**
 * Token-based git-push detector (handles `-C`, `-c`, `--git-dir`,
 * `--work-tree`, spaces/quotes and `git -C` forms that the regex above
 * misses). Aid only: no caller in `src/` enforces it unconditionally —
 * authorized pushes (`mc_pr`, `orchestrator.createPR`) must pass with
 * `humanAuth: true`, so the real barriers are `requireHumanAuth`
 * (`integration.ts`) for operator paths and `requiresHumanAuth` /
 * `PermissionPolicy` (`permission-policy.ts`) for worker shell commands.
 * This helper stays as defense-in-depth for contexts where a push must
 * never happen (prompts, internal merges).
 */
function stripGitQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function isGitPushArgs(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (stripGitQuotes(argv[i]).toLowerCase() !== 'git') continue;
    let j = i + 1;
    while (j < argv.length) {
      const raw = argv[j];
      const low = stripGitQuotes(raw).toLowerCase();
      if (low === '-c' || low === '--git-dir' || low === '--work-tree' || low === '--namespace' || low === '--super-prefix' || low === '--config-env') {
        // Flag with separate value: `git -C <dir>`, `git -c k=v`, `git --git-dir <dir>`.
        j += 2;
        continue;
      }
      if (
        low.startsWith('--git-dir=') ||
        low.startsWith('--work-tree=') ||
        low.startsWith('--namespace=') ||
        low.startsWith('--super-prefix=') ||
        low.startsWith('--config-env=')
      ) {
        j += 1;
        continue;
      }
      // `-C` (upper) is the worktree flag; lower-cased above already covers
      // both cases, kept here for readability of the original `-C` form.
      if (raw === '-C' || raw === '-c') {
        j += 2;
        continue;
      }
      if (low.startsWith('-')) {
        // Any other global flag without a separate value
        // (`--no-pager`, `-p`, `--bare`, ...).
        j += 1;
        continue;
      }
      break;
    }
    if (j < argv.length && stripGitQuotes(argv[j]).toLowerCase() === 'push') {
      return true;
    }
  }
  return false;
}

/** Guards: no remote push — local commits/branches only, PR creation stays structural. */
export function assertNoPush(argv: string[]): void {
  if (isGitPushArgs(argv) || PUSH_PATTERN.test(argv.join(' '))) {
    throw new Error(`No-push guard: refusing remote write "${argv.join(' ')}"`);
  }
}

/** Guards: anti-recursion — a worker must never start another full managed run. */
export function assertDepthAllowed(env: NodeJS.ProcessEnv = process.env, maxDepth = 1): void {
  evaluateDepthGuard(readInstanceDepth(env), maxDepth);
}

// ---------------------------------------------------------------------------
// Outcome classification — explicit states, never conflated.
// ---------------------------------------------------------------------------

export type OutcomeState =
  | 'process-idle'
  | 'response-terminated'
  | 'concluded-no-tests'
  | 'failed'
  | 'verified'
  | 'integrated';

export interface OutcomeSignals {
  /** The worker process/pane is still alive. */
  paneAlive: boolean;
  /** The model finished its response turn (vs. still streaming). */
  modelTerminated: boolean;
  /** Test evidence: true = passed, false = failed, undefined = not run. */
  testsPassed?: boolean;
  /** Code already merged into the integration branch. */
  merged?: boolean;
}

export interface ClassifiedOutcome {
  state: OutcomeState;
}

/**
 * Classify what actually happened, in order of strength:
 * a live process is idle (not done); a terminated turn without test
 * evidence is only concluded; tests passing makes it verified; only a
 * merge makes it integrated.
 */
export function classifyOutcome(signals: OutcomeSignals): ClassifiedOutcome {
  if (signals.merged && signals.testsPassed === true) return { state: 'integrated' };
  if (signals.testsPassed === true) return { state: 'verified' };
  // Explicit failure: failed tests are never "idle", "terminated" or
  // "concluded" — they need a fix, not a re-read of the same output.
  if (signals.testsPassed === false) return { state: 'failed' };
  if (signals.paneAlive && !signals.modelTerminated) return { state: 'process-idle' };
  if (signals.paneAlive) return { state: 'response-terminated' };
  return { state: 'concluded-no-tests' };
}

// ---------------------------------------------------------------------------
// Decision — which jobs run next, within the cap.
// ---------------------------------------------------------------------------

/** Minimal plan view the coordinator decides on (no full PlanSpec import). */
export interface PlanJobView {
  name: string;
  status: string;
  dependsOn?: string[];
  mergeOrder?: number;
  priority?: number;
}

function depsSatisfied(job: PlanJobView, merged: Set<string>): boolean {
  return (job.dependsOn ?? []).every((dep) => merged.has(dep));
}

/**
 * Pick the next jobs to dispatch: queued/waiting_deps with satisfied
 * deps, ordered by mergeOrder then priority, bounded by
 * `maxParallel - runningCount`. Pure and mock-friendly.
 */
export function decideNextJobs(
  jobs: PlanJobView[],
  runningCount: number,
  maxParallel: number,
): PlanJobView[] {
  const cap = clampMaxParallel(maxParallel);
  const budget = Math.max(0, cap - Math.max(0, runningCount));
  if (budget === 0) return [];

  const merged = new Set(jobs.filter((j) => j.status === 'merged').map((j) => j.name));
  const eligible = jobs.filter(
    (j) =>
      (j.status === 'queued' || j.status === 'waiting_deps') && depsSatisfied(j, merged),
  );
  eligible.sort(
    (a, b) =>
      (a.mergeOrder ?? Number.MAX_SAFE_INTEGER) - (b.mergeOrder ?? Number.MAX_SAFE_INTEGER) ||
      (b.priority ?? 0) - (a.priority ?? 0),
  );

  const picked = eligible.slice(0, budget);
  evaluateFanoutGuard(picked.length, budget);
  return picked;
}

// ---------------------------------------------------------------------------
// Worker prompts — necessary context only, never indiscriminate history.
// ---------------------------------------------------------------------------

export interface WorkerPromptInput {
  request: string;
  constraints: string[];
  decisions: string[];
  baseRef: string;
  acceptance: string[];
  extraNotes?: string;
}

/** Redact credential-looking material so it never reaches logs or prompts. */
export function redactSecrets(text: string): string {
  return text
    // Use the match offset (not indexOf, which finds the FIRST occurrence
    // and misjudges context when the same token appears twice).
    .replace(/[A-Za-z0-9-_]{16,}/g, (token, offset, full) =>
      /secret|token|bearer|password|key/i.test(full.slice(Math.max(0, offset - 40), offset))
        ? '[REDACTED]'
        : token,
    )
    .replace(/(authorization\s*:\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(password\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

/**
 * Assemble the worker prompt: request, constraints, prior decisions,
 * git base, acceptance criteria, plus the standing guards (local-only,
 * report discipline). No conversation history is attached — corrections
 * continue the same session, distinct tasks start a new one.
 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const lines = [
    `# Task`,
    redactSecrets(input.request),
    ``,
    `## Constraints`,
    ...input.constraints.map((c) => `- ${redactSecrets(c)}`),
    ``,
    `## Prior decisions (do not relitigate)`,
    ...(input.decisions.length > 0 ? input.decisions.map((d) => `- ${redactSecrets(d)}`) : ['- (none)']),
    ``,
    `## Git base`,
    `Branch from \`${redactSecrets(input.baseRef)}\`. Local commits and branches only — never push, publish, or touch the global config.`,
    ``,
    `## Acceptance criteria`,
    ...input.acceptance.map((a) => `- [ ] ${redactSecrets(a)}`),
    ``,
    `## Reporting (mandatory)`,
    `Report progress at each milestone and signal completion explicitly; a quiet finish reads as "still running".`,
  ];
  if (input.extraNotes) lines.push(``, `## Notes`, redactSecrets(input.extraNotes));
  return lines.join('\n');
}

/**
 * Session reuse rule: corrections on the same work continue the session
 * (keeps context); a distinct task always starts a new session.
 */
export function shouldContinueSession(sameWork: boolean): boolean {
  return sameWork;
}

// ---------------------------------------------------------------------------
// Loop — observe → decide → dispatch → gate → enqueue.
// ---------------------------------------------------------------------------

export interface ObservedSnapshot {
  jobs: PlanJobView[];
  runningCount: number;
  model: V2ModelRef;
  baseRef: string;
}

export interface DispatchRequest {
  job: PlanJobView;
  model: V2ModelRef;
  prompt: string;
  /** True when this dispatch corrects the same work (reuse session). */
  continueSession: boolean;
}

export interface CoordinatorDeps {
  observe: () => Promise<ObservedSnapshot>;
  dispatch: (req: DispatchRequest) => Promise<{ sessionID: string }>;
  /** Reviewer gate: true = verified, may proceed to integration. */
  gate: (jobName: string) => Promise<boolean>;
  enqueue: (jobName: string) => Promise<void>;
  maxParallel: number;
  promptFor: (job: PlanJobView, baseRef: string) => WorkerPromptInput;
}

/**
 * One coordination pass. The same pinned model triple flows untouched
 * from observation to dispatch (no silent fallback — a model that
 * cannot be served must surface via InstanceManager's pause/question,
 * never a quiet swap). Jobs that fail the reviewer gate stay out of
 * the integration queue.
 */
export async function coordinateOnce(deps: CoordinatorDeps): Promise<string[]> {
  assertDepthAllowed();
  const snapshot = await deps.observe();
  const model: V2ModelRef = { ...snapshot.model };
  const picked = decideNextJobs(snapshot.jobs, snapshot.runningCount, deps.maxParallel);
  const dispatched: string[] = [];

  for (const job of picked) {
    const prompt = buildWorkerPrompt(deps.promptFor(job, snapshot.baseRef));
    const { sessionID } = await deps.dispatch({
      job,
      model,
      prompt,
      continueSession: shouldContinueSession(false),
    });
    if (!sessionID) continue;
    dispatched.push(job.name);
    if (await deps.gate(job.name)) {
      await deps.enqueue(job.name);
    }
  }

  return dispatched;
}
