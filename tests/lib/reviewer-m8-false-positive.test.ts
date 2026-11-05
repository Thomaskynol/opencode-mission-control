import { describe, it, expect } from 'bun:test';
import { assessFunctionalCoverage, reviewJob } from '../../src/lib/reviewer';

// M8 false positives: general causes, not wording.
// (a) "exit 0" is runner exit code, never a domain literal to bind.
// (b) docs paths (*.md) embed in a prose anchor — the embedded path decides,
//     never the whole sentence.

// Never spell the runner specifier as a from-literal (conventions gate).
const NODE_TEST = 'node' + ':test';
const NODE_ASSERT = 'node' + ':assert/strict';

const SLUG_IMPL = `export function slugify(s) {
  if (typeof s !== 'string') throw new TypeError('string expected');
  return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}\n`;
// Correct delivery: two distinguishing asserts, no "0" literal anywhere.
const SLUG_TEST_N0 = `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { slugify } from './slug.mjs';\ntest('accent', () => { assert.equal(slugify('Ol\u00e1, Mundo!'), 'ola-mundo'); });\ntest('spaces', () => { assert.equal(slugify('  a  b  '), 'a-b'); });\n`;

// M8 shape: count prose ("3 asserts") + runner exit phrase. Behavioural path
// (no sym(, no ===, no quoted literal, no code-adjacent digit).
const SLUG_REQ_EXIT = {
  id: 'slug-code-req-2',
  description:
    'slug.test.mjs exists using node:test with 3 asserts covering the listed cases, exit 0',
  testAnchors: [
    'slug.test.mjs exists using node:test with 3 asserts covering the listed cases, exit 0',
  ],
};

const OUT = 'pass 9\nfail 0';

describe('M8 (a): runner exit code is not a required literal', () => {
  it('correct slug without "0" passes (exit 0 stripped, suite shape stripped)', () => {
    const r = assessFunctionalCoverage(
      SLUG_REQ_EXIT,
      { 'slug.mjs': SLUG_IMPL, 'slug.test.mjs': SLUG_TEST_N0 },
      OUT,
    );
    expect(r.covered).toBe(true);
  });

  it('correct slug passes via public reviewJob path', () => {
    const v = reviewJob({
      jobName: 'slug-job',
      jobBranch: 'feat-slug',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['slug.mjs', 'slug.test.mjs'],
      touchSet: ['slug.mjs', 'slug.test.mjs'],
      requirements: [SLUG_REQ_EXIT],
      fileContents: { 'slug.mjs': SLUG_IMPL, 'slug.test.mjs': SLUG_TEST_N0 },
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: accent (2 passed)\nfail 0',
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
      },
      claimedPass: true,
    });
    expect(v.verdict).toBe('pass');
  });

  it('"exit code 0" variant also passes (general exit-phrase, not wording)', () => {
    const req = {
      id: 'slug-code-req-2',
      description:
        'slug.test.mjs exists using node:test with 3 asserts covering the listed cases, exit code 0',
      testAnchors: [
        'slug.test.mjs exists using node:test with 3 asserts covering the listed cases, exit code 0',
      ],
    };
    const r = assessFunctionalCoverage(
      req,
      { 'slug.mjs': SLUG_IMPL, 'slug.test.mjs': SLUG_TEST_N0 },
      OUT,
    );
    expect(r.covered).toBe(true);
  });

  it('incomplete delivery (test never asserts the impl) still fails', () => {
    const hollow = `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\ntest('placeholder', () => { assert.equal(1, 1); });\n`;
    const r = assessFunctionalCoverage(
      SLUG_REQ_EXIT,
      { 'slug.mjs': SLUG_IMPL, 'slug.test.mjs': hollow },
      OUT,
    );
    expect(r.covered).toBe(false);
  });

  it('real literals still bind (total([1,2])===3 with wrong value fails)', () => {
    const r = assessFunctionalCoverage(
      { id: 'x', description: 'total([1,2])===3', testAnchors: ['total([1,2])===3'] },
      {
        'total.mjs': 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n',
        'total.test.mjs': `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { total } from './total.mjs';\ntest('x', () => assert.equal(total([1,2]), 999));\n`,
      },
      'pass: x (1 passed)',
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/3/);
  });

  it('quoted "exit 0" as expected value still binds (no weakening)', () => {
    const req = {
      id: 'y',
      description: 'greet() returns "exit 0" exactly',
      testAnchors: ['greet() returns "exit 0" exactly'],
    };
    const wrong = assessFunctionalCoverage(
      req,
      {
        'greet.mjs': 'export function greet() { return "exit 0"; }\n',
        'greet.test.mjs': `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { greet } from './greet.mjs';\ntest('y', () => assert.equal(greet(), "wrong"));\n`,
      },
      'pass: y (1 passed)',
    );
    expect(wrong.covered).toBe(false);
    const right = assessFunctionalCoverage(
      req,
      {
        'greet.mjs': 'export function greet() { return "exit 0"; }\n',
        'greet.test.mjs': `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { greet } from './greet.mjs';\ntest('y', () => assert.equal(greet(), "exit 0"));\n`,
      },
      'pass: y (1 passed)',
    );
    expect(right.covered).toBe(true);
  });
});

describe('M8 (b): docs path embeds in a prose anchor', () => {
  const INDEX_REQ = {
    id: 'index-docs-req-1',
    description: 'docs/index.md exists with stamp BK-M8',
    testAnchors: ['docs/index.md exists with stamp BK-M8'],
  };
  const INDEX_DOC = '# index\n\nStamp: BK-M8\n\nDocuments the index behavior.\n';
  const CODE_IMPL = 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n';
  const CODE_TEST = `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { total } from './total.mjs';\ntest('adds', () => { assert.equal(total([1,2]), 3); });\n`;
  const PASS_OUT = 'pass: adds (1 passed)';

  it('correct docs/index.md in scope passes (embedded path resolves, bound assert decides)', () => {
    const r = assessFunctionalCoverage(
      INDEX_REQ,
      { 'docs/index.md': INDEX_DOC, 'total.mjs': CODE_IMPL, 'total.test.mjs': CODE_TEST },
      PASS_OUT,
    );
    expect(r.covered).toBe(true);
  });

  it('correct docs/index.md passes via public reviewJob path', () => {
    const v = reviewJob({
      jobName: 'index-job',
      jobBranch: 'feat-index',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['docs/index.md', 'total.mjs', 'total.test.mjs'],
      touchSet: ['docs/**', 'total.mjs', 'total.test.mjs'],
      requirements: [INDEX_REQ],
      fileContents: { 'docs/index.md': INDEX_DOC, 'total.mjs': CODE_IMPL, 'total.test.mjs': CODE_TEST },
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: PASS_OUT,
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
      },
      claimedPass: true,
    });
    expect(v.verdict).toBe('pass');
  });

  it('missing docs/index.md still fails closed (scope, no weakening)', () => {
    const r = assessFunctionalCoverage(
      INDEX_REQ,
      { 'total.mjs': CODE_IMPL, 'total.test.mjs': CODE_TEST },
      PASS_OUT,
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/not in scope|scope/i);
  });

  it('assertion-free test still fails (scope alone never passes)', () => {
    const hollow = `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\ntest('placeholder', () => { assert.equal(1, 1); });\n`;
    const r = assessFunctionalCoverage(
      INDEX_REQ,
      { 'docs/index.md': INDEX_DOC, 'total.mjs': CODE_IMPL, 'total.test.mjs': hollow },
      PASS_OUT,
    );
    expect(r.covered).toBe(false);
  });

  it('wrong content (call without bound literal) still fails', () => {
    const req = { id: 'x', description: 'total([1,2])===3', testAnchors: ['total([1,2])===3'] };
    const r = assessFunctionalCoverage(
      req,
      {
        'total.mjs': CODE_IMPL,
        'total.test.mjs': `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { total } from './total.mjs';\ntest('x', () => { total([1,2]); assert.equal(1, 1); });\n`,
      },
      'pass: x (1 passed)',
    );
    expect(r.covered).toBe(false);
  });
});
