import { describe, it, expect } from 'bun:test';
import { reviewJob, type ReviewInput } from '../../src/lib/reviewer';
import { reviewFunctionallyViaOpenCode } from '../../src/lib/opencode-reviewer';

// R3401131: `export function total(xs){ return xs.length; }` + teste só-vazio
// passava no ramo NL 2b (hasAssertedCall bastava; isVacuousImpl só rejeita
// corpo que ignora params). Requisitos em prosa (sem refs de código) para
// exercitar o ramo NL; descrições carregam valores distintivos
// ("1 plus 2 gives 3") que o ramo NL agora também exige vinculados.
// Fixture: não soletrar o runner node:test como literal (conventions gate).
const NODE_TEST_SPEC = 'node' + ':test';

const SUM_REQ = {
  id: 'REQ-sum',
  description: 'sum numbers in a list where 1 plus 2 gives 3',
  testAnchors: ['sum numbers in a list where 1 plus 2 gives 3'],
};

function functionalInput(
  implFile: string,
  implContent: string,
  testContent: string,
  output: string,
  requirement = SUM_REQ,
): ReviewInput {
  return {
    jobName: 'total-job',
    jobBranch: 'feature-total',
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles: [implFile, 'total.test.mjs'],
    requirements: [requirement],
    fileContents: {
      [implFile]: implContent,
      'total.test.mjs': testContent,
    },
    testPaths: ['total.test.mjs'],
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

const WRONG_SUM = 'export function total(xs) { return xs.length; }\n';
const RIGHT_SUM = 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n';
const EMPTY_ONLY_TEST = `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('empty input', () => { assert.equal(total([]), 0); });\n`;
const SUM_TEST = `import { total } from './total.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('adds one and two', () => { assert.equal(total([1,2]), 3); });\n`;

describe('r3401131 functional gate (NL branch)', () => {
  it('(a) soma errada (xs.length) + teste só-vazio → FAIL', () => {
    const verdict = reviewJob(
      functionalInput('total.mjs', WRONG_SUM, EMPTY_ONLY_TEST, 'pass: empty input (1 passed)'),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join('\n')).toMatch(/REQ-sum/);
  });

  it('(b) soma correta + teste com [1,2]→3 → PASS', () => {
    const verdict = reviewJob(
      functionalInput('total.mjs', RIGHT_SUM, SUM_TEST, 'pass: adds one and two (1 passed)'),
    );
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
  });

  it('(c) domínio não-soma (reverse) com impl errada + teste vazio → FAIL', () => {
    const verdict = reviewJob(
      functionalInput(
        'reverse.mjs',
        'export function reverseList(xs) { return xs; }\n',
        `import { reverseList } from './reverse.mjs';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('empty input', () => { assert.deepEqual(reverseList([]), []); });\n`,
        'pass: empty input (1 passed)',
        { id: 'REQ-rev', description: 'reverse the order of a list', testAnchors: ['reverse the order of a list'] },
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/REQ-rev/);
  });

  it('(d) fix→re-review: corrige impl e teste → PASS', () => {
    const before = reviewJob(
      functionalInput('total.mjs', WRONG_SUM, EMPTY_ONLY_TEST, 'pass: empty input (1 passed)'),
    );
    expect(before.verdict).toBe('fail');
    const after = reviewJob(
      functionalInput('total.mjs', RIGHT_SUM, SUM_TEST, 'pass: adds one and two (1 passed)'),
    );
    expect(after.verdict).toBe('pass');
  });

  it('revisor externo indisponível → fail-closed (heurística local nunca passa sozinha por ele)', async () => {
    const results = await reviewFunctionallyViaOpenCode({
      requirements: [{ id: 'REQ-sum', description: SUM_REQ.description, anchors: SUM_REQ.testAnchors }],
      implFiles: { 'total.mjs': RIGHT_SUM },
      tests: { 'total.test.mjs': SUM_TEST },
      outputs: 'pass: adds one and two (1 passed)',
      bin: '/nonexistent/opencode-xyz-r3401131',
      timeoutMs: 5_000,
      model: 'test-pin-model-r3401131',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.verdict).toBe('fail');
    expect(results[0]!.reason).toMatch(/fail-closed|unavailable|indisponível/i);
  });

  it('modelo não pinado → fail-closed sem invocar binário (review model unpinned)', async () => {
    const prev = process.env.MC_REVIEW_MODEL;
    delete process.env.MC_REVIEW_MODEL;
    try {
      const results = await reviewFunctionallyViaOpenCode({
        requirements: [{ id: 'REQ-sum', description: SUM_REQ.description, anchors: SUM_REQ.testAnchors }],
        implFiles: { 'total.mjs': RIGHT_SUM },
        tests: { 'total.test.mjs': SUM_TEST },
        outputs: 'pass: adds one and two (1 passed)',
        bin: '/nonexistent/opencode-xyz-r3401131',
        timeoutMs: 5_000,
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('fail');
      expect(results[0]!.reason).toMatch(/review model unpinned/);
    } finally {
      if (prev !== undefined) process.env.MC_REVIEW_MODEL = prev;
    }
  });

  it('decisão externa opencode=fail bloqueia mesmo com cobertura local', () => {
    const verdict = reviewJob({
      ...functionalInput('total.mjs', RIGHT_SUM, SUM_TEST, 'pass: adds one and two (1 passed)'),
      sufficiency: { reviewer: 'opencode', decision: 'fail', reasons: ['external: sum not demonstrated'] },
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/opencode/i);
  });

  it('requireExternalSufficiency sem decisão externa → fail-closed', () => {
    const verdict = reviewJob({
      ...functionalInput('total.mjs', RIGHT_SUM, SUM_TEST, 'pass: adds one and two (1 passed)'),
      requireExternalSufficiency: true,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/fail-closed/i);
  });

  it('proteção de inputs integrada ao gate (protectInputsDuringRun via scope do reviewer)', async () => {
    const { protectInputsDuringRun } = await import('../../src/lib/candidate-identity');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mc-review-protect-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'total.mjs'), RIGHT_SUM);
      const r = await protectInputsDuringRun({ dir, scopePaths: ['total.mjs'], runFn: async () => {} });
      expect(r.verdict).toBe('pass');
      expect(r.protectedPaths).toContain('total.mjs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
