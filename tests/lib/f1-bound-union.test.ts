import { describe, it, expect } from 'bun:test';
import { assessFunctionalCoverage } from '../../src/lib/reviewer';

// M6 follow-up: `hasBoundAssertion` required ALL required literals inside a
// SINGLE assert snippet — impossible when correct cases live in separate
// asserts (mean([1,2,3])→2 and mean([2,4])→3). Correct k1 was rejected 2×
// and the mission stalled. Bound literals must be satisfied by the UNION of
// the named test file's assert snippets (each literal inside SOME assert
// that calls the implementation), while files with no asserts — or asserts
// that never touch the literals — still fail.

// Fixtures are the exact contents of the real M6 artifacts
// (mean.mjs + mean.test.mjs from the M6 k1 worktree, 3 pass / 0 fail
// independently), inlined here so the test runs on any machine with
// zero external-artifact dependency.
// Fixture: never spell the runner module as a from-literal with the
// node:test specifier (conventions gate) — build it by concatenation.
const NODE_TEST = 'node' + ':test';
const NODE_ASSERT = 'node' + ':assert/strict';

const MEAN_IMPL = `export function mean(list) {
  // Empty list returns NaN (mean is undefined for zero elements).
  if (list.length === 0) return NaN;
  let sum = 0;
  for (const n of list) sum += n;
  return sum / list.length;
}
`;

const MEAN_TEST = `import { test } from '${NODE_TEST}';
import assert from '${NODE_ASSERT}';
import { mean } from './mean.mjs';

test('mean of [1, 2, 3] is 2', () => {
  assert.strictEqual(mean([1, 2, 3]), 2);
});

test('mean of [2, 4] is 3', () => {
  assert.strictEqual(mean([2, 4]), 3);
});

test('mean of empty list is NaN', () => {
  assert.ok(Number.isNaN(mean([])));
});
`;


const REQ2 = {
  id: 'k1-req-2',
  description:
    'mean.test.mjs uses node:test and node:assert/strict with at least 3 assertions covering mean([1,2,3]) exactly 2 and mean([2,4]) exactly 3',
  testAnchors: [
    'mean.test.mjs uses node:test and node:assert/strict with at least 3 assertions covering mean([1,2,3]) exactly 2 and mean([2,4]) exactly 3',
  ],
};

const OUTPUT = 'pass 3 fail 0';

describe('M6: bound literals are a union over the named test file asserts', () => {
  it('correct M6 delivery (cases in separate asserts) is covered', () => {
    expect(MEAN_TEST).toMatch(/strictEqual\(mean\(\[1, 2, 3\]\), 2\)/);
    expect(MEAN_TEST).toMatch(/strictEqual\(mean\(\[2, 4\]\), 3\)/);
    const r = assessFunctionalCoverage(
      REQ2,
      { 'mean.mjs': MEAN_IMPL, 'mean.test.mjs': MEAN_TEST },
      OUTPUT,
    );
    expect(r.covered).toBe(true);
  });

  it('incorrect delivery (asserts never touch the required literals) is rejected', () => {
    const withoutLiterals = `import { test } from '${NODE_TEST}';
import assert from '${NODE_ASSERT}';
import { mean } from './mean.mjs';
test('empty is NaN', () => { assert.ok(Number.isNaN(mean([]))); });
test('type is number', () => { assert.equal(typeof mean([9]), 'number'); });
`;
    const r = assessFunctionalCoverage(
      REQ2,
      { 'mean.mjs': MEAN_IMPL, 'mean.test.mjs': withoutLiterals },
      OUTPUT,
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/k1-req-2|no assertion/i);
  });

  it('incorrect delivery (file with no asserts at all) is rejected', () => {
    const noAsserts = `import { test } from '${NODE_TEST}';
import { mean } from './mean.mjs';
test('smoke', () => { mean([1, 2, 3]); mean([2, 4]); });
`;
    const r = assessFunctionalCoverage(
      REQ2,
      { 'mean.mjs': MEAN_IMPL, 'mean.test.mjs': noAsserts },
      OUTPUT,
    );
    expect(r.covered).toBe(false);
  });

  it('anti-coincidence preserved (call and literal in different snippets do not bind)', () => {
    const coincidental = `import { test } from '${NODE_TEST}';
import assert from '${NODE_ASSERT}';
import { mean } from './mean.mjs';
test('coincidence', () => { mean([1, 2, 3]); mean([2, 4]); assert.equal(2, 2); assert.equal(3, 3); });
`;
    const r = assessFunctionalCoverage(
      REQ2,
      { 'mean.mjs': MEAN_IMPL, 'mean.test.mjs': coincidental },
      OUTPUT,
    );
    expect(r.covered).toBe(false);
  });
});
