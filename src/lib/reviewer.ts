/**
 * M4 reviewer: fail-closed gate that validates evidence before integration.
 *
 * A job only passes when ALL hold:
 * - non-empty diff (changedFiles)
 * - touchSet respected (no file outside the allowed globs)
 * - test evidence present: command + exit 0 + observable output +
 *   testedCommit === jobHead (the exact code that was tested)
 * - every essential requirement is functionally covered: a coordinator-side
 *   sufficiency check reads implementation + test content and requires a test
 *   assertion that actually calls the implementation (stdout anchor text
 *   alone NEVER decides pass — title without coverage fails, real coverage
 *   with a different title passes). Structure prepared for a future OpenCode
 *   revisor (ReviewInput.sufficiency); this round uses the local coordinator
 *   check, no external model.
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
  /**
   * R01 identity: true when the tested tree was dirty (uncommitted changes).
   * Dirty evidence never verifies a commit.
   */
  dirty?: boolean;
  /** R01 identity: job commit included in an integration candidate. */
  taskHead?: string;
  /** R01 identity: base commit an integration candidate was built on. */
  candidateBase?: string;
  /** R01 identity: observed HEAD of the candidate actually executed. */
  candidateHead?: string;
}

/** Future OpenCode revisor hook: structured external sufficiency decision. */
export interface SufficiencyDecision {
  reviewer: 'coordinator' | 'opencode';
  decision: 'pass' | 'fail';
  reasons: string[];
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
  /**
   * R01 sufficiency: path -> content for implementation + test files as
   * observed on the tested candidate. Required whenever requirements are
   * graded — stdout anchors alone never decide pass.
   */
  fileContents?: Record<string, string>;
  /**
   * Paths inside fileContents that act as tests for this run (e.g. files
   * referenced by the test command). When provided, coverage is searched
   * there; otherwise test-likeness is guessed from the file name.
   */
  testPaths?: string[];
  /**
   * Future OpenCode revisor decision (structured, linked to the candidate).
   * Reserved for a later round; the local coordinator check decides now.
   */
  sufficiency?: SufficiencyDecision | null;
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

/**
 * True when a task prompt carries at least one `- [ ]` acceptance line.
 * Autonomous plans always do (draft validation + launch append); manual
 * MCP plans may not. Absence of criteria is explicit — never a silent pass.
 */
export function hasAcceptanceCriteria(prompt: string): boolean {
  return prompt.split('\n').some((l) => /^-\s*\[\s*\]\s+\S/.test(l.trim()));
}

/**
 * Derive essential requirements from a task prompt's acceptance criteria
 * (`- [ ] ...` lines appended at launch). Each line becomes one requirement
 * whose test anchor is the line itself: a green suite only counts when its
 * observed output visibly exercises the criterion (e.g. a test named after
 * it). A prompt without acceptance yields one explicit fallback requirement
 * so the absence of criteria fails closed instead of passing silently.
 * NOTE: the orchestrator applies a documented manual-plan fallback for this
 * case (see reviewJobWithFixLoop) instead of judging coverage against the
 * artificial anchor — absence of criteria is reported, never graded.
 */
export function requirementsFromAcceptance(jobName: string, prompt: string): EssentialRequirement[] {
  const lines = prompt
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-\s*\[\s*\]\s+/.test(l))
    .map((l) => l.replace(/^-\s*\[\s*\]\s+/, '').trim())
    .filter((l) => l.length > 0);
  const uniq = [...new Set(lines)];
  if (uniq.length === 0) {
    const first = prompt.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? jobName;
    return [{ id: `${jobName}-acceptance`, description: first.slice(0, 200), testAnchors: [jobName] }];
  }
  return uniq.map((a, i) => ({ id: `${jobName}-req-${i + 1}`, description: a, testAnchors: [a] }));
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
 *
 * NOTE (R01): anchor presence is only a locating signal. It NEVER decides
 * pass alone — see assessFunctionalCoverage below.
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

function isTestPath(path: string): boolean {
  return /test|spec|__tests__|\.test\.|\.spec\./i.test(path);
}

/** Runner pass signal in observed output (no anchor required). */
function hasPassSignal(output: string): boolean {
  if (!output || output.trim().length < 3) return false;
  return /pass|ok\b|✓|✔|#[a-z]*pass/i.test(output);
}

const REQUIREMENT_STOPWORDS = new Set([
  'test', 'tests', 'assert', 'asserts', 'expect', 'expects', 'should', 'must',
  'with', 'without', 'when', 'then', 'than', 'that', 'this', 'from', 'into',
  'true', 'false', 'null', 'undefined', 'pass', 'passed', 'fail', 'failed',
  'and', 'the', 'for', 'are', 'not',
]);

function extractRequirementSymbols(description: string, anchors: string[]): string[] {
  const text = `${description} ${anchors.join(' ')}`;
  const found = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const uniq: string[] = [];
  for (const token of found) {
    const lower = token.toLowerCase();
    if (REQUIREMENT_STOPWORDS.has(lower)) continue;
    if (/^\d+$/.test(token)) continue;
    // Single-letter code symbols (a(), b()) are legitimate — keep them.
    if (!uniq.some((s) => s.toLowerCase() === lower)) uniq.push(token);
  }
  // Prefer symbols actually called in the criterion text (`a()` over prose).
  const called = uniq.filter((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(text));
  return [...called, ...uniq.filter((s) => !called.includes(s))].slice(0, 12);
}

function findDefinedSymbols(content: string, symbols: string[]): string[] {
  const defined: string[] = [];
  for (const sym of symbols) {
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(function\\s+${escaped}\\b|class\\s+${escaped}\\b|(?:const|let|var)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(?:function|\\(|=>)|def\\s+${escaped}\\b|fn\\s+${escaped}\\b|export\\s+(?:default\\s+)?(?:function|const|let|var|class)?\\s*${escaped}\\b)`,
    );
    if (pattern.test(content)) defined.push(sym);
  }
  return defined;
}

/**
 * Strip string literals and comments so a requirement symbol mentioned only
 * in a test title (e.g. `test('total([1,2])===3', ...)`) is never mistaken
 * for a real call. Short heuristic — upgrade to a structured parser if it
 * misfires.
 */
function stripStringsAndComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  let quote: string | null = null;
  while (i < n) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '/' && i + 1 < n) {
      const next = source[i + 1]!;
      if (next === '/') {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        i += 2;
        while (i + 1 < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * True when test code really invokes `symbol(` — after stripping strings and
 * comments, so a title string alone never counts. Covers both assert-style
 * suites (`assert.equal(total([1,2]), 3)`) and exit-code harnesses
 * (`const got = total([1,2]); if (got !== 3) process.exit(1)`): what matters
 * is the implementation is called and the product-observed run passes.
 */
function testCallsSymbol(testContent: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = stripStringsAndComments(testContent);
  return new RegExp(`\\b${escaped}\\s*\\(`).test(stripped);
}

export interface FunctionalCoverage {
  covered: boolean;
  reason: string;
}

/**
 * R01 coordinator sufficiency: implementation + test content decide, never
 * stdout text. Covered only when:
 *  1. observed output carries a runner pass signal, AND
 *  2. some requirement symbol is defined in implementation files, AND
 *  3. some test file asserts through a call to that symbol.
 * Diagnostics name whether the implementation or the tests must change —
 * never "print the anchor".
 */
export function assessFunctionalCoverage(
  requirement: EssentialRequirement,
  fileContents: Record<string, string> | undefined,
  testOutput: string,
  opts?: { testPaths?: string[] },
): FunctionalCoverage {
  const contents = fileContents ?? {};
  const paths = Object.keys(contents);
  if (paths.length === 0) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): missing functional evidence (implementation/test content not examined — stdout text alone never verifies)`,
    };
  }
  if (!hasPassSignal(testOutput)) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no passing test execution observed in product-run output`,
    };
  }
  const symbols = extractRequirementSymbols(requirement.description, requirement.testAnchors);
  if (symbols.length === 0) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no code symbol to link requirement to implementation`,
    };
  }
  const explicit = (opts?.testPaths ?? []).filter((p) => p in contents);
  const testPool = explicit.length > 0 ? explicit : paths.filter((p) => isTestPath(p));
  if (testPool.length === 0) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no test file to examine (no test in scope) — add a test that calls the implementation`,
    };
  }
  const implPool = paths.filter((p) => !testPool.includes(p));
  const implSources = (implPool.length > 0 ? implPool : paths.filter((p) => !testPool.includes(p)))
    .map((p) => contents[p] ?? '').join('\n');
  const defined = findDefinedSymbols(implSources, symbols);
  if (defined.length === 0) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): implementation does not define ${symbols.join('/')} — fix the implementation (changed files: ${implPool.join(', ') || 'none'})`,
    };
  }
  for (const sym of defined) {
    for (const tp of testPool) {
      const tc = contents[tp] ?? '';
      if (testCallsSymbol(tc, sym)) {
        return { covered: true, reason: `requirement "${requirement.id}" exercised: test ${tp} calls ${sym}()` };
      }
    }
  }
  const anchorHint = requirement.testAnchors.some((a) => testOutput.includes(a))
    ? ' (output mentions the anchor text but no test calls the implementation — title without coverage)'
    : '';
  return {
    covered: false,
    // Legacy phrase kept: downstream automation matches /do not cover requirement/.
    reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no test calls ${defined.join('/')}() — fix the tests to exercise the implementation${anchorHint}`,
  };
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
  } else if (ev.taskHead !== undefined || ev.candidateBase !== undefined || ev.candidateHead !== undefined) {
    // Integration candidate: the executed tree is base+job, not job alone.
    // testedCommit must be the observed candidate HEAD; task/base pins must match.
    if (!ev.candidateHead || ev.candidateHead.trim() === '') {
      reasons.push('missing candidate identity: integration evidence without observed candidate HEAD');
    } else if (ev.testedCommit !== ev.candidateHead) {
      reasons.push(
        `candidate identity mismatch: testedCommit ${ev.testedCommit} is not the observed candidate ${ev.candidateHead}`,
      );
    }
    if (!ev.taskHead || ev.taskHead !== input.jobHead) {
      reasons.push(
        `candidate does not contain the reviewed job: taskHead ${ev.taskHead ?? '(missing)'} but job HEAD is ${input.jobHead}`,
      );
    }
    if (!ev.candidateBase || ev.candidateBase !== input.baseHead) {
      reasons.push(
        `candidate base diverges: evidence built on ${ev.candidateBase ?? '(missing)'} but review base is ${input.baseHead} (stale)`,
      );
    }
  } else if (ev.testedCommit !== input.jobHead) {
    reasons.push(
      `tested code diverges: evidence covers ${ev.testedCommit} but job HEAD is ${input.jobHead} (stale)`,
    );
  }
  if (ev.dirty) {
    reasons.push('tested tree was dirty: uncommitted changes present — refusing to attribute the run to a commit');
  }
  if (ev.exitCode !== 0) {
    reasons.push(`tests did not pass: exit code ${ev.exitCode}`);
    if (input.claimedPass) reasons.push('optimistic report without proof: claimed pass but tests failed');
  }

  // R01 sufficiency: stdout anchor text NEVER decides pass. Each requirement
  // must be functionally exercised (test code calls the implementation).
  // gradedRequirements empty = manual-plan fallback (no criterion to judge).
  for (const req of input.requirements) {
    const assessment = assessFunctionalCoverage(req, input.fileContents, ev.output ?? '', {
      testPaths: input.testPaths,
    });
    if (!assessment.covered) {
      reasons.push(assessment.reason);
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
