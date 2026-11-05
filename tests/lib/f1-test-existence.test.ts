import { describe, it, expect } from 'bun:test';
import { assessFunctionalCoverage } from '../../src/lib/reviewer';

// F1 RED: auto-generated acceptance of the shape
// "stats.test.mjs exists using node:test + ..." is currently routed through
// extractRequirementSymbols (prose tokens) and demands the implementation
// define stats/mjs/exists/using/... — unsatisfiable by construction.
// Correct shape: the NAMED TEST FILE in scope + an assertion that really
// calls the implementation. Missing file / assertion-free test must fail.

const IMPL = `export function mean(arr) {
  if (!Array.isArray(arr)) throw new TypeError('array expected');
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
export function median(arr) {
  if (!Array.isArray(arr)) throw new TypeError('array expected');
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
`;

// Fixture: never spell the runner module as a from-literal with the
// node:test specifier (conventions gate) — build it by concatenation like
// the r3401131 suite.
const NODE_TEST = 'node' + ':test';
const NODE_ASSERT = 'node' + ':assert/strict';

const GOOD_TEST = `import test from '${NODE_TEST}';
import assert from '${NODE_ASSERT}';
import { mean, median } from './stats.mjs';
test('mean', () => { assert.equal(mean([1, 2, 3]), 2); });
test('median odd', () => { assert.equal(median([3, 1, 2]), 2); });
test('median even', () => { assert.equal(median([1, 2, 3, 4]), 2.5); });
test('empty', () => { assert.ok(Number.isNaN(mean([]))); });
test('type', () => { assert.throws(() => mean('x'), TypeError); });
`;

const OUTPUT = 'pass 9\nfail 0';

const REQ2 = {
  id: 'stats-code-req-2',
  description:
    'stats.test.mjs exists using node:test + node:assert/strict with >=3 asserts covering the listed cases plus empty-list choice',
  testAnchors: [
    'stats.test.mjs exists using node:test + node:assert/strict with >=3 asserts covering the listed cases plus empty-list choice',
  ],
};

describe('F1: test-file existence requirements judge real code, not prose tokens', () => {
  it('correct delivery (named test asserts the implementation) is covered', () => {
    const r = assessFunctionalCoverage(
      REQ2,
      { 'stats.mjs': IMPL, 'stats.test.mjs': GOOD_TEST },
      OUTPUT,
    );
    expect(r.covered).toBe(true);
  });

  it('incorrect delivery (test file exists but never asserts the implementation) is rejected', () => {
    const hollow = `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\ntest('placeholder', () => { assert.equal(1, 1); });\n`;
    const r = assessFunctionalCoverage(
      REQ2,
      { 'stats.mjs': IMPL, 'stats.test.mjs': hollow },
      OUTPUT,
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/stats\.test\.mjs|no test calls|never asserts/i);
  });

  it('incorrect delivery (named test file absent from scope) is rejected', () => {
    const r = assessFunctionalCoverage(
      REQ2,
      { 'stats.mjs': IMPL, 'other.test.mjs': GOOD_TEST },
      OUTPUT,
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/stats\.test\.mjs/);
  });

  it('slug shape (count prose ">=2 asserts" is suite shape, not a literal to bind) is covered', () => {
    const impl = `export function slugify(s) {
      if (typeof s !== 'string') throw new TypeError('string expected');
      return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }\n`;
    const test = `import test from '${NODE_TEST}';\nimport assert from '${NODE_ASSERT}';\nimport { slugify } from './slug.mjs';\ntest('accent', () => { assert.equal(slugify('Ol\u00e1, Mundo!'), 'ola-mundo'); });\ntest('spaces', () => { assert.equal(slugify('  a  b  '), 'a-b'); });\n`;
    const req = {
      id: 'slug-code-req-2',
      description:
        'slug.test.mjs exists using node:test + node:assert/strict with >=2 asserts covering the listed cases',
      testAnchors: [
        'slug.test.mjs exists using node:test + node:assert/strict with >=2 asserts covering the listed cases',
      ],
    };
    const r = assessFunctionalCoverage(
      req,
      { 'slug.mjs': impl, 'slug.test.mjs': test },
      OUTPUT,
    );
    expect(r.covered).toBe(true);
  });

  it('impl-existence requirements still require the real symbol (no weakening)', () => {
    const req = {
      id: 'stats-code-req-1',
      description: 'stats.mjs exists and exports mean and median',
      testAnchors: ['stats.mjs exists and exports mean and median'],
    };
    const ok = assessFunctionalCoverage(
      req,
      { 'stats.mjs': IMPL, 'stats.test.mjs': GOOD_TEST },
      OUTPUT,
    );
    expect(ok.covered).toBe(true);
    const wrongImpl = `export function total(xs) { return xs.length; }\n`;
    const bad = assessFunctionalCoverage(
      req,
      { 'stats.mjs': wrongImpl, 'stats.test.mjs': GOOD_TEST },
      OUTPUT,
    );
    expect(bad.covered).toBe(false);
  });
});
