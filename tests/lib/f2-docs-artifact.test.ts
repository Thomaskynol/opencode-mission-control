import { describe, it, expect } from 'bun:test';
import { assessDocsCoverage } from '../../src/lib/docs-review';

// F2 RED: the docs checker must verify artifacts (own file presence,
// verbatim stamps, real markdown links), not vocabulary ("relative",
// "link", "verbatim", self-mention "docs/x.md").

// Exact contents of the real M5 artifacts (docs/stats.md + docs/slug.md
// from the m5-target delivery, merged via Unverified accepts), inlined so
// the test runs on any machine with zero external dependency.
const STATS_DOC = `# stats

Stamp: BK-5M1

Utility functions in \`stats.mjs\`: \`mean(arr)\` and \`median(arr)\`.

## Behavior

- \`mean(arr)\`: returns the arithmetic mean (\`sum / length\`). Requires an array; throws \`TypeError\` for non-array input.
- \`median(arr)\`: sorts a copy numerically, returns the middle value (odd length) or the average of the two middle values (even length). Requires an array; throws \`TypeError\` for non-array input.
- Empty-list decision (as adopted by the code): both \`mean([])\` and \`median([])\` return \`NaN\` instead of throwing. Covered by test "empty list returns NaN (documented choice)".

## Run tests

\`\`\`sh
node --test
\`\`\`

## Tests

See [teste](../stats.test.mjs) for coverage (\`mean([1,2,3]) === 2\`, \`median([3,1,2]) === 2\`, \`median([1,2,3,4]) === 2.5\`, empty-list \`NaN\`, non-array \`TypeError\`).
`;

const SLUG_DOC = `# slug

Stamp: BK-5M2

\`slugify\` (\`slug.mjs\`) converts text to a URL slug: NFD normalize, strip
diacritics, lowercase, replace \`[^a-z0-9]+\` with \`-\`, trim leading/trailing \`-\`.
Non-string input throws \`TypeError\`; \`""\` returns \`""\`.

Examples: \`"Olá, Mundo!"\` → \`"ola-mundo"\`, \`"  Hello   World  "\` → \`"hello-world"\`.

Run tests with:

\`\`\`sh
node --test
\`\`\`

See [teste](../slug.test.mjs).
`;


describe('F2: docs checker verifies artifacts, not vocabulary', () => {
  it('self-existence ("docs/stats.md exists") is covered by the file itself, not by self-mention', () => {
    const r = assessDocsCoverage(
      { id: 'stats-docs-req-1', description: 'docs/stats.md exists' },
      { 'docs/stats.md': STATS_DOC },
    );
    expect(r.covered).toBe(true);
  });

  it('link requirement is covered by a real relative link, not by the words "relative"/"link"', () => {
    const good = assessDocsCoverage(
      {
        id: 'stats-docs-req-4',
        description: 'contains a relative link to the test containing stats.test.mjs',
      },
      { 'docs/stats.md': STATS_DOC },
    );
    expect(good.covered).toBe(true);
    const noLink = assessDocsCoverage(
      {
        id: 'stats-docs-req-4',
        description: 'contains a relative link to the test containing stats.test.mjs',
      },
      {
        'docs/stats.md':
          'Stamp: BK-5M1. Run `node --test` now and follow every step carefully today.\n\nThe stats.test.mjs file holds the suite for mean and median behavior today.\n',
      },
    );
    expect(noLink.covered).toBe(false);
    expect(noLink.reason).toMatch(/link.*stats\.test\.mjs|relative link/i);
  });

  it('verbatim requirement checks the stamp artifact, not the word "verbatim"', () => {
    const good = assessDocsCoverage(
      {
        id: 'slug-docs-req-2',
        description: 'contains verbatim BK-5M2, node --test and slug.test.mjs',
      },
      { 'docs/slug.md': SLUG_DOC },
    );
    expect(good.covered).toBe(true);
    const missingStamp = assessDocsCoverage(
      {
        id: 'slug-docs-req-2',
        description: 'contains verbatim BK-5M2, node --test and slug.test.mjs',
      },
      {
        'docs/slug.md':
          'Run tests with `node --test` now and follow every step carefully today.\n\nSee [teste](../slug.test.mjs) for behavior details and edge cases today.\n',
      },
    );
    expect(missingStamp.covered).toBe(false);
    expect(missingStamp.reason).toMatch(/BK-5M2/);
  });

  it('broken relative link still fails (artifact check, not vocabulary)', () => {
    const r = assessDocsCoverage(
      {
        id: 'stats-docs-req-4',
        description: 'contains a relative link to the test containing stats.test.mjs',
      },
      {
        'docs/stats.md':
          'Run tests with `node --test` now and follow every step carefully today.\n\nSee [teste](../missing.test.mjs) for behavior details and more context here.\n\nStamp BK-5M1 documents the stats behavior for empty lists today.\n',
      },
      { existingPaths: ['docs/stats.md', 'stats.test.mjs'] },
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/missing\.test\.mjs|broken|link/i);
  });

  it('missing stamp still fails (no approval by shape)', () => {
    const r = assessDocsCoverage(
      { id: 'r', description: 'contains verbatim BK-5M1, node --test and stats.test.mjs' },
      {
        'docs/stats.md':
          'Run tests with `node --test` now and follow every step carefully today.\n\nSee [teste](../stats.test.mjs) for the mean and median behavior details.\n',
      },
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/BK-5M1/);
  });

  it('consistency demand shares a decision literal with siblings (match covers, mismatch rejects)', () => {    const req = {
      id: 'stats-docs-req-3',
      description: 'describes empty-list behavior consistently with stats.mjs',
    };
    const doc = {
      'docs/stats.md':
        'Run `node --test` now and follow every step carefully today.\n\nEmpty-list behavior: `mean([])` and `median([])` return `NaN` for empty input, consistently with the implementation in stats.mjs.\n',
    };
    const nanCode = {
      'stats.mjs': 'export function mean(xs) { if (xs.length === 0) return NaN; return 1; }\n',
    };
    const throwCode = {
      'stats.mjs': 'export function mean(xs) { if (xs.length === 0) throw new Error("empty"); return 1; }\n',
    };
    const match = assessDocsCoverage(req, doc, { auxContents: nanCode });
    expect(match.covered).toBe(true);
    const mismatch = assessDocsCoverage(req, doc, { auxContents: throwCode });
    expect(mismatch.covered).toBe(false);
    expect(mismatch.status).toBe('not-covered');
    expect(mismatch.reason).toMatch(/never show|decision/i);
  });
});

describe('M7 residual: verified artifacts satisfy without meta-vocabulary', () => {
  // Exact contents of the real M7 k2 artifact (docs/mean.md, commit
  // bd00ae0 — natural and correct: BK-6M1 stamp, `docs/mean.md` literal,
  // NaN rule, `node --test`, real link [mean.test.mjs](../mean.test.mjs)),
  // inlined so the test runs on any machine with zero external dependency.
  const MEAN_DOC = `# mean

BK-6M1

This file is \`docs/mean.md\`.

\`mean(list)\` in \`../mean.mjs\` returns the arithmetic mean (\`sum / length\`).
Empty-list rule: \`mean([])\` returns \`NaN\` (the mean is undefined for zero
elements), per the guard in \`mean.mjs\`.

## Tests

Run the tests with \`node --test\` against \`../mean.test.mjs\`:

\`\`\`sh
node --test mean.test.mjs
\`\`\`

See the cases in [mean.test.mjs](../mean.test.mjs).
`;

  const TREE = ['docs/mean.md', 'mean.mjs', 'mean.test.mjs', 'package.json', 'README.md'];

  const REQ3 = {
    id: 'k2-req-3',
    description:
      'docs/mean.md body contains verbatim stamp BK-6M1, literal path docs/mean.md, and a relative link upward to the test file',
  };

  it('real M7 k2 doc is covered (artifacts present, no meta-words needed)', () => {
    const r = assessDocsCoverage(REQ3, { 'docs/mean.md': MEAN_DOC }, { existingPaths: TREE });
    expect(r.covered).toBe(true);
    expect(r.status).toBe('covered');
  });

  it('variant without any relative link is still rejected', () => {
    const noLink = MEAN_DOC.replace('See the cases in [mean.test.mjs](../mean.test.mjs).\n', '');
    const r = assessDocsCoverage(REQ3, { 'docs/mean.md': noLink }, { existingPaths: TREE });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/relative link/i);
  });

  it('variant without the stamp is still rejected', () => {
    const noStamp = MEAN_DOC.replace('BK-6M1\n', '');
    const r = assessDocsCoverage(REQ3, { 'docs/mean.md': noStamp }, { existingPaths: TREE });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/BK-6M1/);
  });

  it('mention without artifact still fails (words alone prove nothing)', () => {
    const mentionOnly =
      'This body documents the stamp and the literal path and the upward relative link for the test file in prose form only, describing everything at length here.\n';
    const r = assessDocsCoverage(REQ3, { 'docs/mean.md': mentionOnly }, { existingPaths: TREE });
    expect(r.covered).toBe(false);
  });
});
