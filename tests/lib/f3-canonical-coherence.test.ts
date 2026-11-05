import { describe, it, expect } from 'bun:test';
import {
  validateTaskCoherence,
  assertPlanCoherence,
  buildPlannerPrompt,
} from '../../src/lib/auto-plan';

// F3 RED: single-task validateTaskCoherence rejects the docs-after-code
// shape (acceptance references a file owned by the upstream job) while
// planner rule + assertPlanCoherence allow linked ownership. The three
// rules must agree on one canonical rule without weakening.

const DOCS_TASK = {
  name: 'slug-docs',
  acceptance: ['contains a relative link to the test containing slug.test.mjs'],
  touchSet: ['docs/slug.md'],
  dependsOn: ['slug-code'],
};

const SIBLINGS = [
  {
    name: 'slug-code',
    acceptance: ['slug.mjs exists and exports slugify'],
    touchSet: ['slug.mjs', 'slug.test.mjs'],
  },
];

function linkedDraft() {
  return {
    requirements: [{ id: 'r1', text: 'Slug', acceptance: ['slug works'] }],
    tasks: [
      {
        name: 'slug-code',
        prompt: 'Implement slugify',
        touchSet: ['slug.mjs', 'slug.test.mjs'],
        acceptance: ['slug.mjs exists and exports slugify'],
      },
      {
        name: 'slug-docs',
        prompt: 'Document slugify',
        dependsOn: ['slug-code'],
        touchSet: ['docs/slug.md'],
        acceptance: ['contains a relative link to the test containing slug.test.mjs'],
      },
    ],
    decisions: [],
    questions: [],
    nextSteps: [],
  };
}

describe('F3: canonical coherence rule (own touchSet OR linked job owns it)', () => {
  it('plan-wide check already accepts docs asserting a file owned by its dependency', () => {
    expect(() => assertPlanCoherence(linkedDraft())).not.toThrow();
  });

  it('single-task check with sibling context accepts the same linked shape', () => {
    expect(() => validateTaskCoherence(DOCS_TASK, { siblings: SIBLINGS })).not.toThrow();
  });

  it('single-task check without sibling context stays strict (fail-closed)', () => {
    expect(() => validateTaskCoherence(DOCS_TASK)).toThrow(/slug\.test\.mjs/);
  });

  it('linked check still rejects refs owned by an UNLINKED job', () => {
    const draft = linkedDraft();
    draft.tasks[1]!.dependsOn = [];
    expect(() => assertPlanCoherence(draft)).toThrow(/slug\.test\.mjs/);
    expect(() =>
      validateTaskCoherence({ ...DOCS_TASK, dependsOn: [] }, { siblings: SIBLINGS }),
    ).toThrow(/slug\.test\.mjs/);
  });

  it('linked check still rejects refs owned by nobody', () => {
    expect(() =>
      validateTaskCoherence(
        { name: 'slug-docs', acceptance: ['covers ghost.test.mjs fully'] },
        { siblings: SIBLINGS },
      ),
    ).toThrow(/ghost\.test\.mjs/);
  });

  it('planner prompt states the canonical linked-ownership rule', () => {
    const prompt = buildPlannerPrompt({ request: 'do X' });
    expect(prompt).toMatch(/dependsOn/i);
    expect(prompt).toMatch(/touchSet/);
  });
});
