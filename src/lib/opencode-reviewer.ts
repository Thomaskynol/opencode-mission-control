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

export interface FunctionalReviewArgs {
  requirements: FunctionalCriterionInput[];
  implFiles?: Record<string, string>;
  /** Unified diff text (alternative/complement to implFiles). */
  implDiff?: string;
  tests?: Record<string, string>;
  /** Product-observed test output. */
  outputs?: string;
  model?: string;
  timeoutMs?: number;
  /** Binary under test; defaults to $MC_OPENCODE_BIN, $OPENCODE_BIN, `opencode`. */
  bin?: string;
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
 * Ask a real OpenCode (`run --standalone --format json`, separate context)
 * for per-criterion functional verdicts. Never throws: every failure mode
 * (missing binary, timeout, non-zero exit, unparseable output) resolves to
 * all-`fail` (fail-closed).
 */
export async function reviewFunctionallyViaOpenCode(
  args: FunctionalReviewArgs,
): Promise<FunctionalCriterionResult[]> {
  const { requirements } = args;
  if (requirements.length === 0) return [];
  const model = args.model?.trim() || process.env.MC_REVIEW_MODEL?.trim() || undefined;
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
