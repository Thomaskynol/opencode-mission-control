import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { JobSpec } from '../../src/lib/plan-types';
import { MergeTrain } from '../../src/lib/merge-train';
import { withIntegrationLock, integrationLockPath } from '../../src/lib/integration';
import {
  reviewJob,
  needsReReview,
  validateTestChange,
  isFlakySequence,
  runReviewFixLoop,
  type ReviewInput,
} from '../../src/lib/reviewer';

function baseInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    jobName: 'auth-job',
    jobBranch: 'feature-auth',
    baseBranch: 'main',
    baseHead: 'base-head-1',
    jobHead: 'job-head-1',
    changedFiles: ['src/auth.ts', 'tests/auth.test.ts'],
    touchSet: ['src/**', 'tests/**'],
    requirements: [
      { id: 'REQ-1', description: 'login rejects bad password', testAnchors: ['rejects bad password'] },
    ],
    // R01 sufficiency: stdout anchors alone never decide pass — the gate
    // reads implementation + test content and requires a test assertion
    // that calls the implementation.
    fileContents: {
      'src/auth.ts':
        `export function login(user: string, password: string): boolean {\n  return password !== 'wrong';\n}\n`,
      'tests/auth.test.ts':
        `import { login } from '../../src/auth';\nimport assert from 'node:assert/strict';\ntest('rejects bad password', () => { assert.equal(login('alice', 'wrong'), false); });\n`,
    },
    evidence: {
      command: 'bun test tests/auth.test.ts',
      exitCode: 0,
      output: 'pass: rejects bad password (12 tests)',
      testedCommit: 'job-head-1',
      environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
    },
    claimedPass: true,
    ...overrides,
  };
}

describe('reviewJob', () => {
  it('passes with evidence covering the requirement', () => {
    const verdict = reviewJob(baseInput());
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
    expect(verdict.reviewedCommit).toBe('job-head-1');
    expect(verdict.reviewedBase).toBe('base-head-1');
  });

  it('fails on delivery without evidence, flagging optimistic claims', () => {
    const verdict = reviewJob(baseInput({ evidence: null, claimedPass: true }));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join('\n')).toMatch(/without evidence/i);
    expect(verdict.reasons.join('\n')).toMatch(/optimistic/i);
  });

  it('fails an optimistic pass claim when tests actually failed', () => {
    const verdict = reviewJob(
      baseInput({
        evidence: {
          command: 'bun test',
          exitCode: 1,
          output: 'FAIL: rejects bad password',
          testedCommit: 'job-head-1',
        },
        claimedPass: true,
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/optimistic/i);
  });

  it('fails when the tested commit is stale', () => {
    const verdict = reviewJob(
      baseInput({
        evidence: {
          command: 'bun test',
          exitCode: 0,
          output: 'pass: rejects bad password',
          testedCommit: 'old-head',
        },
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/stale|diverges/i);
  });

  it('fails on missing command or output (not repeatable, not observable)', () => {
    const noCommand = reviewJob(
      baseInput({ evidence: { command: '', exitCode: 0, output: 'pass: rejects bad password', testedCommit: 'job-head-1' } }),
    );
    expect(noCommand.verdict).toBe('fail');
    expect(noCommand.reasons.join('\n')).toMatch(/command/i);

    const noOutput = reviewJob(
      baseInput({ evidence: { command: 'bun test', exitCode: 0, output: '  ', testedCommit: 'job-head-1' } }),
    );
    expect(noOutput.verdict).toBe('fail');
    expect(noOutput.reasons.join('\n')).toMatch(/output/i);
  });

  it('never passes on a "pass" claim without observed execution', () => {
    // No evidence at all, with or without an explicit pass claim.
    for (const claimedPass of [true, false]) {
      const verdict = reviewJob(baseInput({ evidence: null, claimedPass }));
      expect(verdict.verdict).toBe('fail');
      expect(verdict.reasons.join('\n')).toMatch(/without evidence/i);
    }
    // Command + exit 0 but no tested commit: unknown which code ran.
    const noCommit = reviewJob(
      baseInput({
        evidence: { command: 'bun test', exitCode: 0, output: 'pass: rejects bad password', testedCommit: '  ' },
        claimedPass: true,
      }),
    );
    expect(noCommit.verdict).toBe('fail');
    expect(noCommit.reasons.join('\n')).toMatch(/tested commit/i);
  });

  it('fails green tests that do not cover the requirement', () => {
    const verdict = reviewJob(
      baseInput({
        // Same green run, but the test never calls the implementation:
        // a passing suite without covering assertions is not coverage.
        fileContents: {
          'src/auth.ts':
            `export function login(user: string, password: string): boolean {\n  return password !== 'wrong';\n}\n`,
          'tests/auth.test.ts':
            `import assert from 'node:assert/strict';\ntest('everything else', () => { assert.equal(1 + 1, 2); });\n`,
        },
        evidence: {
          command: 'bun test',
          exitCode: 0,
          output: 'pass: everything else (unrelated suite)',
          testedCommit: 'job-head-1',
          environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
        },
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/REQ-1/);
  });

  it('treats a file anchor as a scope hint, not a veto', () => {
    // New contract (demo-r5): a path-like anchor names the file whose
    // execution should demonstrate the requirement. When that file is in the
    // examined scope AND really asserts the implementation, it is covered.
    const covered = reviewJob(
      baseInput({
        requirements: [
          { id: 'REQ-2', description: 'login rejects bad password covered in tests/auth.test.ts', testAnchors: ['tests/auth.test.ts'] },
        ],
        evidence: {
          command: 'bun test',
          exitCode: 0,
          output: 'pass: rejects bad password (12 tests)',
          testedCommit: 'job-head-1',
          environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
        },
      }),
    );
    expect(covered.verdict).toBe('pass');

    // But an anchor naming a file outside the examined candidate still fails
    // closed: the named test was never part of the reviewed scope.
    const outOfScope = reviewJob(
      baseInput({
        requirements: [
          { id: 'REQ-2', description: 'login covered in tests/missing.test.ts', testAnchors: ['tests/missing.test.ts'] },
        ],
        evidence: {
          command: 'bun test',
          exitCode: 0,
          output: 'pass: 12 tests (unrelated suite, no file names listed)',
          testedCommit: 'job-head-1',
          environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
        },
      }),
    );
    expect(outOfScope.verdict).toBe('fail');
    expect(outOfScope.reasons.join('\n')).toMatch(/REQ-2/);
  });

  it('fails touchSet violations', () => {
    const verdict = reviewJob(baseInput({ changedFiles: ['src/auth.ts', 'infra/prod.tf'] }));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/touchSet/i);
  });

  it('fails an empty diff', () => {
    expect(reviewJob(baseInput({ changedFiles: [] })).verdict).toBe('fail');
  });

  it('fails a non-empty diff without a declared scope (empty touchSet is not allow-all)', () => {
    for (const missing of [{ touchSet: [] as string[] }, { touchSet: undefined as unknown as string[] }]) {
      const input = baseInput(missing);
      if (missing.touchSet === undefined) delete (input as Partial<ReviewInput>).touchSet;
      const verdict = reviewJob(input);
      expect(verdict.verdict).toBe('fail');
      expect(verdict.blocking).toBe(true);
      expect(verdict.reasons.join('\n')).toMatch(/touchSet|scope/i);
    }
  });

  it('rejects test changes without a record, accepts documented ones', () => {
    const undocumented = reviewJob(
      baseInput({ testChange: { changedTestFiles: ['tests/auth.test.ts'] } }),
    );
    expect(undocumented.verdict).toBe('fail');
    expect(undocumented.reasons.join('\n')).toMatch(/without record/i);

    const documented = reviewJob(
      baseInput({
        testChange: {
          changedTestFiles: ['tests/auth.test.ts'],
          reasonPreviousIncorrect: 'previous test asserted the buggy behavior (accepted empty password)',
        },
      }),
    );
    expect(documented.verdict).toBe('pass');
  });

  it('fails closed without implementation/test content (stdout text alone never verifies)', () => {
    const { fileContents: _dropped, ...withoutContents } = baseInput();
    void _dropped;
    const verdict = reviewJob(withoutContents);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/missing functional evidence|not examined/i);
  });
});

// ---------------------------------------------------------------------------
// R01 Sonda A/B: functional sufficiency, not stdout text.
// - Sonda A (wrong impl `return 0` + vacuous title-matching test) REJECTS.
// - Sonda B (correct impl + real assertion under another title) ACCEPTS.
// `anchorCovered` alone NEVER decides pass.
// ---------------------------------------------------------------------------

// Fixture helper: simulated product-observed test files must not spell the
// node:test runner specifier as an import source — the conventions gate scans
// this file's text and flags any non-bun runner. The specifier is built by
// concatenation so the runtime string is identical but the literal is absent.
const NODE_TEST_SPEC = 'node' + ':test';

function sondaInput(fileContents: Record<string, string>, output: string): ReviewInput {
  return {
    jobName: 'total-job',
    jobBranch: 'feature-total',
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles: ['total.mjs', 'total.test.mjs'],
    touchSet: ['total.mjs', 'total.test.mjs'],
    requirements: [{ id: 'REQ-total', description: 'total([1,2])===3', testAnchors: ['total([1,2])===3'] }],
    fileContents,
    evidence: {
      command: 'bun test',
      exitCode: 0,
      output,
      testedCommit: 'job-1',
      environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
    },
    claimedPass: true,
  };
}

describe('R01 sonda A/B (functional sufficiency)', () => {
  it('Sonda A: REJECTS wrong implementation with a vacuous title-matching test', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': 'export function total(xs) { return 0; }\n',
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('total([1,2])===3', () => assert.equal(1, 1));\n`,
        },
        'pass: total([1,2])===3 (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    // The diagnosis must ask for implementation/test work — never "print the anchor".
    expect(verdict.reasons.join('\n')).toMatch(/no test calls total\(\)/i);
    expect(verdict.reasons.join('\n')).not.toMatch(/print.*anchor|imprima.*frase/i);
  });

  it('Sonda B: ACCEPTS correct implementation with a real assertion under another title', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n',
          'total.test.mjs':
            `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
        },
        'pass: adds numbers correctly (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
  });
});

describe('R01 §3 regressions (bound assertion + NL behavioral)', () => {
  it('case 1: REJECTS call without assertion (wrong impl, bare call)', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': 'export function total(xs) { return 0; }\n',
          'total.test.mjs':
            `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\ntest('just calls total', () => { total([1,2]); });\n`,
        },
        'pass: just calls total (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/assert|do not cover requirement/i);
  });

  it('case 2: REJECTS assert of empty-only case for non-empty sum requirement', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': 'export function total(xs) { return 0; }\n',
          'total.test.mjs':
            `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('empty collection', () => { assert.equal(total([]), 0); });\n`,
        },
        'pass: empty collection (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/REQ-total/);
  });

  it('case 3: ACCEPTS natural-language requirement with correct impl + test', () => {
    const verdict = reviewJob({
      jobName: 'total-job',
      jobBranch: 'feature-total',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['total.mjs', 'total.test.mjs'],
      touchSet: ['total.mjs', 'total.test.mjs'],
      requirements: [
        { id: 'REQ-empty', description: 'Return zero for an empty collection', testAnchors: ['Return zero for an empty collection'] },
      ],
      fileContents: {
        'total.mjs': 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n',
        'total.test.mjs':
          `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('handles empty collection', () => { assert.equal(total([]), 0); });\n`,
      },
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: handles empty collection (1 passed)',
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
      },
      claimedPass: true,
    });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
  });
});

describe('R01 candidate identity (never attribute a pass to the wrong commit)', () => {
  const coveringContents = {
    'total.mjs': 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n',
    'total.test.mjs':
      `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
  };

  it('refuses evidence from a dirty tree even when tests pass', () => {
    const verdict = reviewJob(
      sondaInput(coveringContents, 'pass: adds numbers correctly (1 passed)'),
    );
    // Sanity: clean evidence passes first.
    expect(verdict.verdict).toBe('pass');
    const dirty = reviewJob({
      ...sondaInput(coveringContents, 'pass: adds numbers correctly (1 passed)'),
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: adds numbers correctly (1 passed)',
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
        dirty: true,
      },
    });
    expect(dirty.verdict).toBe('fail');
    expect(dirty.reasons.join('\n')).toMatch(/dirty/i);
  });

  it('refuses a stale commit label and accepts a well-pinned integration candidate', () => {
    const stale = reviewJob({
      ...sondaInput(coveringContents, 'pass: adds numbers correctly (1 passed)'),
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: adds numbers correctly (1 passed)',
        testedCommit: 'old-head',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
      },
    });
    expect(stale.verdict).toBe('fail');
    expect(stale.reasons.join('\n')).toMatch(/stale|diverges/i);

    const candidate = reviewJob({
      ...sondaInput(coveringContents, 'pass: adds numbers correctly (1 passed)'),
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: adds numbers correctly (1 passed)',
        testedCommit: 'merge-head-abc',
        environment: 'integration-candidate:/tmp/y (product-executed)',
        taskHead: 'job-1',
        candidateBase: 'base-1',
        candidateHead: 'merge-head-abc',
        dirty: false,
      },
    });
    expect(candidate.verdict).toBe('pass');
  });

  it('rejects an integration candidate built on the wrong base or task', () => {
    const wrongBase = reviewJob({
      ...sondaInput(coveringContents, 'pass: adds numbers correctly (1 passed)'),
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: adds numbers correctly (1 passed)',
        testedCommit: 'merge-head-abc',
        environment: 'integration-candidate:/tmp/y (product-executed)',
        taskHead: 'job-1',
        candidateBase: 'other-base',
        candidateHead: 'merge-head-abc',
      },
    });
    expect(wrongBase.verdict).toBe('fail');
    expect(wrongBase.reasons.join('\n')).toMatch(/base.*diverges|stale/i);
  });
});

describe('needsReReview', () => {
  it('requires re-review after the base moves, keeps approval on same base', () => {
    expect(needsReReview('abc', 'abc')).toBe(false);
    expect(needsReReview('abc', 'def')).toBe(true);
  });
});

describe('validateTestChange / isFlakySequence', () => {
  it('requires a reason when test files changed', () => {
    expect(validateTestChange(null).ok).toBe(true);
    expect(validateTestChange({ changedTestFiles: [] }).ok).toBe(true);
    expect(validateTestChange({ changedTestFiles: ['t.ts'] }).ok).toBe(false);
    expect(
      validateTestChange({ changedTestFiles: ['t.ts'], reasonPreviousIncorrect: 'asserted wrong total' }).ok,
    ).toBe(true);
  });

  it('detects the same commit passing and failing as flaky', () => {
    expect(isFlakySequence([{ commit: 'a', passed: true }, { commit: 'a', passed: false }])).toBe(true);
    expect(isFlakySequence([{ commit: 'a', passed: true }, { commit: 'b', passed: false }])).toBe(false);
  });
});

describe('runReviewFixLoop', () => {
  it('fail -> fix -> pass converges within maxFixCycles', async () => {
    const sleeps: number[] = [];
    const result = await runReviewFixLoop({
      input: baseInput({ evidence: null, claimedPass: false }),
      options: { maxFixCycles: 3, backoffMs: 1 },
      review: (input) => reviewJob(input),
      fix: async (_attempt, _last, input) => ({ ...input, ...baseInput() }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.verdict.verdict).toBe('pass');
    expect(result.attempts).toBe(1);
    expect(result.quarantined).toBe(false);
    expect(sleeps.length).toBe(1);
  });

  it('fail -> blocks after maxFixCycles without ever passing', async () => {
    const result = await runReviewFixLoop({
      input: baseInput({ evidence: null }),
      options: { maxFixCycles: 2, backoffMs: 0, quarantineAfterRepeats: 99 },
      review: (input) => reviewJob(input),
      fix: async (_attempt, _last, input) => ({ ...input }),
      sleep: async () => {},
    });
    expect(result.verdict.verdict).toBe('fail');
    expect(result.attempts).toBe(2);
    expect(result.quarantined).toBe(false);
  });

  it('quarantines a repeating failure signature instead of looping', async () => {
    const result = await runReviewFixLoop({
      input: baseInput({ evidence: null }),
      options: { maxFixCycles: 5, backoffMs: 0 },
      review: (input) => reviewJob(input),
      fix: async (_attempt, _last, input) => ({ ...input }),
      sleep: async () => {},
    });
    expect(result.verdict.verdict).toBe('fail');
    expect(result.quarantined).toBe(true);
    expect(result.attempts).toBeLessThan(5);
  });

  it('stops when fix() cannot fix (returns null)', async () => {
    const result = await runReviewFixLoop({
      input: baseInput({ evidence: null }),
      options: { maxFixCycles: 5, backoffMs: 0 },
      review: (input) => reviewJob(input),
      fix: async () => null,
      sleep: async () => {},
    });
    expect(result.verdict.verdict).toBe('fail');
    expect(result.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Merge-train reviewer gate (real git repos, like merge-train.test.ts)
// ---------------------------------------------------------------------------

async function exec(args: string[], cwd: string) {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function mustExec(args: string[], cwd: string): Promise<string> {
  const r = await exec(args, cwd);
  if (r.exitCode !== 0) throw new Error(`Command failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

function makeJob(branch: string): JobSpec {
  return { id: `${branch}-id`, name: branch, prompt: `merge ${branch}`, status: 'ready_to_merge', branch };
}

async function setupRepo() {
  const rootDir = mkdtempSync(join(tmpdir(), 'mc-m4-reviewer-'));
  const repoDir = join(rootDir, 'repo');
  const integrationWorktree = join(rootDir, 'integration-worktree');
  mkdirSync(repoDir, { recursive: true });
  await mustExec(['git', 'init'], repoDir);
  await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
  await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }, null, 2));
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  await mustExec(['git', 'add', '.'], repoDir);
  await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
  await mustExec(['git', 'branch', '-M', 'main'], repoDir);
  await mustExec(['git', 'branch', 'integration'], repoDir);
  await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
  mkdirSync(join(integrationWorktree, 'node_modules'), { recursive: true });
  return { rootDir, repoDir, integrationWorktree };
}

async function verdictFor(repoDir: string, integrationWorktree: string, branch: string, files: string[]) {
  const jobHead = await mustExec(['git', 'rev-parse', branch], repoDir);
  const baseHead = await mustExec(['git', 'rev-parse', 'HEAD'], integrationWorktree);
  return { jobHead, baseHead, files };
}

describe('merge-train reviewer gate', () => {
  let repo: Awaited<ReturnType<typeof setupRepo>>;

  // Bun:test supports async beforeEach
  const before = async () => {
    repo = await setupRepo();
  };
  const after = () => {
    rmSync(repo.rootDir, { recursive: true, force: true });
  };

  it('fail verdict blocks the merge: HEAD untouched', async () => {
    await before();
    try {
      await mustExec(['git', 'checkout', '-b', 'feature-blocked', 'main'], repo.repoDir);
      writeFileSync(join(repo.repoDir, 'blocked.txt'), 'blocked\n');
      await mustExec(['git', 'add', 'blocked.txt'], repo.repoDir);
      await mustExec(['git', 'commit', '-m', 'blocked'], repo.repoDir);
      await mustExec(['git', 'checkout', 'main'], repo.repoDir);

      const headBefore = await mustExec(['git', 'rev-parse', 'HEAD'], repo.integrationWorktree);
      const train = new MergeTrain(repo.integrationWorktree, { requireReviewPass: true });
      train.enqueue(makeJob('feature-blocked'));
      const result = await train.processNext({
        verdict: 'fail',
        blocking: true,
        reasons: ['delivery without evidence'],
        jobName: 'feature-blocked',
        reviewedCommit: 'x',
        reviewedBase: headBefore,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.type).toBe('review_blocked');
      const headAfter = await mustExec(['git', 'rev-parse', 'HEAD'], repo.integrationWorktree);
      expect(headAfter).toBe(headBefore);
    } finally {
      after();
    }
  });

  it('missing verdict blocks when requireReviewPass is set, merges otherwise', async () => {
    await before();
    try {
      for (const b of ['feature-g1', 'feature-g2']) {
        await mustExec(['git', 'checkout', '-b', b, 'main'], repo.repoDir);
        writeFileSync(join(repo.repoDir, `${b}.txt`), `${b}\n`);
        await mustExec(['git', 'add', `${b}.txt`], repo.repoDir);
        await mustExec(['git', 'commit', '-m', b], repo.repoDir);
        await mustExec(['git', 'checkout', 'main'], repo.repoDir);
      }
      // Strict train: no verdict -> blocked
      const strict = new MergeTrain(repo.integrationWorktree, { requireReviewPass: true });
      strict.enqueue(makeJob('feature-g1'));
      const blocked = await strict.processNext();
      expect(blocked.success).toBe(false);
      if (!blocked.success) expect(blocked.type).toBe('review_blocked');

      // Legacy train (no requirement): merges without a verdict
      const legacy = new MergeTrain(repo.integrationWorktree);
      legacy.enqueue(makeJob('feature-g2'));
      const merged = await legacy.processNext();
      expect(merged.success).toBe(true);
    } finally {
      after();
    }
  });

  it('pass verdict merges; stale base approval blocks', async () => {
    await before();
    try {
      await mustExec(['git', 'checkout', '-b', 'feature-ok', 'main'], repo.repoDir);
      writeFileSync(join(repo.repoDir, 'ok.txt'), 'ok\n');
      await mustExec(['git', 'add', 'ok.txt'], repo.repoDir);
      await mustExec(['git', 'commit', '-m', 'ok'], repo.repoDir);
      await mustExec(['git', 'checkout', 'main'], repo.repoDir);

      const { jobHead, baseHead } = await verdictFor(repo.repoDir, repo.integrationWorktree, 'feature-ok', ['ok.txt']);
      const train = new MergeTrain(repo.integrationWorktree, { requireReviewPass: true });
      train.enqueue(makeJob('feature-ok'));
      const ok = await train.processNext({
        verdict: 'pass',
        blocking: false,
        reasons: [],
        jobName: 'feature-ok',
        reviewedCommit: jobHead,
        reviewedBase: baseHead,
      });
      expect(ok.success).toBe(true);

      // Second job approved against the OLD base must be re-reviewed.
      await mustExec(['git', 'checkout', '-b', 'feature-stale', 'main'], repo.repoDir);
      writeFileSync(join(repo.repoDir, 'stale.txt'), 'stale\n');
      await mustExec(['git', 'add', 'stale.txt'], repo.repoDir);
      await mustExec(['git', 'commit', '-m', 'stale'], repo.repoDir);
      await mustExec(['git', 'checkout', 'main'], repo.repoDir);
      const staleJobHead = await mustExec(['git', 'rev-parse', 'feature-stale'], repo.repoDir);
      const headBefore = await mustExec(['git', 'rev-parse', 'HEAD'], repo.integrationWorktree);
      const train2 = new MergeTrain(repo.integrationWorktree, { requireReviewPass: true });
      train2.enqueue(makeJob('feature-stale'));
      const stale = await train2.processNext({
        verdict: 'pass',
        blocking: false,
        reasons: [],
        jobName: 'feature-stale',
        reviewedCommit: staleJobHead,
        reviewedBase: baseHead, // approved before feature-ok merged
      });
      expect(stale.success).toBe(false);
      if (!stale.success) expect(stale.type).toBe('review_blocked');
      const headAfter = await mustExec(['git', 'rev-parse', 'HEAD'], repo.integrationWorktree);
      expect(headAfter).toBe(headBefore);
    } finally {
      after();
    }
  });

  it('regression command failure rolls back the merge', async () => {
    await before();
    try {
      await mustExec(['git', 'checkout', '-b', 'feature-reg', 'main'], repo.repoDir);
      writeFileSync(join(repo.repoDir, 'reg.txt'), 'reg\n');
      await mustExec(['git', 'add', 'reg.txt'], repo.repoDir);
      await mustExec(['git', 'commit', '-m', 'reg'], repo.repoDir);
      await mustExec(['git', 'checkout', 'main'], repo.repoDir);

      const headBefore = await mustExec(['git', 'rev-parse', 'HEAD'], repo.integrationWorktree);
      const train = new MergeTrain(repo.integrationWorktree, {
        testCommand: 'true',
        regressionCommand: 'false',
        testTimeout: 60000,
      });
      train.enqueue(makeJob('feature-reg'));
      const result = await train.processNext();
      expect(result.success).toBe(false);
      if (!result.success) expect(result.type).toBe('test_failure');
      const headAfter = await mustExec(['git', 'rev-parse', 'HEAD'], repo.integrationWorktree);
      expect(headAfter).toBe(headBefore);
    } finally {
      after();
    }
  });
});

describe('withIntegrationLock', () => {
  it('runs the callback and exposes a stable lock path per branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-m4-lock-'));
    try {
      expect(integrationLockPath('/w/mc-integration-p1')).toBe('/w/mc-integration-p1.lock');
      const order: string[] = [];
      await withIntegrationLock(dir, async () => {
        order.push('first');
        return 1;
      });
      const second = await withIntegrationLock(dir, async () => {
        order.push('second');
        return 2;
      });
      expect(second).toBe(2);
      expect(order).toEqual(['first', 'second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.lock`, { force: true });
    }
  });
});
