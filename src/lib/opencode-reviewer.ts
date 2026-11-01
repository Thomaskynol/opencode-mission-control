/**
 * External functional reviewer via a REAL OpenCode run in a separate context.
 *
 * The integrator (orchestrator) calls {@link reviewFunctionallyViaOpenCode}
 * with the candidate's implementation + tests and attaches the outcome as
 * `ReviewInput.sufficiency` (`reviewer: 'opencode'`). A pass requires BOTH
 * the external pass AND the local hardened check in reviewer.ts.
 *
 * Fail-closed: when the reviewer binary is missing, times out, exits
 * non-zero, or returns no parseable per-criterion verdict, every criterion
 * reports `fail`. Local heuristics NEVER synthesize a pass here.
 */

import type { SufficiencyDecision } from './reviewer';

export interface FunctionalCriterionInput {
  id: string;
  description: string;
  anchors: string[];
}

export interface ReviewModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Model pin accepted by the reviewer: verbatim string or provider/id/variant triple. */
export type ReviewModelInput = string | ReviewModelRef;

export interface FunctionalReviewArgs {
  requirements: FunctionalCriterionInput[];
  implFiles?: Record<string, string>;
  /** Unified diff text (alternative/complement to implFiles). */
  implDiff?: string;
  tests?: Record<string, string>;
  /** Product-observed test output. */
  outputs?: string;
  model?: ReviewModelInput;
  timeoutMs?: number;
  /** Binary under test; defaults to $MC_OPENCODE_BIN, $OPENCODE_BIN, `opencode`. */
  bin?: string;
}

/**
 * Render a model triple for `opencode run --model` (variant preserved as
 * `#variant`). Same shape as auto-plan's formatModelRefForArgv — kept local
 * so this module stays dependency-free.
 */
export function formatReviewModelRef(ref: ReviewModelRef): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`;
}

/** Normalize a model input to its argv string; empty/invalid → undefined. */
function normalizeReviewModelInput(input?: ReviewModelInput): string | undefined {
  if (typeof input === 'string') {
    const t = input.trim();
    return t ? t : undefined;
  }
  if (input !== null && typeof input === 'object') {
    const r = input as ReviewModelRef;
    if (typeof r.providerID !== 'string' || typeof r.id !== 'string') return undefined;
    if (!r.providerID.trim() || !r.id.trim()) return undefined;
    const variant = typeof r.variant === 'string' && r.variant.trim() ? r.variant.trim() : undefined;
    return formatReviewModelRef({ providerID: r.providerID.trim(), id: r.id.trim(), ...(variant ? { variant } : {}) });
  }
  return undefined;
}

/**
 * Resolve the review model pin. Precedence: args.model → MC_REVIEW_MODEL →
 * effectiveModel (inherited) → unpinned (undefined, caller fails closed).
 * Never falls back to a silent default: undefined means the caller must
 * report `review model unpinned` without invoking the binary.
 *
 * Integrator note: the public review path never sets args.model, so the
 * orchestrator's attachExternalSufficiency must pass the effective triple as
 * `effectiveModel` — `formatModelRefForArgv(ensureEffectiveModel())` — making
 * MC_REVIEW_MODEL an optional override, not a second required config.
 */
export function resolveReviewModel(
  args: { model?: ReviewModelInput },
  effectiveModel?: ReviewModelInput,
): string | undefined {
  const fromArgs = normalizeReviewModelInput(args?.model);
  if (fromArgs) return fromArgs;
  const fromEnv = process.env.MC_REVIEW_MODEL?.trim() || undefined;
  if (fromEnv) return fromEnv;
  return normalizeReviewModelInput(effectiveModel);
}

export interface FunctionalCriterionResult {
  id: string;
  demonstrated: boolean;
  missing: string[];
  verdict: 'pass' | 'fail';
  reason: string;
}

function failClosed(
  requirements: FunctionalCriterionInput[],
  reason: string,
): FunctionalCriterionResult[] {
  return requirements.map((r) => ({
    id: r.id,
    demonstrated: false,
    missing: ['external evidence'],
    verdict: 'fail' as const,
    reason: `${reason} — fail-closed (criterion "${r.id}": ${r.description.slice(0, 160)})`,
  }));
}

function failClosedEmpty(reason: string): FunctionalCriterionResult[] {
  return [
    {
      id: '(none)',
      demonstrated: false,
      missing: ['external evidence'],
      verdict: 'fail' as const,
      reason: `${reason} — fail-closed`,
    },
  ];
}

/** True when an OpenCode binary answers `--version` within a short budget. */
export async function isOpenCodeReviewerAvailable(bin?: string): Promise<boolean> {
  const cmd = bin ?? process.env.MC_OPENCODE_BIN ?? process.env.OPENCODE_BIN ?? 'opencode';
  try {
    const proc = Bun.spawn([cmd, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 10_000);
    const [exitCode] = await Promise.all([proc.exited]);
    clearTimeout(timer);
    return exitCode === 0;
  } catch {
    return false;
  }
}

function buildPrompt(args: FunctionalReviewArgs): string {
  const lines: string[] = [
    'You are a strict functional code reviewer. Decide ONLY from the evidence below.',
    'For EACH requirement, answer whether the TESTS demonstrate the IMPLEMENTATION',
    'satisfies it: the tests must call the implemented function with a',
    'distinguishing (non-trivial, non-empty) input and assert the required result.',
    'An empty-input-only test NEVER demonstrates a general requirement.',
    'Reply with STRICT JSON only: an array of',
    '{"id": "<requirement id>", "demonstrated": true|false, "missing": ["..."], "verdict": "pass"|"fail", "reason": "..."}.',
    'No prose outside the JSON array. When in doubt, verdict "fail".',
    '',
    '## Requirements',
  ];
  for (const r of args.requirements) {
    lines.push(`- [${r.id}] ${r.description} (anchors: ${r.anchors.join(' | ') || '(none)'})`);
  }
  if (args.implDiff) lines.push('', '## Implementation diff', '```diff', args.implDiff.slice(0, 20_000), '```');
  if (args.implFiles) {
    for (const [path, content] of Object.entries(args.implFiles)) {
      lines.push('', `## Implementation file: ${path}`, '```', content.slice(0, 20_000), '```');
    }
  }
  if (args.tests) {
    for (const [path, content] of Object.entries(args.tests)) {
      lines.push('', `## Test file: ${path}`, '```', content.slice(0, 20_000), '```');
    }
  }
  if (args.outputs) lines.push('', '## Observed test output', '```', args.outputs.slice(0, 8_000), '```');
  return lines.join('\n');
}

/** Best-effort extraction of a per-criterion JSON array from model output. */
function extractResults(raw: string, requirements: FunctionalCriterionInput[]): FunctionalCriterionResult[] | null {
  const texts: string[] = [];
  const trimmed = raw.trim();
  texts.push(trimmed);
  // Unwrap `opencode run --format json` JSONL envelope lines first: the
  // verdict JSON travels escaped inside text/content carriers, so the raw
  // blob never parses (mirrors extractPlannerText's line handling in
  // auto-plan.ts — kept local so this module stays dependency-free and the
  // predicate stays verdict-specific instead of planner-draft-specific).
  texts.push(...unwrapEnvelopeCandidates(trimmed));
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]!.trim());
  texts.push(...fenced);
  for (const t of texts) {
    // Whole blob first, then largest [...] substring.
    const candidates = [t];
    const brackets = [...t.matchAll(/\[[\s\S]*\]/g)].map((m) => m[0]).sort((a, b) => b.length - a.length);
    candidates.push(...brackets.slice(0, 3));
    for (const c of candidates) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(c);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const byId = new Map(requirements.map((r) => [r.id, r]));
      const out: FunctionalCriterionResult[] = [];
      let ok = true;
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) {
          ok = false;
          break;
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.id !== 'string' || !byId.has(rec.id)) continue;
        if (rec.verdict !== 'pass' && rec.verdict !== 'fail') {
          ok = false;
          break;
        }
        out.push({
          id: rec.id,
          demonstrated: rec.demonstrated === true && rec.verdict === 'pass',
          missing: Array.isArray(rec.missing) ? rec.missing.map(String).slice(0, 8) : [],
          verdict: rec.verdict,
          reason:
            typeof rec.reason === 'string' && rec.reason.trim() ? rec.reason.trim().slice(0, 500) : 'no reason recorded',
        });
      }
      if (!ok || out.length === 0) continue;
      return requirements.map(
        (r) =>
          out.find((o) => o.id === r.id) ?? {
            id: r.id,
            demonstrated: false,
            missing: ['external evidence'],
            verdict: 'fail' as const,
            reason: `reviewer returned no verdict for "${r.id}" — fail-closed`,
          },
      );
    }
  }
  return null;
}

/**
 * Collect candidate payload strings from one envelope event, following only
 * targeted text carriers (text/content/delta, part(s)/message(s)/data) so
 * ids/markers never pollute reassembly. JSON.parse of the event line already
 * unescaped the payload.
 */
function collectEnvelopeStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvelopeStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'delta']) {
      const v = o[key];
      if (typeof v === 'string') {
        if (v.trim()) out.push(v);
      } else if (Array.isArray(v)) {
        collectEnvelopeStrings(v, out);
      } else if (v !== null && typeof v === 'object') {
        collectEnvelopeStrings(v, out);
      }
    }
    for (const key of ['part', 'parts', 'message', 'messages', 'data']) {
      const v = o[key];
      if (typeof v === 'string') {
        if (v.trim()) out.push(v);
      } else if (v !== null && typeof v === 'object') {
        collectEnvelopeStrings(v, out);
      }
    }
  }
}

/**
 * Per-line payloads from a JSONL envelope, plus their concatenation for a
 * verdict split across text events. Non-JSON lines are ignored (the blob
 * fallback below already covers verbatim/fenced answers).
 */
function unwrapEnvelopeCandidates(raw: string): string[] {
  const perLine: string[] = [];
  const payloads: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof evt === 'string') {
      if (evt.trim()) {
        perLine.push(evt);
        payloads.push(evt);
      }
      continue;
    }
    if (evt !== null && typeof evt === 'object') {
      const found: string[] = [];
      collectEnvelopeStrings(evt, found);
      perLine.push(...found);
      payloads.push(...found);
    }
  }
  const joined = payloads.join('').trim();
  if (joined) perLine.push(joined);
  return perLine;
}

/**
 * Ask a real OpenCode (`run --standalone --format json`, separate context)
 * for per-criterion functional verdicts. Never throws: every failure mode
 * (missing binary, timeout, non-zero exit, unparseable output) resolves to
 * all-`fail` (fail-closed).
 *
 * Model pin (always `--model`, variant preserved as `#variant`): resolved via
 * {@link resolveReviewModel} — args.model → MC_REVIEW_MODEL → effectiveModel
 * (inherited triple from the integrator) → unpinned fail-closed without
 * invoking the binary. The orchestrator's attachExternalSufficiency should
 * pass `formatModelRefForArgv(ensureEffectiveModel())` as `effectiveModel`
 * so MC_REVIEW_MODEL stays an optional override.
 */
export async function reviewFunctionallyViaOpenCode(
  args: FunctionalReviewArgs,
  effectiveModel?: ReviewModelInput,
): Promise<FunctionalCriterionResult[]> {
  const { requirements } = args;
  if (requirements.length === 0) return [];
  const model = resolveReviewModel(args, effectiveModel);
  if (!model) return failClosed(requirements, 'review model unpinned (MC_REVIEW_MODEL not set)');
  const bin = args.bin ?? process.env.MC_OPENCODE_BIN ?? process.env.OPENCODE_BIN ?? 'opencode';
  const timeoutMs = args.timeoutMs ?? 300_000;
  const prompt = buildPrompt(args);
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      const argv = [bin, 'run', '--standalone', '--model', model, '--format', 'json', prompt];
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch {}
        reject(new Error(`OpenCode reviewer timed out after ${timeoutMs}ms.`));
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
            reject(new Error(`OpenCode reviewer failed (exit ${exitCode}): ${(stderr || stdout).slice(0, 500)}`));
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return failClosed(requirements, `OpenCode reviewer unavailable (${msg.slice(0, 200)})`);
  }
  const results = extractResults(raw, requirements);
  if (!results) return failClosed(requirements, 'OpenCode reviewer returned no parseable per-criterion verdict');
  return results;
}

/**
 * Fold per-criterion external results into the `sufficiency` decision the
 * local gate (`reviewJob`) enforces: pass only when EVERY criterion passes.
 */
export function toSufficiencyDecision(results: FunctionalCriterionResult[]): SufficiencyDecision {
  if (results.length === 0) {
    return { reviewer: 'opencode', decision: 'fail', reasons: ['no criteria reviewed — fail-closed'] };
  }
  const failures = results.filter((r) => r.verdict !== 'pass');
  if (failures.length === 0) return { reviewer: 'opencode', decision: 'pass', reasons: [] };
  return {
    reviewer: 'opencode',
    decision: 'fail',
    reasons: failures.map((f) => `${f.id}: ${f.reason}`),
  };
}
