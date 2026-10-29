/**
 * M4 reviewer: fail-closed gate that validates evidence before integration.
 *
 * A job only passes when ALL hold:
 * - non-empty diff (changedFiles)
 * - touchSet respected (no file outside the allowed globs)
 * - test evidence present: command + exit 0 + observable output +
 *   testedCommit === jobHead (the exact code that was tested)
 * - every essential requirement has a test anchor visible in the test
 *   output (green tests that do not cover the requirement fail — a
 *   matching filename in the diff is not coverage)
 * - claimed success without evidence fails (optimistic report, no proof)
 * - test-file changes that weaken coverage require a written record of
 *   why the previous test was incorrect
 *
 * Fail verdicts are blocking. Approvals pin (jobHead, baseHead); any base
 * move invalidates them via needsReReview().
 */

export type ReviewVerdictValue = 'pass' | 'fail';

export interface EssentialRequirement {
  id: string;
  description: string;
  /** Substrings that must appear in the test output. Filenames alone do not count. */
  testAnchors: string[];
}

export interface TestEvidence {
  /** Exact command that was run, e.g. "bun test". Empty = missing. */
  command: string;
  exitCode: number;
  /** Captured stdout/stderr. Empty = not observable/repeatable. */
  output: string;
  /** Commit (or content hash) of the code under test. */
  testedCommit: string;
  /** Where it ran, e.g. "worktree:/tmp/x (bun 1.3.14, linux)". Optional but recorded. */
  environment?: string;
}

export interface TestChangeRecord {
  changedTestFiles: string[];
  /** Required when test files changed: why the previous test was wrong. */
  reasonPreviousIncorrect?: string;
}

export interface ReviewInput {
  jobName: string;
  jobBranch: string;
  baseBranch: string;
  /** Integration/base HEAD the review was taken against. */
  baseHead: string;
  /** Job HEAD that was reviewed. */
  jobHead: string;
  /** Files changed by jobBranch vs baseBranch (diff --name-only). */
  changedFiles: string[];
  touchSet?: string[];
  requirements: EssentialRequirement[];
  /** Null/undefined = delivery without evidence. */
  evidence?: TestEvidence | null;
  /** Worker claim. True without passing evidence = optimistic report. */
  claimedPass?: boolean;
  testChange?: TestChangeRecord | null;
  /** Code paths that were reviewed (optional, for audit). */
  reviewedPaths?: string[];
}

export interface ReviewVerdict {
  verdict: ReviewVerdictValue;
  /** True when verdict === 'fail': integration must not proceed. */
  blocking: boolean;
  reasons: string[];
  jobName: string;
  reviewedCommit: string;
  reviewedBase: string;
}

function matchesTouchSet(file: string, touchSet: string[]): boolean {
  return touchSet.some((pattern) => {
    const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
    return new Bun.Glob(normalized).match(file);
  });
}

/**
 * An anchor counts as covered only when it appears in OBSERVED test output
 * from a product-executed test command — never in caller-declared text.
 * A matching filename in the diff is NOT coverage, and a bare echo of the
 * anchor is NOT execution: real runner output carries context (pass/fail,
 * test counts) around the requirement string. Trivial echoes fail here;
 * the authoritative guarantee comes from the orchestrator re-running the
 * test command itself and feeding THAT output in (never a worker claim).
 */
function anchorCovered(anchor: string, output: string): boolean {
  if (!anchor || anchor.trim().length < 3) return false;
  if (!output || !output.includes(anchor)) return false;
  const trimmedOutput = output.trim();
  const trimmedAnchor = anchor.trim();
  // Exact echo of the anchor proves nothing was executed.
  if (trimmedOutput.length <= trimmedAnchor.length) return false;
  // shortcut: heuristic on runner tokens — upgrade to a structured parser if it misfires.
  if (!/pass|fail|ok\b|test|✓|✔|assert|expect|bun|vitest|jest/i.test(output)) return false;
  return true;
}

/**
 * Pure review. Never throws on bad input — returns fail with reasons.
 * Fail-closed: any missing proof is a fail, never a pass.
 */
export function reviewJob(input: ReviewInput): ReviewVerdict {
  const reasons: string[] = [];
  const base: ReviewVerdict = {
    verdict: 'fail',
    blocking: true,
    reasons,
    jobName: input.jobName,
    reviewedCommit: input.jobHead,
    reviewedBase: input.baseHead,
  };
  const fail = (verdict: ReviewVerdict): ReviewVerdict => ({ ...verdict, verdict: 'fail', blocking: true });

  if (!input.changedFiles || input.changedFiles.length === 0) {
    reasons.push('no changes to review: empty diff');
    return fail(base);
  }

  if (input.touchSet && input.touchSet.length > 0) {
    const violations = input.changedFiles.filter((f) => !matchesTouchSet(f, input.touchSet!));
    if (violations.length > 0) {
      reasons.push(
        `touchSet violation: ${violations.join(', ')} outside [${input.touchSet.join(', ')}]`,
      );
    }
  }

  const ev = input.evidence ?? null;
  if (!ev) {
    reasons.push('delivery without evidence: missing test command/output/commit');
    if (input.claimedPass) reasons.push('optimistic report without proof: claimed pass but no evidence');
    return fail({ ...base, reasons });
  }

  if (!ev.command || ev.command.trim() === '') {
    reasons.push('missing test command: cannot repeat what was not recorded');
  }
  if (!ev.output || ev.output.trim() === '') {
    reasons.push('missing observable test output: nothing to verify');
  }
  // Provenance: the output must come from a product-executed run (command +
  // exit + output + commit + environment recorded by the orchestrator), not
  // from caller-declared text. No environment = no observable execution.
  if (!ev.environment || ev.environment.trim() === '') {
    reasons.push('missing execution environment: cannot tell observed product execution from declared text');
  }
  if (!ev.testedCommit || ev.testedCommit.trim() === '') {
    reasons.push('missing tested commit: unknown which code was tested');
  } else if (ev.testedCommit !== input.jobHead) {
    reasons.push(
      `tested code diverges: evidence covers ${ev.testedCommit} but job HEAD is ${input.jobHead} (stale)`,
    );
  }
  if (ev.exitCode !== 0) {
    reasons.push(`tests did not pass: exit code ${ev.exitCode}`);
    if (input.claimedPass) reasons.push('optimistic report without proof: claimed pass but tests failed');
  }

  for (const req of input.requirements) {
    const covered = req.testAnchors.some((a) => anchorCovered(a, ev.output ?? ''));
    if (!covered) {
      reasons.push(
        `green tests do not cover requirement "${req.id}": none of [${req.testAnchors.join(', ')}] in test output`,
      );
    }
  }

  const tc = input.testChange;
  if (tc && tc.changedTestFiles.length > 0) {
    if (!tc.reasonPreviousIncorrect || tc.reasonPreviousIncorrect.trim() === '') {
      reasons.push(
        `test change without record: ${tc.changedTestFiles.join(', ')} changed but no reason why the previous test was incorrect`,
      );
    }
  }

  if (reasons.length > 0) return fail({ ...base, reasons });
  return { ...base, verdict: 'pass', blocking: false, reasons: [] };
}

/**
 * An approval taken on oldBaseHead never auto-applies after the base
 * moves (merge or new main). True = must re-review.
 */
export function needsReReview(approvedBaseHead: string, currentBaseHead: string): boolean {
  return approvedBaseHead !== currentBaseHead;
}

/**
 * Legitimate test changes must record why the previous test was wrong.
 * Weakening a test to force approval without this record is rejected.
 */
export function validateTestChange(record: TestChangeRecord | null | undefined): {
  ok: boolean;
  reason?: string;
} {
  if (!record || record.changedTestFiles.length === 0) return { ok: true };
  if (!record.reasonPreviousIncorrect || record.reasonPreviousIncorrect.trim() === '') {
    return {
      ok: false,
      reason: 'refusing to weaken/alter tests without a record of why the previous test was incorrect',
    };
  }
  return { ok: true };
}

/** True when the same commit both passed and failed: flaky, quarantine. */
export function isFlakySequence(results: Array<{ commit: string; passed: boolean }>): boolean {
  const byCommit = new Map<string, Set<boolean>>();
  for (const r of results) {
    let set = byCommit.get(r.commit);
    if (!set) {
      set = new Set();
      byCommit.set(r.commit, set);
    }
    set.add(r.passed);
  }
  for (const set of byCommit.values()) {
    if (set.size > 1) return true;
  }
  return false;
}

export interface FixLoopOptions {
  /** Max fix attempts after the initial review. 0 = no fixes, fail fast. */
  maxFixCycles: number;
  /** Base backoff between attempts. */
  backoffMs: number;
  /** Exponential multiplier per attempt. Default 2. */
  backoffMultiplier?: number;
  /** Same failure signature repeating this often quarantines as flaky. Default 2. */
  quarantineAfterRepeats?: number;
}

export interface FixLoopResult {
  verdict: ReviewVerdict;
  attempts: number;
  quarantined: boolean;
}

function signatureOf(v: ReviewVerdict): string {
  return [...v.reasons].sort().join('\n');
}

/**
 * Bounded fix loop with backoff and flaky quarantine.
 * - review() re-evaluates the (possibly fixed) input each cycle.
 * - fix() returns the corrected input or null when it cannot fix.
 * - repeating the same failure signature quarantines instead of looping forever.
 */
export async function runReviewFixLoop(opts: {
  input: ReviewInput;
  options: FixLoopOptions;
  review: (input: ReviewInput) => Promise<ReviewVerdict> | ReviewVerdict;
  fix: (attempt: number, last: ReviewVerdict, input: ReviewInput) => Promise<ReviewInput | null>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<FixLoopResult> {
  const multiplier = opts.options.backoffMultiplier ?? 2;
  const quarantineAfter = opts.options.quarantineAfterRepeats ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const seen = new Map<string, number>();

  let current = opts.input;
  for (let attempt = 0; ; attempt++) {
    const verdict = await opts.review(current);
    if (verdict.verdict === 'pass') {
      return { verdict, attempts: attempt, quarantined: false };
    }
    const sig = signatureOf(verdict);
    seen.set(sig, (seen.get(sig) ?? 0) + 1);
    if ((seen.get(sig) ?? 0) >= quarantineAfter && attempt > 0) {
      return { verdict, attempts: attempt, quarantined: true };
    }
    if (attempt >= opts.options.maxFixCycles) {
      return { verdict, attempts: attempt, quarantined: false };
    }
    const backoff = Math.round(opts.options.backoffMs * Math.pow(multiplier, attempt));
    if (backoff > 0) await sleep(backoff);
    const fixed = await opts.fix(attempt, verdict, current);
    if (!fixed) {
      return { verdict, attempts: attempt, quarantined: false };
    }
    current = fixed;
  }
}
