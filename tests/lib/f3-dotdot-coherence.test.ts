import { describe, it, expect } from 'bun:test';
import { validateTaskCoherence, assertPlanCoherence } from '../../src/lib/auto-plan';

// M6 §2a RED: `normalizeCoherencePath` drops `./` but never resolves `../`,
// so the correct link `../mean.test.mjs` (written from `docs/mean.md`,
// meaning repo-root `mean.test.mjs`) never equals k1's `mean.test.mjs` and
// the linked-owner branch is never reached — the plan fails coherence.
// Fix: resolve `../` lexically and positionally (against the asserting
// task's own scope dirs). `docs/../mean.test.mjs` → `mean.test.mjs`;
// `../x` at the root escapes the repo and must keep failing as before.

const K1 = {
  name: 'k1',
  acceptance: ['mean.mjs exports mean(list) with empty list returning NaN'],
  touchSet: ['mean.mjs', 'mean.test.mjs'],
};

const K2_LINKED = {
  name: 'k2',
  acceptance: ['docs/mean.md body contains a relative link upward to ../mean.test.mjs'],
  touchSet: ['docs/mean.md'],
  dependsOn: ['k1'],
};

function linkedDraft(k2: typeof K2_LINKED) {
  return {
    requirements: [{ id: 'r1', text: 'Mean', acceptance: ['mean works'] }],
    tasks: [
      {
        name: 'k1',
        prompt: 'Implement mean',
        touchSet: ['mean.mjs', 'mean.test.mjs'],
        acceptance: ['mean.mjs exports mean(list) with empty list returning NaN'],
      },
      {
        name: 'k2',
        prompt: 'Document mean',
        dependsOn: ['k1'],
        touchSet: ['docs/mean.md'],
        acceptance: k2.acceptance,
      },
    ],
    decisions: [],
    questions: [],
    nextSteps: [],
  };
}

describe('M6 §2a: `../` refs resolve positionally against the asserting scope', () => {
  it('single-task with siblings accepts `../mean.test.mjs` owned by the linked job', () => {
    expect(() => validateTaskCoherence(K2_LINKED, { siblings: [K1] })).not.toThrow();
  });

  it('plan-wide accepts the same linked `../` shape', () => {
    expect(() => assertPlanCoherence(linkedDraft(K2_LINKED))).not.toThrow();
  });

  it('escaping ref `../../etc/secret.mjs` still fails (outside the repo)', () => {
    const escaping = {
      ...K2_LINKED,
      acceptance: ['docs/mean.md covers ../../etc/secret.mjs'],
    };
    expect(() => validateTaskCoherence(escaping, { siblings: [K1] })).toThrow(/secret\.mjs/);
    expect(() => assertPlanCoherence(linkedDraft(escaping))).toThrow(/secret\.mjs/);
  });

  it('strict single-task without siblings still fails on `../` (fail-closed)', () => {
    expect(() => validateTaskCoherence(K2_LINKED)).toThrow(/mean\.test\.mjs/);
  });

  it('unlinked `../` owner still fails', () => {
    const unlinked = { ...K2_LINKED, dependsOn: [] as string[] };
    expect(() => validateTaskCoherence(unlinked, { siblings: [K1] })).toThrow(/mean\.test\.mjs/);
    const draft = linkedDraft(unlinked);
    draft.tasks[1]!.dependsOn = [];
    expect(() => assertPlanCoherence(draft)).toThrow(/mean\.test\.mjs/);
  });

  it('plain refs outside every touchSet still fail (no weakening)', () => {
    const elsewhere = {
      ...K2_LINKED,
      acceptance: ['docs/mean.md covers other.test.mjs'],
    };
    expect(() => validateTaskCoherence(elsewhere, { siblings: [K1] })).toThrow(/other\.test\.mjs/);
    expect(() => assertPlanCoherence(linkedDraft(elsewhere))).toThrow(/other\.test\.mjs/);
  });
});
