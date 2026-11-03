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

import { matchesTouchPattern } from './merge-train';

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
   * When present with `reviewer: 'opencode'`, its verdict is enforced: an
   * external `fail` blocks even with local coverage (fail-closed), and an
   * external `pass` still requires the local check below — neither side
   * passes alone. Produced by `reviewFunctionallyViaOpenCode`
   * (src/lib/opencode-reviewer.ts), which the integrator attaches.
   */
  sufficiency?: SufficiencyDecision | null;
  /**
   * Strict composition for the production path: pass requires an external
   * opencode pass decision in `sufficiency` — the local heuristic never
   * decides alone. Absent external pass ⇒ fail-closed (never a pass).
   * Off by default so unit scope stays deterministic.
   */
  requireExternalSufficiency?: boolean;
}

export interface ReviewVerdict {
  verdict: ReviewVerdictValue;
  /** True when verdict === 'fail': integration must not proceed. */
  blocking: boolean;
  reasons: string[];
  jobName: string;
  reviewedCommit: string;
  reviewedBase: string;
  /**
   * G4 audit trail: non-blocking notes (e.g. a discounted command-scope
   * complaint from the external reviewer). Never decides pass/fail alone —
   * it records WHY a non-functional external veto was set aside while the
   * deterministic product checks + local functional coverage passed.
   */
  audit?: string[];
}

/**
 * G4: True when an external reviewer reason is ONLY about command shape
 * (isolated vs global run, file counts, command spelling) — never about
 * whether tests call the implementation and assert the result. Such
 * complaints are out of scope for the external judge: the product verifies
 * execution deterministically (command + exit 0 + output + commit), and a
 * global `bun test` run that includes the task's tests passing satisfies
 * execution even when the requirement text names a per-file command.
 * P2 (fail-closed): a semantic/functional rejection or an ambiguous/mixed
 * reason NEVER counts as command-scope, even when wrapped in command-shape
 * language ("observed output shows 1 pass across 1 files; tests never cover
 * negative numbers" is functional). When in doubt the reason is functional:
 * only a purely command-shaped complaint is discounted, and only with proof
 * the task's tests executed (see reviewJob).
 *
 * P2-general (cause, not wording): the old check was a denylist of functional
 * keywords — any functional objection phrased outside the list ("returns zero
 * for inputs below zero") was discounted into a pass. The contract is now
 * inverted: strip the small closed set of command-shape boilerplate (runner
 * vocabulary, counts with units, file paths, requirement ids, the fail-closed
 * marker); whatever substantive token REMAINS is a functional objection, in
 * any language or phrasing, and the reason stays functional. Only a reason
 * reduced to pure boilerplate — that still names execution shape — is
 * discounted. Unknown words default to substantive (fail-closed).
 * shortcut: boilerplate-strip heuristic — upgrade to a structured parser if it misfires.
 */
const COMMAND_SCOPE_MARKER =
  /across\s+\d+\s+files?|\bisolated\b|single-file|command-specific|anchored command|in 1 file|observed output shows|no direct evidence.*command/;

/** Runner/execution-shape words: HOW tests ran, never WHAT the code must do. */
const COMMAND_SHAPE_VOCABULARY = new Set([
  'observed', 'output', 'outputs', 'shows', 'show', 'shown', 'reports', 'report', 'reported',
  'across', 'isolated', 'isolation', 'anchored', 'command', 'commands', 'specific', 'single',
  'per', 'shape', 'run', 'runs', 'running', 'ran', 'suite', 'suites', 'global', 'globally',
  'demonstrated', 'demonstrates', 'demonstrate', 'demonstration', 'evidence', 'direct',
  'file', 'files', 'test', 'tests', 'tested', 'testing', 'pass', 'passes', 'passed', 'passing',
]);

/** Pure grammatical glue: carries no objection by itself. */
const REASON_GLUE = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'on', 'with', 'and', 'or', 'to',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'as', 'by', 'from', 'at',
  'but', 'not', 'no', 'nor', 'so', 'than', 'then', 'do', 'does', 'did', 'if',
]);

/**
 * Substantive tokens left after removing command-shape boilerplate. Empty =
 * the reason says nothing beyond execution shape (discountable when it names
 * that shape); non-empty = it carries a functional objection (fail-closed).
 */
function commandShapeRemainder(reason: string): string[] {
  let s = reason.toLowerCase();
  s = s.replace(/\bfail-closed\b/g, ' ');
  s = s.replace(/^\s*[\w.()~+-]+\s*:\s*/, ' '); // leading "req-id:" / "external:"
  s = s.replace(/\b[a-z0-9_.-]*req-?\d+\b/g, ' '); // requirement refs ("sum-req-3")
  s = s.replace(/\S*\/\S*/g, ' '); // file paths ("tests/sum.test.ts")
  s = s.replace(/\b[\w~.-]+\.(?:test|spec)\.[a-z0-9]+\b/g, ' ');
  s = s.replace(/\b[\w~.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|cpp|c|h)\b/g, ' ');
  s = s.replace(/\b\d+\s*(?:pass(?:es)?|fail(?:ed|s)?|tests?|expect(?:\(\))?\s*calls?|files?)\b/g, ' '); // counts with units
  const tokens = s.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return tokens.filter((t) => {
    if (/^\d+$/.test(t)) return true; // bare values ("-5", "0") are content
    if (t.length === 1) return t !== 's'; // possessive residue; other letters may be code symbols
    if (COMMAND_SHAPE_VOCABULARY.has(t)) return false;
    if (REASON_GLUE.has(t)) return false;
    return true;
  });
}

export function isCommandScopeComplaint(reason: string): boolean {
  if (!reason || reason.trim().length === 0) return false;
  if (commandShapeRemainder(reason).length > 0) return false;
  return COMMAND_SCOPE_MARKER.test(reason.toLowerCase());
}

/** Split external reasons into out-of-scope command-shape vs functional. */
export function partitionExternalReasons(reasons: string[]): {
  commandScope: string[];
  functional: string[];
} {
  const commandScope: string[] = [];
  const functional: string[] = [];
  for (const reason of reasons) {
    if (isCommandScopeComplaint(reason)) commandScope.push(reason);
    else functional.push(reason);
  }
  return { commandScope, functional };
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
  return touchSet.some((pattern) => matchesTouchPattern(pattern, file));
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

/**
 * Remove non-executed test blocks: `test.skip(...)`, `it.skip(...)`,
 * `describe.skip(...)`, `test.todo(...)`, `xit(...)`, `xtest(...)`,
 * `xdescribe(...)`. A skipped assertion never runs, so it never demonstrates
 * anything — counting it would let a green suite of other tests verify an
 * unexecuted requirement (P2-general: skipped tests don't exercise the task).
 * shortcut: balanced-paren removal — upgrade to a structured parser if it misfires.
 */
function stripSkippedTests(source: string): string {
  let out = source;
  const re = /\b(?:test|it|describe)\s*\.\s*skip\s*\(|\btest\s*\.\s*todo\s*\(|\bx(?:it|test|describe)\s*\(/g;
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) break;
    const open = out.indexOf('(', m.index);
    if (open < 0) break;
    const bal = extractBalanced(out, open);
    if (!bal) break;
    out = `${out.slice(0, m.index)}\n${out.slice(open + bal.length)}`;
  }
  return out;
}

/**
 * True when the requirement text carries a code reference (a call `sym(`,
 * a comparison `===`/`==`, or a quoted literal). Bare prose numbers
 * ("retry 3 times", "sum of 2 numbers") are NOT code refs: a digit only
 * counts when adjacent to code punctuation (brackets, parens, commas,
 * operators), e.g. `total([1,2])===3`. A requirement without real refs is
 * behavioural prose and takes the behavioural path. Numbers in prose must
 * never force a vocabulary obligation on internal symbol names.
 * shortcut: punctuation-adjacency heuristic — upgrade to a structured parser if it misfires.
 */
function hasCodeReferences(text: string): boolean {
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text)) return true;
  if (/===|!==|==|!=|=>/.test(text)) return true;
  if (/'[^']+'|"[^"]+"|`[^`]+`/.test(text)) return true;
  // A digit counts only adjacent to code punctuation (brackets, parens,
  // commas, operators). Sentence punctuation (`.`, `,`, `;`, `:`, `?`) after
  // a prose number ("uses 3.") does NOT count.
  if (/[(\[{,=!<>:+\-*/%&|]\s*\d|\d\s*[)\]},=!<>:+\-*/%&|]/.test(text)) return true;
  return false;
}

/** Filenames/paths alone are never coverage (anchor must be behaviour). */
function isPathLikeAnchor(anchor: string): boolean {
  const s = anchor.trim();
  if (s.includes('/') || s.includes('\\')) return true;
  if (/\.test\.|\.spec\.|__tests__/.test(s)) return true;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h|rb|php)$/i.test(s)) return true;
  return false;
}

/** Numbers, quoted literals and booleans the criterion pins down. */
function extractRequiredLiterals(text: string): string[] {
  // G4b: prose test-counts ("at least 3 cases", "4 tests", "3 test cases")
  // are suite shape, never values to assert. Strip them before extracting
  // numbers so a correct delivery with N passing tests is not forced to
  // assert the literal N. Genuine values (`total([1,2])===3`, quoted
  // literals, booleans) are unaffected — they never sit in a cases/tests
  // phrase.
  const withoutCounts = text
    .replace(/\b\d+\s+(test\s+)?cases?\b/gi, ' ')
    .replace(/\b\d+\s+tests?\b/gi, ' ')
    .replace(/\b(at least|at most|minimum|maximum|exactly)\s+\d+\b/gi, (m) => m.replace(/\d+/g, ' '));
  const nums = withoutCounts.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  const bools = (text.match(/\b(true|false|null|undefined)\b/gi) ?? []).map((s) => s.toLowerCase());
  const quoted: string[] = [];
  const qre = /'([^']+)'|"([^"]+)"|`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = qre.exec(text)) !== null) {
    const inner = m[1] ?? m[2] ?? m[3] ?? '';
    if (inner.length > 0) quoted.push(inner);
  }
  return [...new Set([...nums, ...bools, ...quoted])].slice(0, 12);
}

/** Strip comments but keep string contents (expected values live there). */
function stripCommentsKeepStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  let quote: string | null = null;
  while (i < n) {
    const ch = source[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += source[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
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

/** Drop import/require lines: `assert` in an import is never an assertion. */
function removeImportRequireLines(source: string): string {
  return source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (/^import\b/.test(t)) return false;
      if (/\brequire\s*\(/.test(t)) return false;
      return true;
    })
    .join('\n');
}

/** Extract the balanced `(...)` starting at openIdx (which must be `(`). */
function extractBalanced(source: string, openIdx: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * Assertion snippets: the actual argument list of each assert-verb call,
 * not a character window. Only verb forms count — `assert.equal(`,
 * `assert.ok(`, `assert.deepEqual(`, bare `assert(`, `expect(` (plus its
 * `.toX(...)` chain). An `assert` that only appears in an import/require
 * line is never an assertion (those lines are removed first).
 * shortcut: regex + balanced-paren scan — upgrade to a structured parser if it misfires.
 */
function assertionSnippets(noCommentsNoImports: string): string[] {
  const src = noCommentsNoImports;
  const out: string[] = [];
  const re = /\bassert\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_]*\s*)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const bal = extractBalanced(src, open);
    if (bal) out.push(src.slice(m.index, open + bal.length));
  }
  const reExpect = /\bexpect\s*\(/g;
  while ((m = reExpect.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const bal = extractBalanced(src, open);
    if (!bal) continue;
    let snippet = src.slice(m.index, open + bal.length);
    // Append the `.toX(...)` member chain: structurally linked to this
    // expect call (up to `;`/newline, capped), never a free text window.
    const tail = src.slice(open + bal.length);
    const endOfChain = tail.search(/[;\n]/);
    const head = (endOfChain < 0 ? tail : tail.slice(0, endOfChain)).slice(0, 160);
    if (/^\s*\./.test(head)) snippet += head;
    out.push(snippet);
  }
  return out;
}

function snippetCallsSymbol(snippet: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*\\(`).test(stripStringsAndComments(snippet));
}

/**
 * Numbers/booleans must appear in CODE (strings stripped — a test title
 * like `test('total([1,2])===3', ...)` never supplies expected values).
 * Quoted literals live inside strings, so they are matched on the raw
 * snippet instead.
 */
function snippetCoversLiterals(snippet: string, literals: string[]): boolean {
  const stripped = stripStringsAndComments(snippet);
  for (const lit of literals) {
    if (/^\d+(?:\.\d+)?$/.test(lit)) {
      if (!new RegExp(`\\b${lit.replace('.', '\\.')}\\b`).test(stripped)) return false;
    } else if (/^(true|false|null|undefined)$/i.test(lit)) {
      if (!new RegExp(`\\b${lit}\\b`, 'i').test(stripped)) return false;
    } else if (!snippet.includes(lit)) {
      return false;
    }
  }
  return true;
}

/**
 * Exit-code harness link: `x = sym(...); ... if (x !== <lit>) process.exit(1)`
 * (or `throw`). The variable bridges the call to the checked value, so a
 * bare `sym(x);` next to an unrelated assert does NOT bind.
 */
function exitHarnessCovers(code: string, symbol: string, required: string[]): boolean {
  if (!/\bprocess\.exit\b|\bthrow\b/.test(code)) return false;
  const stripped = stripStringsAndComments(code);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Direct comparison harness (`if (sym(...) === <lit>) ... process.exit(1)`).
  // The call and literal share one ===/!==/==/!= comparison, so they are bound
  // by construction (unlike window co-occurrence). Bare `sym();` next to an
  // unrelated exit never counts. shortcut: single-line comparison heuristic.
  const compOp = '(?:===|!==|==|!=)';
  if (required.length === 0) {
    if (new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*${compOp}`).test(stripped)) return true;
  } else {
    for (const lit of required) {
      if (/^\d+(?:\.\d+)?$/.test(lit) || /^(true|false|null|undefined)$/i.test(lit)) {
        const litRe = `\\b${lit.replace('.', '\\.')}\\b`;
        if (
          new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*${compOp}\\s*${litRe}`).test(stripped) ||
          new RegExp(`${litRe}\\s*${compOp}[^;{]*\\b${escaped}\\s*\\(`).test(stripped)
        ) {
          return true;
        }
      } else if (code.includes(lit)) {
        if (new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*${compOp}`).test(stripped)) return true;
      }
    }
  }
  const assignRe = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${escaped}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(stripped)) !== null) {
    const v = m[1]!;
    const vEsc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (required.length === 0) {
      if (new RegExp(`\\b${vEsc}\\b`).test(stripped.slice(m.index))) return true;
    } else {
      for (const lit of required) {
        const litRe = /^\d+(?:\.\d+)?$/.test(lit)
          ? `\\b${lit.replace('.', '\\.')}\\b`
          : /^(true|false|null|undefined)$/i.test(lit)
            ? `\\b${lit}\\b`
            : null;
        if (litRe === null) {
          if (code.includes(lit) && new RegExp(`\\b${vEsc}\\b`).test(stripped.slice(m.index))) return true;
        } else if (
          new RegExp(`\\b${vEsc}\\b[^;{]*${litRe}|${litRe}[^;{]*\\b${vEsc}\\b`).test(stripped.slice(m.index))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** An assertion verb whose own arguments really invoke `symbol(`. */
function hasAssertedCall(testContent: string, symbol: string): boolean {
  const code = removeImportRequireLines(stripCommentsKeepStrings(testContent));
  for (const s of assertionSnippets(code)) {
    if (snippetCallsSymbol(s, symbol)) return true;
  }
  if (exitHarnessCovers(code, symbol, [])) return true;
  return false;
}

/**
 * Bound assertion: the expected literals sit INSIDE the assert arguments
 * that receive the `symbol(` call (or a harness variable links them), so
 * `total([1,2]); assert.equal(3,3)` does NOT bind — the `3`s never touch
 * the call. Mere window co-occurrence never suffices.
 */
function hasBoundAssertion(testContent: string, symbol: string, required: string[]): boolean {
  const code = removeImportRequireLines(stripCommentsKeepStrings(testContent));
  for (const s of assertionSnippets(code)) {
    if (snippetCallsSymbol(s, symbol) && snippetCoversLiterals(s, required)) return true;
  }
  if (exitHarnessCovers(code, symbol, required)) return true;
  return false;
}

/** Implementation-side candidates (`export function name`, `def name`, ...) for NL requirements. */
function extractImplCandidates(implSources: string): string[] {
  const out: string[] = [];
  const re =
    /(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)|\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(|\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b|(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\(|function|=>)|def\s+([A-Za-z_][A-Za-z0-9_]*)\b|fn\s+([A-Za-z_][A-Za-z0-9_]*)\b|export\s+(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(|(?:exports|module\.exports)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(implSources)) !== null) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8];
    if (!name) continue;
    if (REQUIREMENT_STOPWORDS.has(name.toLowerCase())) continue;
    if (!out.some((s) => s.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

/** Balanced `{...}` slice starting at braceIdx (which must be `{`). */
function extractBraceBody(code: string, braceIdx: number): string | null {
  let depth = 0;
  for (let i = braceIdx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(braceIdx + 1, i);
    }
  }
  return null;
}

/**
 * Minimal def lookup: params + body of `function sym(...) {...}`,
 * `sym = (...) => ...`, and their `export`/`exports` forms
 * (`export function sym`, `export const sym =`, bare `export sym(...)`,
 * `exports.sym =` / `module.exports.sym =`).
 */
function findFunctionDef(
  implSources: string,
  name: string,
): { params: string[]; body: string } | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = stripCommentsKeepStrings(implSources);
  const fnRe = new RegExp(`(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${esc}\\s*\\(([^)]*)\\)`);
  const fnM = fnRe.exec(code);
  if (fnM) {
    const brace = code.indexOf('{', fnM.index + fnM[0].length);
    if (brace >= 0) {
      const body = extractBraceBody(code, brace);
      if (body !== null) return { params: splitParams(fnM[1] ?? ''), body };
    }
  }
  const arrowRe = new RegExp(
    `(?:export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?\\(?([^)=;]*)\\)?\\s*=>\\s*`,
  );
  const arrowM = arrowRe.exec(code);
  if (arrowM) {
    const bodyStart = arrowM.index + arrowM[0].length;
    if (code[bodyStart] === '{') {
      const body = extractBraceBody(code, bodyStart);
      if (body !== null) return { params: splitParams(arrowM[1] ?? ''), body };
    } else {
      const semi = code.indexOf(';', bodyStart);
      const nl = code.indexOf('\n', bodyStart);
      const end = semi < 0 ? (nl < 0 ? code.length : nl) : nl < 0 ? semi : Math.min(semi, nl);
      return { params: splitParams(arrowM[1] ?? ''), body: code.slice(bodyStart, end) };
    }
  }
  // Bare export form (`export sym(...) {...}`) and CommonJS
  // (`exports.sym = function(...) {...}` / `= (...) => ...`).
  const bareRe = new RegExp(`export\\s+(?:async\\s+)?${esc}\\s*\\(([^)]*)\\)`);
  const bareM = bareRe.exec(code);
  if (bareM) {
    const brace = code.indexOf('{', bareM.index + bareM[0].length);
    if (brace >= 0) {
      const body = extractBraceBody(code, brace);
      if (body !== null) return { params: splitParams(bareM[1] ?? ''), body };
    }
  }
  const cjsRe = new RegExp(
    `(?:exports\\s*\\.\\s*${esc}|module\\s*\\.\\s*exports\\s*\\.\\s*${esc})\\s*=\\s*(?:async\\s*)?(?:function\\s*\\(([^)]*)\\)|\\(?([^)=;]*)\\)?\\s*=>)\\s*`,
  );
  const cjsM = cjsRe.exec(code);
  if (cjsM) {
    const params = splitParams((cjsM[1] ?? cjsM[2] ?? '') as string);
    const bodyStart = cjsM.index + cjsM[0].length;
    if (code[bodyStart] === '{') {
      const body = extractBraceBody(code, bodyStart);
      if (body !== null) return { params, body };
    } else {
      const semi = code.indexOf(';', bodyStart);
      const nl = code.indexOf('\n', bodyStart);
      const end = semi < 0 ? (nl < 0 ? code.length : nl) : nl < 0 ? semi : Math.min(semi, nl);
      return { params, body: code.slice(bodyStart, end) };
    }
  }
  return null;
}

function splitParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? '')
    .filter((p) => p.length > 0);
}

/**
 * Re-export specifiers (`export * from './x'`, `export {a} from './x'`,
 * `import {a} from './x'`, `require('./x')`). General by syntax — never by
 * filename (no index.js hardcode). Bare specifiers (`lodash`) are returned
 * but never resolved (outside scope = ignored, never read).
 * shortcut: regex on comments-stripped source — upgrade to a structured parser if it misfires.
 */
function extractReExportSpecifiers(content: string): string[] {
  const out: string[] = [];
  const code = stripCommentsKeepStrings(content);
  const fromRe = /\b(?:import|export)\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(code)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Resolve a relative spec (`./x`, `../y`) to a key in scope; null = outside scope. */
function resolveScopeTarget(fromPath: string, spec: string, available: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const slash = fromPath.lastIndexOf('/');
  const baseDir = slash < 0 ? '' : fromPath.slice(0, slash);
  const parts = (baseDir ? `${baseDir}/${spec}` : spec).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const normalized = stack.join('/');
  const candidates = [normalized];
  if (!/\.[A-Za-z0-9]+$/.test(normalized)) {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']) {
      candidates.push(`${normalized}${ext}`);
    }
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']) {
      candidates.push(`${normalized}/index${ext}`);
    }
  }
  for (const c of candidates) {
    if (available.has(c)) return c;
  }
  return null;
}

/**
 * Join impl sources following relative re-exports inside scope (visited-set
 * for cycles; outside scope ignored, never read). Feeds both
 * extractImplCandidates and findFunctionDef so barrels resolve to the
 * target defs instead of failing blind.
 */
function collectReExportExpandedSources(
  contents: Record<string, string>,
  implPool: string[],
): string {
  const available = new Set(Object.keys(contents));
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const p of implPool) {
    if (p in contents && !visited.has(p)) {
      visited.add(p);
      queue.push(p);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const spec of extractReExportSpecifiers(contents[cur] ?? '')) {
      const target = resolveScopeTarget(cur, spec, available);
      if (target && !visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }
  return queue.map((p) => contents[p] ?? '').join('\n');
}

/** True when some impl file re-exports a relative target (barrel syntax, any filename). */
function implHasRelativeReExport(contents: Record<string, string>, implPool: string[]): boolean {
  return implPool.some((p) =>
    extractReExportSpecifiers(contents[p] ?? '').some((s) => s.startsWith('.')),
  );
}

/**
 * True when the defined function never references any of its own params
 * (e.g. `total(xs) { return 0; }`): it cannot compute anything from its
 * inputs, so an asserted call passing only on a trivial case (empty input
 * matching a constant) proves nothing about the requirement. Static-only
 * heuristic — a model reviewer would confirm; uncertainty is recorded in
 * the diagnostic, never a promise of perfection.
 */
function isVacuousImpl(implSources: string, name: string): boolean {
  const def = findFunctionDef(implSources, name);
  if (!def || def.params.length === 0) return false;
  const stripped = stripStringsAndComments(def.body);
  return !def.params.some((p) => new RegExp(`\\b${p}\\b`).test(stripped));
}

/**
 * True when the function only measures its input size
 * (`p.length`/`p.size`/`p.count`) without ever touching elements: e.g.
 * `total(xs) { return xs.length; }` coincides with a sum ONLY on the empty
 * input, so it proves nothing about an aggregation requirement. General
 * category (cardinality projection vs element computation), never a
 * single-name regex.
 * shortcut: member-access heuristic — upgrade to a structured parser if it misfires.
 */
function isCardinalityOnlyImpl(implSources: string, name: string): boolean {
  const def = findFunctionDef(implSources, name);
  if (!def || def.params.length === 0) return false;
  let body = stripStringsAndComments(def.body);
  for (const p of def.params) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp(`\\b${esc}\\s*\\.\\s*(?:length|size|count)\\b\\s*(?:\\(\\s*\\))?`, 'g'), ' ');
    body = body.replace(new RegExp(`\\bObject\\s*\\.\\s*keys\\s*\\(\\s*${esc}\\s*\\)\\s*\\.\\s*length\\b`, 'g'), ' ');
  }
  return !def.params.some((p) => new RegExp(`\\b${p}\\b`).test(body));
}

/** The requirement is specifically about the empty/zero case (`[]` is then a real case). */
function isEmptySpecificRequirement(text: string): boolean {
  return /empty|zero|blank|vac[ií]o|nulo|no\s+(items|elements|entries)|without\s+(items|elements)/i.test(text);
}

/** The requirement asks for a size/count (a cardinality projection then computes it). */
function isCardinalitySpecificRequirement(text: string): boolean {
  return /length|size|count|how\s+many|number\s+of|tamanho|quantidade|comprimento/i.test(text);
}

/**
 * True when the args of a `symbol(` call carry a distinguishing value: a
 * non-empty collection/object literal, a non-empty string, or a non-zero
 * number. `[]`, `''`, `0`, `null` alone never distinguish a correct
 * implementation from degenerate ones (constant, `length`, identity) that
 * coincide on the trivial input.
 * shortcut: literal-shape heuristic — upgrade to a structured parser if it misfires.
 */
function callArgsDistinguishing(args: string): boolean {
  if (/\[[^\[\]]*\S[^\[\]]*\]/.test(args)) return true;
  if (/\{[^{}]*\S[^{}]*}/.test(args)) return true;
  const strs = args.match(/'([^']*)'|"([^"]*)"|`([^`]*)`/g) ?? [];
  if (strs.some((s) => s.length > 2)) return true;
  if (/\b[1-9]\d*(?:\.\d+)?\b/.test(args)) return true;
  return false;
}

/**
 * True when some assert-verb snippet invoking `symbol(` passes a
 * distinguishing input (see callArgsDistinguishing). Exit-code harnesses
 * (`got = sym(...); if (got !== <lit>) process.exit(1)`) count when the
 * call itself carries one.
 */
function callHasDistinguishingInput(testContent: string, symbol: string): boolean {
  const code = removeImportRequireLines(stripCommentsKeepStrings(testContent));
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const s of assertionSnippets(code)) {
    const at = s.search(new RegExp(`\\b${escaped}\\s*\\(`));
    if (at < 0) continue;
    const open = s.indexOf('(', at);
    const bal = extractBalanced(s, open);
    if (bal && callArgsDistinguishing(bal)) return true;
  }
  if (/\bprocess\.exit\b|\bthrow\b/.test(code)) {
    const stripped = stripStringsAndComments(testContent);
    const callRe = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(stripped)) !== null) {
      const open = stripped.indexOf('(', m.index);
      const bal = extractBalanced(stripped, open);
      if (bal && callArgsDistinguishing(bal)) return true;
    }
  }
  return false;
}

export interface FunctionalCoverage {
  covered: boolean;
  reason: string;
}

/**
 * R01 coordinator sufficiency: implementation + test content decide, never
 * stdout text. Covered only when:
 *  1. observed output carries a runner pass signal, AND
 *  2a. code-ref requirements (`sym(`, `===`, numbers, quoted literals):
 *      some requirement symbol is defined in implementation files AND some
 *      test assertion binds a call to that symbol with the expected
 *      literals from the criterion (bare `f(x);` without assert fails;
 *      `assert(f([]),0)` does not cover `f([1,2])===3`), OR
 *  2b. behavioural NL requirements (no code refs): some implementation
 *      candidate is asserted through a call whose assert-verb arguments
 *      receive the call — and the implementation is not vacuous (it must
 *      use its inputs; a constant body proved only by a trivial-case
 *      assert demonstrates nothing). No vocabulary obligation.
 * Diagnostics name whether the implementation or the tests must change —
 * never "print the anchor".
 */
export function assessFunctionalCoverage(
  requirement: EssentialRequirement,
  fileContents: Record<string, string> | undefined,
  testOutput: string,
  opts?: { testPaths?: string[]; allowBarrelAbstention?: boolean },
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
  // Path-like anchors name the file whose execution should demonstrate the
  // requirement — a scope hint, not coverage and not a veto. Resolve each
  // anchor against examined content (execution itself is proven by the pass
  // signal above + the asserted test the normal judgment requires below);
  // only fail when the file is absent from scope. When present, fall through
  // to the normal judgment (code-ref with bound assertion / behavioural),
  // which alone decides coverage.
  // shortcut: exact/suffix/dir-prefix match on the whole anchor OR any
  // embedded path token — upgrade if anchors need globs.
  if (requirement.testAnchors.length > 0 && requirement.testAnchors.every(isPathLikeAnchor)) {
    const unresolved = requirement.testAnchors.filter((a) => {
      const t = a.trim();
      // Auto-generated criteria embed the file in a prose line ("X covered
      // in f.test.mjs"): extract path-looking substrings (token ending in a
      // source extension, with or without directory) and match ANY of them.
      const embedded = [...t.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.(mjs|cjs|mts|cts|tsx|ts|jsx|js|cpp|c|h|py|go|rs|java|rb|php)\b/g)].map((m) => m[0]);
      return ![t, ...embedded].some((c) =>
        paths.some((p) => p === c || p.endsWith(`/${c}`) || p.startsWith(c.endsWith('/') ? c : `${c}/`)),
      );
    });
    if (unresolved.length > 0) {
      return {
        covered: false,
        reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): test anchor file ${unresolved.join('/')} not in scope — no examined content matches it (fail-closed: the named test was not part of the reviewed candidate)`,
      };
    }
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
  // Executed tests only: skipped blocks never run, so they never demonstrate
  // a requirement (P2-general). All test reads below use the runnable content.
  const testContents: Record<string, string> = {};
  let skippedBlocksIgnored = false;
  for (const tp of testPool) {
    const raw = contents[tp] ?? '';
    const runnable = stripSkippedTests(raw);
    testContents[tp] = runnable;
    if (runnable !== raw) skippedBlocksIgnored = true;
  }
  const skipNote = skippedBlocksIgnored
    ? ' (note: test.skip/describe.skip/xit blocks were ignored — skipped assertions never execute)'
    : '';  // Barrels only re-export: follow relative re-exports inside scope so the
  // target defs count as candidates (cycles via visited-set; outside scope
  // ignored, never read from disk).
  const implSources = collectReExportExpandedSources(
    contents,
    implPool.length > 0 ? implPool : paths.filter((p) => !testPool.includes(p)),
  );
  const barrelWithNoVisibleCandidate =
    implHasRelativeReExport(contents, implPool) && extractImplCandidates(implSources).length === 0;
  const fullText = `${requirement.description} ${requirement.testAnchors.join(' ')}`;

  // 2b. Behavioural NL: no code refs — link any asserted implementation call.
  // A vacuous implementation (ignores its own inputs) never demonstrates a
  // behavioural requirement, even when a trivial-case assert passes. The same
  // holds for a cardinality-only body (`return xs.length` coincides with a
  // sum only on `[]`) and for trivial-case-only asserts: when the requirement
  // pins values down (numbers, quoted literals) the assert arguments must
  // bind the call to those values, and otherwise the tests must still show a
  // distinguishing (non-empty, non-zero) asserted call — unless the
  // requirement is itself about the empty case. No vocabulary obligation.
  if (!hasCodeReferences(fullText)) {
    const candidates = extractImplCandidates(implSources);
    // Barrel abstains ONLY when an external decision participates (prod
    // path): no visible definition in scope even after chasing — neutral,
    // the passing executable test + external OpenCode reviewer decide.
    // Without external participation the invisible implementation fails
    // closed (a bare executable signal never verifies unseen code).
    if (candidates.length === 0 && barrelWithNoVisibleCandidate) {
      if (opts?.allowBarrelAbstention !== true) {
        return {
          covered: false,
          reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): implementation not visible in scope (barrel re-export with no visible definition after chasing relative re-exports) and no external reviewer decision participates — fail-closed: the heuristic cannot examine what the tests execute`,
        };
      }
      return {
        covered: true,
        reason: `requirement "${requirement.id}" exercised via barrel re-export: no visible definition in scope after chasing relative re-exports — heuristic abstains (neutral), executable test passes and external reviewer decides`,
      };
    }
    const required = extractRequiredLiterals(fullText);
    const emptySpecific = isEmptySpecificRequirement(fullText);
    const cardinalitySpecific = isCardinalitySpecificRequirement(fullText);
    const vacuous: string[] = [];
    const shallow: string[] = [];
    const unbound: string[] = [];
    const trivialOnly: string[] = [];
    for (const cand of candidates) {
      const assertedIn = testPool.filter((tp) => hasAssertedCall((testContents[tp] ?? ''), cand));
      if (assertedIn.length === 0) continue;
      if (isVacuousImpl(implSources, cand)) {
        if (!vacuous.some((s) => s.toLowerCase() === cand.toLowerCase())) vacuous.push(cand);
        continue;
      }
      if (!cardinalitySpecific && isCardinalityOnlyImpl(implSources, cand)) {
        if (!shallow.some((s) => s.toLowerCase() === cand.toLowerCase())) shallow.push(cand);
        continue;
      }
      if (
        required.length > 0 &&
        !assertedIn.some((tp) => hasBoundAssertion((testContents[tp] ?? ''), cand, required))
      ) {
        if (!unbound.some((s) => s.toLowerCase() === cand.toLowerCase())) unbound.push(cand);
        continue;
      }
      if (!emptySpecific && !assertedIn.some((tp) => callHasDistinguishingInput((testContents[tp] ?? ''), cand))) {
        if (!trivialOnly.some((s) => s.toLowerCase() === cand.toLowerCase())) trivialOnly.push(cand);
        continue;
      }
      return { covered: true, reason: `requirement "${requirement.id}" exercised: test ${assertedIn[0]} asserts ${cand}()` };
    }
    if (vacuous.length > 0) {
      return {
        covered: false,
        reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): implementation ${vacuous.join('/')}() ignores its inputs so a passing trivial-case assert proves nothing about the requirement (static heuristic, not a proof — a model reviewer would confirm) — fix the implementation to compute from its inputs`,
      };
    }
    if (shallow.length > 0) {
      return {
        covered: false,
        reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): implementation ${shallow.join('/')}() only measures input size (length/size/count) instead of computing the required behaviour — fix the implementation to compute from the input elements`,
      };
    }
    if (unbound.length > 0) {
      return {
        covered: false,
        reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): tests call ${unbound.join('/')}() but no assertion binds the call to required ${required.join('/')} — fix the tests to assert the implementation result for the required case`,
      };
    }
    if (trivialOnly.length > 0) {
      return {
        covered: false,
        reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): tests only assert ${trivialOnly.join('/')}() on a trivial (empty/zero) input, which cannot distinguish a correct implementation from a degenerate one — fix the tests to assert a distinguishing non-empty case`,
      };
    }
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no test asserts an implementation call — fix the tests to call the implementation and assert the expected behaviour${skipNote}`,
    };
  }

  // 2a. Code-ref requirements: symbol must be defined, then bound-asserted.
  const symbols = extractRequirementSymbols(requirement.description, requirement.testAnchors);
  if (symbols.length === 0) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no code symbol to link requirement to implementation`,
    };
  }
  const defined = findDefinedSymbols(implSources, symbols);
  if (defined.length === 0) {
    // Same barrel abstention as the NL branch, gated the same way: only
    // when an external decision participates; otherwise fail-closed.
    if (barrelWithNoVisibleCandidate) {
      if (opts?.allowBarrelAbstention !== true) {
        return {
          covered: false,
          reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): implementation not visible in scope (barrel re-export with no visible definition after chasing relative re-exports) and no external reviewer decision participates — fail-closed: the heuristic cannot examine what the tests execute`,
        };
      }
      return {
        covered: true,
        reason: `requirement "${requirement.id}" exercised via barrel re-export: no visible definition in scope after chasing relative re-exports — heuristic abstains (neutral), executable test passes and external reviewer decides`,
      };
    }
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): implementation does not define ${symbols.join('/')} — fix the implementation (changed files: ${implPool.join(', ') || 'none'})`,
    };
  }
  const required = extractRequiredLiterals(fullText);
  if (required.length === 0) {
    for (const sym of defined) {
      for (const tp of testPool) {
        if (hasAssertedCall((testContents[tp] ?? ''), sym)) {
          return { covered: true, reason: `requirement "${requirement.id}" exercised: test ${tp} asserts ${sym}()` };
        }
      }
    }
  } else {
    for (const sym of defined) {
      for (const tp of testPool) {
        if (hasBoundAssertion((testContents[tp] ?? ''), sym, required)) {
          return { covered: true, reason: `requirement "${requirement.id}" exercised: test ${tp} asserts ${sym}() with expected ${required.join('/')} ` };
        }
      }
    }
  }
  const anyCall = defined.some((sym) => testPool.some((tp) => testCallsSymbol((testContents[tp] ?? ''), sym)));
  if (anyCall) {
    return {
      covered: false,
      reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): tests call ${defined.join('/')}() but no assertion checks expected ${required.join('/')} — fix the tests to assert the implementation result for the required case${skipNote}`,
    };
  }
  const anchorHint = requirement.testAnchors.some((a) => testOutput.includes(a))
    ? ' (output mentions the anchor text but no test calls the implementation — title without coverage)'
    : '';
  return {
    covered: false,
    // Legacy phrase kept: downstream automation matches /do not cover requirement/.
    reason: `green tests do not cover requirement "${requirement.id}" (${requirement.description}): no test calls ${defined.join('/')}() — fix the tests to exercise the implementation${anchorHint}${skipNote}`,
  };
}

/**
 * P2: task tests named by the product (explicit testPaths, else test-like
 * files in scope). A global suite only satisfies an anchored per-file
 * command when the observed records prove THOSE tests ran — a runner lists
 * the files it executes; bare counts ("4 pass") and requirement names alone
 * never prove it.
 * P2-general: the file must be named in the product-OBSERVED output (runner
 * record) together with a runner pass signal — a filename appearing only as
 * text (requirement prose, or the command string echoing it without runner
 * results) never proves execution. Real `bun test` output always lists the
 * files it runs, so legitimate evidence keeps passing; anything weaker
 * stays fail-closed (see reviewJob).
 * shortcut: path/basename substring on observed records — upgrade if a runner stops listing files.
 */
function taskTestFiles(input: ReviewInput): string[] {
  const explicit = input.testPaths ?? [];
  const like = input.fileContents ? Object.keys(input.fileContents).filter(isTestPath) : [];
  return [...new Set([...explicit, ...like])];
}

/** True when the observed output records at least one task test file passing. */
function taskTestExecuted(input: ReviewInput): boolean {
  const files = taskTestFiles(input);
  if (files.length === 0) return false;
  const output = input.evidence?.output ?? '';
  if (!hasPassSignal(output)) return false;
  return files.some((f) => {
    if (output.includes(f)) return true;
    const base = f.split('/').pop() ?? '';
    return base.length >= 3 && output.includes(base);
  });
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

  if (!input.touchSet || input.touchSet.length === 0) {
    // No allow-all: a non-empty diff (guaranteed past the empty-diff check
    // above) without a declared scope fails — the job must declare which
    // files it may touch.
    reasons.push(
      'missing touchSet: non-empty diff declares no scope — declare the allowed scope in touchSet (empty touchSet never passes)',
    );
  } else {
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

  // External revisor (opencode) is enforced when present, and mandatory
  // under requireExternalSufficiency. Either way the local functional check
  // below still runs: pass needs both, fail needs only one (fail-closed).
  // G4 (L4): command-shape complaints from the external judge ("across N
  // files", "isolated", "command-specific", "anchored command") are OUT OF
  // SCOPE — execution is verified deterministically by the product (command
  // + exit 0 + output + commit), and a global suite run that includes the
  // task's tests satisfies it. Such complaints are discounted with an audit
  // note when the local functional coverage passes; functional complaints
  // (no call, no assertion, wrong result) still block. This separates what
  // is verifiable by rule from LLM judgment, so the final verdict is
  // auditable instead of depending on reviewer mood.
  const suf = input.sufficiency ?? null;
  let discountedCommandScope: string[] = [];
  if (suf && suf.reviewer === 'opencode') {
    if (suf.decision !== 'pass') {
      const { commandScope, functional } = partitionExternalReasons(suf.reasons ?? []);
      if (functional.length > 0) {
        reasons.push(
          `external functional review (opencode) did not pass: ${functional.join('; ') || 'no reason recorded'} — fail-closed`,
        );
        // Command-shape extras are context, not an independent veto.
        if (commandScope.length > 0) {
          discountedCommandScope = commandScope;
        }
      } else if (commandScope.length > 0) {
        // P2: defer ONLY with proof the task's tests executed in the
        // observed run — a global suite count never proves the anchored
        // scope ran. Without proof the external fail stands (fail-closed,
        // no discount, never a pass by name/count inference).
        if (taskTestExecuted(input)) {
          discountedCommandScope = commandScope;
        } else {
          reasons.push(
            `external functional review (opencode) did not pass: ${commandScope.join('; ') || 'no reason recorded'} — fail-closed (no proof the task tests executed: observed command/output do not list ${taskTestFiles(input).join(', ') || 'any task test file'})`,
          );
        }
      } else {
        reasons.push(
          `external functional review (opencode) did not pass: ${(suf.reasons ?? []).join('; ') || 'no reason recorded'} — fail-closed`,
        );
      }
    }
  } else if (input.requireExternalSufficiency) {
    reasons.push(
      'external functional review required (requireExternalSufficiency) but no opencode decision present — fail-closed: the local heuristic never decides alone',
    );
  }

  // R01 sufficiency: stdout anchor text NEVER decides pass. Each requirement
  // must be functionally exercised (test code calls the implementation).
  // gradedRequirements empty = manual-plan fallback (no criterion to judge).
  for (const req of input.requirements) {
    const assessment = assessFunctionalCoverage(req, input.fileContents, ev.output ?? '', {
      testPaths: input.testPaths,
      // Barrel abstention (no visible implementation in scope) is neutral
      // only when an external OpenCode decision participates — the strict
      // prod composition or an attached external verdict. Otherwise the
      // local heuristic fails closed instead of passing on a bare signal.
      allowBarrelAbstention:
        input.requireExternalSufficiency === true || input.sufficiency?.reviewer === 'opencode',
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

  const audit =
    discountedCommandScope.length > 0
      ? [
          `external command-scope complaint discounted (out of scope for external reviewer; execution verified deterministically by product): ${discountedCommandScope.join('; ').slice(0, 500)}`,
        ]
      : undefined;
  if (reasons.length > 0) {
    const failed = fail({ ...base, reasons });
    return audit ? { ...failed, audit } : failed;
  }
  const passed: ReviewVerdict = { ...base, verdict: 'pass', blocking: false, reasons: [] };
  return audit ? { ...passed, audit } : passed;
}

/**
 * An approval taken on oldBaseHead never auto-applies after the base
 * moves (merge or new main). True = must re-review.
 *
 * Same-commit comparison is prefix-bidirectional (same normalization as
 * merge-train isSameCommit, duplicated minimal): the same commit in
 * different formats (short prefix vs full 40-char SHA) is the SAME base,
 * never a move. Minimum 4 chars: git never resolves a shorter prefix.
 */
function isSameCommit(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 4) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export function needsReReview(approvedBaseHead: string, currentBaseHead: string): boolean {
  return !isSameCommit(approvedBaseHead, currentBaseHead);
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
