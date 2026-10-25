/**
 * Autonomous intake: NL-only public entry → model transform → validated plan.
 *
 * The user supplies natural language (+ optional docs), the repo, the
 * destination branch and ceilings. The configured MODEL (injected as
 * `generate`) turns that into verifiable requirements, tasks, prompts,
 * dependencies and acceptance criteria. Nothing here dispatches work:
 * every model decision is validated (known task, existing deps, no cycle,
 * allowed destination, authorized action, consistent result) and invalid
 * output fails explicitly before anything runs.
 */

import { randomUUID } from 'crypto';
import type { JobSpec } from './plan-types';
import { isGitPushText } from './permission-policy';
import { gitCommand } from './git';
import { getCurrentModel } from './model-tracker';

export interface AutoCeiling {
  maxParallel?: number;
  testCommand?: string;
}

export interface AutoIntakeInput {
  request: string;
  repo?: string;
  targetBranch?: string;
  docs?: string[];
  ceiling?: AutoCeiling;
}

export interface AutoIntake extends AutoIntakeInput {
  id: string;
  createdAt: string;
}

export interface AutoRequirement {
  id: string;
  text: string;
  acceptance: string[];
}

export interface AutoTaskDraft {
  name: string;
  prompt: string;
  dependsOn?: string[];
  touchSet?: string[];
  acceptance: string[];
}

export interface AutoPlanDraft {
  requirements: AutoRequirement[];
  tasks: AutoTaskDraft[];
  decisions: string[];
  questions: string[];
  nextSteps: string[];
}

/** The configured model slot: prompt in, strict-JSON plan out. */
export type PlannerGenerate = (plannerPrompt: string) => Promise<string>;

const TASK_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'string')) return null;
  return value as string[];
}

/** NL entry guard: the only free-form input the public path accepts. */
export function normalizeRequest(raw: string): string {
  const request = raw.trim();
  if (!request) {
    throw new Error('Auto intake requires natural-language request text (got empty).');
  }
  return request;
}

/**
 * Planner prompt for the configured model. The model returns STRICT JSON
 * only (schema below) — the caller never prepares a DAG by hand.
 */
export function buildPlannerPrompt(intake: AutoIntakeInput): string {
  const docs =
    intake.docs && intake.docs.length > 0
      ? intake.docs.map((d, i) => `--- doc ${i + 1} ---\n${d}`).join('\n')
      : '(none)';
  return [
    'You are the planner for an autonomous coding run. Return STRICT JSON only, no prose.',
    'Shape: {"requirements":[{"id","text","acceptance":[strings]}],',
    ' "tasks":[{"name":"slug","prompt":"worker prompt","dependsOn":["task names"],"touchSet":["relative/paths"],"acceptance":[strings]}],',
    ' "decisions":[strings],"questions":[strings for the user],"nextSteps":[strings]}.',
    'Rules: names are unique slugs; dependsOn names existing tasks; no cycles;',
    ' task prompts are concrete and self-contained; every task lists acceptance criteria;',
    ' touchSet holds repo-relative paths only, never absolute or ../ escapes;',
    ' never push, publish, deploy, approve permissions, or touch the global config;',
    ' user-visible scope changes go to "questions", routine technique stays autonomous.',
    `Request: ${intake.request}`,
    `Repo: ${intake.repo ?? '(current worktree)'}`,
    `Destination branch: ${intake.targetBranch ?? '(keep current)'}`,
    `Ceilings: maxParallel=${intake.ceiling?.maxParallel ?? 'default'} testCommand=${intake.ceiling?.testCommand ?? 'none'}`,
    `Optional docs:\n${docs}`,
  ].join('\n');
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function checkNoCycle(tasks: AutoTaskDraft[]): string | null {
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    for (const dep of byName.get(name)?.dependsOn ?? []) {
      if (byName.has(dep) && visit(dep)) return true;
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  for (const t of tasks) {
    if (visit(t.name)) return t.name;
  }
  return null;
}

/**
 * Parse + validate model output. Structural, dependency and consistency
 * errors throw explicitly — an invalid draft never becomes work.
 */
export function parsePlannerOutput(raw: string): AutoPlanDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    throw new Error('Planner model output is not valid JSON — refusing to create tasks.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Planner model output must be a JSON object — refusing to create tasks.');
  }

  const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : null;
  if (!requirements || requirements.length === 0) {
    throw new Error('Planner model output lists no requirements — refusing to create tasks.');
  }
  const reqIds = new Set<string>();
  for (const r of requirements) {
    if (!isRecord(r) || !nonEmptyString(r.id) || !nonEmptyString(r.text)) {
      throw new Error('Planner requirement needs a non-empty id and text.');
    }
    if (reqIds.has(r.id)) throw new Error(`Duplicate requirement id "${r.id}".`);
    reqIds.add(r.id);
    const acceptance = stringArray(r.acceptance);
    if (!acceptance || acceptance.length === 0 || !acceptance.every(nonEmptyString)) {
      throw new Error(`Requirement "${r.id}" needs non-empty acceptance criteria.`);
    }
  }

  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : null;
  if (!tasks || tasks.length === 0) {
    throw new Error('Planner model output lists no tasks — refusing to create tasks.');
  }
  const names = new Set<string>();
  const drafts: AutoTaskDraft[] = tasks.map((t, i) => {
    if (!isRecord(t) || !nonEmptyString(t.name)) {
      throw new Error(`Planner task #${i} needs a non-empty slug name.`);
    }
    const name = t.name.trim();
    if (!TASK_NAME.test(name)) {
      throw new Error(`Planner task name "${t.name}" must be a slug (lowercase, digits, -/_).`);
    }
    if (names.has(name)) throw new Error(`Duplicate planner task name "${name}" (names must be unique).`);
    names.add(name);
    if (!nonEmptyString(t.prompt)) {
      throw new Error(`Planner task "${name}" needs a non-empty worker prompt.`);
    }
    const acceptance = stringArray(t.acceptance);
    if (!acceptance || acceptance.length === 0 || !acceptance.every(nonEmptyString)) {
      throw new Error(`Planner task "${name}" needs non-empty acceptance criteria.`);
    }
    const dependsOn = t.dependsOn === undefined ? [] : stringArray(t.dependsOn);
    if (dependsOn === null) throw new Error(`Planner task "${name}" has a malformed dependsOn.`);
    const touchSet = t.touchSet === undefined ? undefined : stringArray(t.touchSet);
    if (touchSet === null) throw new Error(`Planner task "${name}" has a malformed touchSet.`);
    return { name, prompt: (t.prompt as string).trim(), dependsOn, touchSet, acceptance };
  });

  for (const t of drafts) {
    for (const dep of t.dependsOn ?? []) {
      if (!names.has(dep)) {
        throw new Error(`Job "${t.name}" depends on unknown job "${dep}".`);
      }
      if (dep === t.name) {
        throw new Error(`Job "${t.name}" depends on itself (circular dependency).`);
      }
    }
  }
  const cyclic = checkNoCycle(drafts);
  if (cyclic) {
    throw new Error(`Plan contains circular dependencies (via "${cyclic}").`);
  }

  const strList = (v: unknown, field: string): string[] => {
    if (v === undefined) return [];
    const list = stringArray(v);
    if (list === null) throw new Error(`Planner field "${field}" must be an array of strings.`);
    return list;
  };

  return {
    requirements: requirements as AutoRequirement[],
    tasks: drafts,
    decisions: strList(parsed.decisions, 'decisions'),
    questions: strList(parsed.questions, 'questions'),
    nextSteps: strList(parsed.nextSteps, 'nextSteps'),
  };
}

function describeTouchSet(touchSet: string[] | undefined): string[] {
  return touchSet ?? [];
}

/** Destination allowlist: repo-relative paths only, no absolutes or escapes. */
export function assertSafeDestinations(draft: AutoPlanDraft): void {
  for (const t of draft.tasks) {
    for (const entry of describeTouchSet(t.touchSet)) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith('/') || trimmed.split('/').includes('..')) {
        throw new Error(
          `Disallowed destination "${entry}" in task "${t.name}": touchSet must be repo-relative without .. escapes.`,
        );
      }
    }
  }
}

const PUBLISH_HINT = /\bgh\s+pr\s+(create|merge)\b|\b(npm|pnpm|yarn)\b[^\n]*\bpublish\b|\bdeploy\b/i;

/** Action authorization: model prompts must not publish or push. */
export function assertAuthorizedActions(draft: AutoPlanDraft): void {
  for (const t of draft.tasks) {
    if (isGitPushText(t.prompt) || PUBLISH_HINT.test(t.prompt)) {
      throw new Error(
        `Unauthorized action in task "${t.name}": prompts must never push, publish, or deploy.`,
      );
    }
  }
}

export type RuntimeAction = 'add_task' | 'adjust_deps' | 'ask_user' | 'record_note';

export interface RuntimeDecision {
  action: RuntimeAction;
  task?: AutoTaskDraft;
  dependsOn?: Record<string, string[]>;
  reason: string;
}

export interface RuntimeContext {
  taskNames: string[];
  mergedTasks: string[];
}

/**
 * Validate one adaptive-loop model decision. Pure: never dispatches.
 * Returns 'autonomous' (routine technique, record + run) or 'needs-user'
 * (user-visible scope change → ask as a question). Anything invalid
 * throws explicitly so no incorrect work is fired.
 */
export function validateRuntimeDecision(
  decision: RuntimeDecision,
  ctx: RuntimeContext,
): 'autonomous' | 'needs-user' {
  if (!nonEmptyString(decision.reason)) {
    throw new Error('Model decision needs a non-empty reason — refusing to apply it.');
  }
  const known = new Set(ctx.taskNames);

  if (decision.action === 'ask_user') return 'needs-user';
  if (decision.action === 'record_note') {
    return requiresUserReview(decision.reason) ? 'needs-user' : 'autonomous';
  }

  if (decision.action === 'add_task') {
    const t = decision.task;
    if (!t || !nonEmptyString(t.name) || !TASK_NAME.test(t.name.trim())) {
      throw new Error('Model decision add_task needs a valid slug task name.');
    }
    const name = t.name.trim();
    if (known.has(name)) throw new Error(`Model decision reuses known task "${name}".`);
    if (!nonEmptyString(t.prompt)) {
      throw new Error(`Model decision task "${name}" needs a non-empty worker prompt.`);
    }
    const acceptance = Array.isArray(t.acceptance) ? t.acceptance : [];
    if (acceptance.length === 0 || !acceptance.every(nonEmptyString)) {
      throw new Error(`Model decision task "${name}" needs non-empty acceptance criteria.`);
    }
    for (const dep of t.dependsOn ?? []) {
      if (!known.has(dep)) {
        throw new Error(`Model decision task "${name}" depends on unknown job "${dep}".`);
      }
      if (dep === name) {
        throw new Error(`Model decision task "${name}" depends on itself (circular dependency).`);
      }
    }
    assertSafeDestinations({
      requirements: [],
      tasks: [{ ...t, name }],
      decisions: [],
      questions: [],
      nextSteps: [],
    });
    assertAuthorizedActions({
      requirements: [],
      tasks: [{ ...t, name }],
      decisions: [],
      questions: [],
      nextSteps: [],
    });
    return requiresUserReview(`${decision.reason} ${t.prompt}`) ? 'needs-user' : 'autonomous';
  }

  if (decision.action === 'adjust_deps') {
    const edges = decision.dependsOn;
    if (!isRecord(edges)) throw new Error('Model decision adjust_deps needs a dependsOn map.');
    for (const [name, deps] of Object.entries(edges)) {
      if (!known.has(name)) throw new Error(`Model decision adjusts unknown task "${name}".`);
      if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string')) {
        throw new Error(`Model decision adjust_deps for "${name}" must list task names.`);
      }
      if (!(deps as string[]).every((d) => known.has(d))) {
        throw new Error(`Model decision adjust_deps for "${name}" references an unknown job.`);
      }
    }
    // Cycle check on the merged graph (existing edges are acyclic by construction).
    const graph: AutoTaskDraft[] = ctx.taskNames.map((name) => ({
      name,
      prompt: 'x',
      acceptance: ['x'],
      dependsOn: name in edges ? (edges[name] as string[]) : [],
    }));
    if (checkNoCycle(graph)) {
      throw new Error('Model decision adjust_deps would create a circular dependency.');
    }
    return requiresUserReview(decision.reason) ? 'needs-user' : 'autonomous';
  }

  throw new Error(`Unknown runtime action "${(decision as { action: string }).action}".`);
}

/**
 * Routine technique runs autonomously and is recorded; anything the user
 * would notice (scope, branch, publish, permission) becomes a question.
 * shortcut: keyword heuristic, upgrade to a policy table when it misfires.
 */
export function requiresUserReview(change: string): boolean {
  const lower = change.toLowerCase();
  return (
    /\bpush\b|\bpublish\b|\bdeploy\b|\bpermission\b|\bsecret\b|\bproduction\b/.test(lower) ||
    /target branch|base branch|destination branch/.test(lower) ||
    /\bgh\s+pr\b/.test(lower) ||
    /\bapprove\b|\bprefer\b|\bwhich\b|\bchoose\b/.test(lower)
  );
}

/** Follow-up steps derived from the validated draft (no invented work). */
export function nextStepsFor(draft: AutoPlanDraft): string[] {
  const steps = [...draft.nextSteps];
  for (const q of draft.questions) {
    steps.push(`Answer open question: "${q}"`);
  }
  if (draft.tasks.length > 0) {
    steps.push(`Dispatch order: ${draft.tasks.map((t) => t.name).join(' → ')}`);
  }
  return steps;
}

/** PlanSpec-ready job shells (ids/status assigned at launch). */
export function draftToJobSpecs(draft: AutoPlanDraft): Array<Omit<JobSpec, 'id' | 'status'>> {
  return draft.tasks.map((t, i) => ({
    name: t.name,
    prompt: t.prompt,
    dependsOn: t.dependsOn?.length ? [...t.dependsOn] : undefined,
    touchSet: t.touchSet?.length ? [...t.touchSet] : undefined,
    mergeOrder: i,
  }));
}

/**
 * Fresh-repo / missing-branch handling. Creates a missing destination
 * branch locally from HEAD (never pushes); a repo without commits cannot
 * yield a base, so it fails with the minimal preparation instead of
 * depending on leftover test state.
 */
export async function ensureBaseReady(
  repo: string,
  targetBranch?: string,
): Promise<{ baseCommit: string; baseBranch: string; createdBranch: boolean }> {
  const fs = await import('fs');
  let stat: import('fs').Stats | null = null;
  try {
    stat = fs.statSync(repo);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw new Error(
      `Repo not found: "${repo}". Minimal preparation: git init, one commit, then retry.`,
    );
  }
  if (targetBranch !== undefined) {
    const name = targetBranch.trim();
    if (!name || /\s|\.\.|[~^:?*[\]\\]/.test(name)) {
      throw new Error(`Invalid destination branch "${targetBranch}".`);
    }
  }

  const head = await gitCommand(['rev-parse', 'HEAD'], { cwd: repo });
  if (head.exitCode !== 0) {
    throw new Error(
      `Repo at "${repo}" has no commits — minimal preparation: git commit --allow-empty -m "chore: initial"` +
        (targetBranch ? ` && git branch ${targetBranch}` : '') +
        ', then retry. (No base can be derived without a commit.)',
    );
  }
  const baseCommit = head.stdout.trim();

  if (!targetBranch) {
    const current = await gitCommand(['branch', '--show-current'], { cwd: repo });
    const baseBranch = current.stdout.trim();
    if (current.exitCode !== 0 || !baseBranch) {
      throw new Error(
        `Repo at "${repo}" has no current branch — minimal preparation: git branch -m main, then retry.`,
      );
    }
    return { baseCommit, baseBranch, createdBranch: false };
  }

  const exists = await gitCommand(['rev-parse', '--verify', targetBranch], { cwd: repo });
  if (exists.exitCode === 0) {
    return { baseCommit, baseBranch: targetBranch, createdBranch: false };
  }
  const created = await gitCommand(['branch', targetBranch, baseCommit], { cwd: repo });
  if (created.exitCode !== 0) {
    throw new Error(
      `Cannot create destination branch "${targetBranch}": ${created.stderr || created.stdout}`,
    );
  }
  return { baseCommit, baseBranch: targetBranch, createdBranch: true };
}

/**
 * Full NL→validated-draft pass through the configured model.
 * Throws explicitly on any invalid model output — no partial state escapes.
 */
export async function runAutoIntake(
  input: AutoIntakeInput,
  generate: PlannerGenerate,
): Promise<{ intake: AutoIntake; draft: AutoPlanDraft; plannerPrompt: string }> {
  const request = normalizeRequest(input.request);
  const plannerPrompt = buildPlannerPrompt({ ...input, request });
  const raw = await generate(plannerPrompt);
  const draft = parsePlannerOutput(raw);
  assertSafeDestinations(draft);
  assertAuthorizedActions(draft);
  return {
    intake: {
      id: randomUUID(),
      request,
      repo: input.repo,
      targetBranch: input.targetBranch,
      docs: input.docs,
      ceiling: input.ceiling,
      createdAt: new Date().toISOString(),
    },
    draft,
    plannerPrompt,
  };
}

// ---------------------------------------------------------------------------
// Autonomous single-run: retry + private model invocation.
// The public `start --request` path never trusts one model answer: invalid
// output retries with backoff, valid output is the only thing that proceeds.
// No side effects happen here — persistence/dispatch live in the caller, so
// a failed attempt never creates tasks, branches or workers.
// ---------------------------------------------------------------------------

/** Default planner model (normal opencode auth, never a key prompt). */
export const PLANNER_MODEL_DEFAULT = 'opencode-go/muse-spark-1.3-contributor';

/** Resolve the planner model: explicit env → tracked session model → default. */
export function resolvePlannerModel(): string {
  const env = process.env.MC_PLANNER_MODEL?.trim();
  if (env) return env;
  return getCurrentModel() ?? PLANNER_MODEL_DEFAULT;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PlannerRetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms, doubled per retry (default 1000). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * NL→validated-draft with retry. Each attempt fully validates (JSON/fenced,
 * unique names, known deps, no cycle, prompt/acceptance, safe destinations,
 * authorized actions); failures sleep with exponential backoff and retry.
 * Throws the last error after exhausting attempts — never partial work.
 */
export async function runAutoIntakeWithRetry(
  input: AutoIntakeInput,
  generate: PlannerGenerate,
  opts?: PlannerRetryOptions,
): Promise<{ intake: AutoIntake; draft: AutoPlanDraft; plannerPrompt: string; attempts: number }> {
  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, opts?.baseDelayMs ?? 1000);
  const sleep = opts?.sleep ?? defaultSleep;
  const request = normalizeRequest(input.request);
  const plannerPrompt = buildPlannerPrompt({ ...input, request });
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await generate(plannerPrompt);
      const draft = parsePlannerOutput(raw);
      assertSafeDestinations(draft);
      assertAuthorizedActions(draft);
      return {
        intake: {
          id: randomUUID(),
          request,
          repo: input.repo,
          targetBranch: input.targetBranch,
          docs: input.docs,
          ceiling: input.ceiling,
          createdAt: new Date().toISOString(),
        },
        draft,
        plannerPrompt,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && baseDelayMs > 0) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Planner model failed after ${maxAttempts} attempt(s).`);
}

function collectTextStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectTextStrings(v, out);
  }
}

function looksLikeDraftText(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Record<string, unknown>).requirements) &&
      Array.isArray((parsed as Record<string, unknown>).tasks)
    );
  } catch {
    return false;
  }
}

/**
 * Extract the planner's strict-JSON answer from `opencode run --format json`.
 * Accepts already-strict JSON verbatim; otherwise unwraps the outer envelope
 * (text/content/parts/message nests) and returns the first inner string that
 * parses as a draft. Throws explicitly when no draft JSON is found.
 */
export function extractPlannerText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Planner model returned empty output — refusing to create tasks.');
  if (looksLikeDraftText(trimmed)) return trimmed;
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenced && looksLikeDraftText(fenced[1].trim())) return fenced[1].trim();
  let outer: unknown = null;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    outer = null;
  }
  if (outer !== null && typeof outer === 'object') {
    const candidates: string[] = [];
    collectTextStrings(outer, candidates);
    for (const c of candidates) {
      const t = c.trim();
      if (looksLikeDraftText(t)) return t;
      const innerFenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (innerFenced && looksLikeDraftText(innerFenced[1].trim())) return innerFenced[1].trim();
    }
    // Last resort: largest {...} substring mentioning "tasks".
    const braces: string[] = [];
    const re = /\{[\s\S]*?"tasks"[\s\S]*?\}/g;
    let m: RegExpExecArray | null;
    const haystack = candidates.join('\n');
    while ((m = re.exec(haystack)) !== null) braces.push(m[0]);
    braces.sort((a, b) => b.length - a.length);
    for (const b of braces) {
      if (looksLikeDraftText(b)) return b;
    }
  }
  throw new Error('Planner model output contains no strict-JSON draft — refusing to create tasks.');
}

export interface RunPlannerOptions {
  model?: string;
  timeoutMs?: number;
  opencodeBin?: string;
  run?: (args: string[], prompt: string) => Promise<string>;
}

/**
 * Build the configured-model slot on top of a real product session.
 * Default runs `opencode run --standalone` (a private server, never the
 * shared background service holding user sessions) with the pinned planner
 * model. Auth flows through the normal opencode mechanisms — no keys asked.
 * shortcut: text extraction is heuristic, upgrade to a typed envelope when
 * `opencode run --format json` stabilizes its schema.
 */
export function createRunPlannerGenerate(opts?: RunPlannerOptions): PlannerGenerate {
  const model = opts?.model ?? resolvePlannerModel();
  const timeoutMs = opts?.timeoutMs ?? 300_000;
  const opencodeBin = opts?.opencodeBin ?? process.env.OPENCODE_BIN ?? 'opencode';
  const run = opts?.run;
  return async (plannerPrompt: string): Promise<string> => {
    let raw: string;
    if (run) {
      raw = await run(['run', '--standalone', '--model', model, '--format', 'json'], plannerPrompt);
    } else {
      raw = await new Promise<string>((resolve, reject) => {
        const proc = Bun.spawn([opencodeBin, 'run', '--standalone', '--model', model, '--format', 'json', plannerPrompt], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            proc.kill();
          } catch {}
          reject(new Error(`Planner model timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        (async () => {
          try {
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ]);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (exitCode !== 0) {
              reject(new Error(`Planner model failed (exit ${exitCode}): ${(stderr || stdout).slice(0, 500)}`));
              return;
            }
            resolve(stdout);
          } catch (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        })();
      });
    }
    return extractPlannerText(raw);
  };
}
