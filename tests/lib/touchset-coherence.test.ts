import { describe, it, expect } from 'bun:test';
import {
  parsePlannerOutput,
  validateTaskCoherence,
  assertPlanCoherence,
  type AutoPlanDraft,
} from '../../src/lib/auto-plan';
import { validateModelDispatch } from '../../src/lib/coordinator';

function sumDraftSingle(): AutoPlanDraft {
  return {
    requirements: [{ id: 'r1', text: 'Add sum', acceptance: ['sum works'] }],
    tasks: [
      {
        name: 'implement-sum',
        prompt: 'Implement sum in sum.js and cover it in sum.test.js',
        touchSet: ['sum.js', 'sum.test.js'],
        acceptance: ['bun test sum.test.js passes'],
      },
    ],
    decisions: [],
    questions: [],
    nextSteps: [],
  };
}

function sumDraftSplit(): AutoPlanDraft {
  return {
    requirements: [{ id: 'r1', text: 'Add sum', acceptance: ['sum works'] }],
    tasks: [
      {
        name: 'implement-sum',
        prompt: 'Implement sum(a, b) in sum.js',
        touchSet: ['sum.js'],
        acceptance: ['sum(1, 2) returns 3'],
      },
      {
        name: 'test-sum',
        prompt: 'Cover sum with tests',
        dependsOn: ['implement-sum'],
        touchSet: ['sum.test.js'],
        acceptance: ['bun test sum.test.js passes'],
      },
    ],
    decisions: [],
    questions: [],
    nextSteps: [],
  };
}

describe('touchset coherence (RED: acceptance x touchSet before dispatch)', () => {
  it('(a) accepts a valid plan: impl + test covered by the touchSet', () => {
    const draft = sumDraftSingle();
    expect(() => validateTaskCoherence(draft.tasks[0])).not.toThrow();
    expect(() => assertPlanCoherence(draft)).not.toThrow();
    // Same shape through the planner pipeline.
    const parsed = parsePlannerOutput(JSON.stringify(draft));
    expect(() => assertPlanCoherence(parsed)).not.toThrow();
  });

  it('(a) accepts the test in its own job with dependsOn', () => {
    const draft = sumDraftSplit();
    for (const t of draft.tasks) expect(() => validateTaskCoherence(t)).not.toThrow();
    expect(() => assertPlanCoherence(draft)).not.toThrow();
    expect(
      validateModelDispatch(
        { name: 'test-sum', touchSet: ['sum.test.js'], acceptance: ['bun test sum.test.js passes'] },
        [
          { name: 'implement-sum', status: 'merged', touchSet: ['sum.js'] },
          {
            name: 'test-sum',
            status: 'queued',
            dependsOn: ['implement-sum'],
            touchSet: ['sum.test.js'],
            acceptance: ['bun test sum.test.js passes'],
          },
        ],
        ['implement-sum'],
      ).name,
    ).toBe('test-sum');
  });

  it('(b) blocks the demo inconsistency: touchSet [sum.js] but acceptance runs sum.test.js', () => {
    const task = {
      name: 'implement-sum',
      prompt: 'Implement sum',
      touchSet: ['sum.js'],
      acceptance: ['bun test sum.test.js passes'],
    };
    expect(() => validateTaskCoherence(task)).toThrow(/sum\.test\.js/);
    expect(() => validateTaskCoherence(task)).toThrow(/touchSet|ampli|ampliar|move/i);
    const draft: AutoPlanDraft = {
      requirements: [{ id: 'r1', text: 'Add sum', acceptance: ['sum works'] }],
      tasks: [task],
      decisions: [],
      questions: [],
      nextSteps: [],
    };
    expect(() => assertPlanCoherence(draft)).toThrow(/sum\.test\.js/);
    // Blocked BEFORE dispatch, with a useful diagnosis.
    expect(() =>
      validateModelDispatch(
        { name: 'implement-sum', touchSet: ['sum.js'], acceptance: ['bun test sum.test.js passes'] },
        [
          {
            name: 'implement-sum',
            status: 'queued',
            touchSet: ['sum.js'],
            acceptance: ['bun test sum.test.js passes'],
          },
        ],
        [],
      ),
    ).toThrow(/sum\.test\.js/);
    expect(() =>
      validateModelDispatch(
        { name: 'implement-sum', touchSet: ['sum.js'], acceptance: ['bun test sum.test.js passes'] },
        [
          {
            name: 'implement-sum',
            status: 'queued',
            touchSet: ['sum.js'],
            acceptance: ['bun test sum.test.js passes'],
          },
        ],
        [],
      ),
    ).toThrow(/touchSet|mover|move|ampli/i);
  });

  it('(c) rejects a second domain (slugify + required doc outside the touchSet)', () => {
    const task = {
      name: 'slugify',
      prompt: 'Implement slugify in src/slugify.js',
      touchSet: ['src/slugify.js'],
      acceptance: [
        'bun test src/slugify.test.js passes',
        'usage documented in docs/slugify.md',
      ],
    };
    expect(() => validateTaskCoherence(task)).toThrow(/slugify\.(test\.js|md)/);
    const draft: AutoPlanDraft = {
      requirements: [{ id: 'r2', text: 'Slugify', acceptance: ['slugify works'] }],
      tasks: [task],
      decisions: [],
      questions: [],
      nextSteps: [],
    };
    expect(() => assertPlanCoherence(draft)).toThrow(/slugify/);
  });

  it('(c) rejects reverse-list when its test file is outside the touchSet', () => {
    const task = {
      name: 'reverse-list',
      prompt: 'Implement reverseList in src/reverse.js',
      touchSet: ['src/reverse.js'],
      acceptance: ['bun test src/reverse.test.js passes'],
    };
    expect(() => validateTaskCoherence(task)).toThrow(/reverse\.test\.js/);
  });

  it('(d) diagnoses two workers writing the same file without ordering', () => {
    const draft: AutoPlanDraft = {
      requirements: [{ id: 'r3', text: 'Shared owner', acceptance: ['done'] }],
      tasks: [
        {
          name: 'worker-a',
          prompt: 'Write shared.js (variant A)',
          touchSet: ['shared.js'],
          acceptance: ['variant A works'],
        },
        {
          name: 'worker-b',
          prompt: 'Write shared.js (variant B)',
          touchSet: ['shared.js'],
          acceptance: ['variant B works'],
        },
      ],
      decisions: [],
      questions: [],
      nextSteps: [],
    };
    expect(() => assertPlanCoherence(draft)).toThrow(/shared\.js/);
  });

  it('(d) diagnoses a test asserting on a file that belongs to another job', () => {
    const draft: AutoPlanDraft = {
      requirements: [{ id: 'r1', text: 'Add sum', acceptance: ['sum works'] }],
      tasks: [
        {
          name: 'implement-sum',
          prompt: 'Implement sum in sum.js',
          touchSet: ['sum.js'],
          acceptance: ['sum(1, 2) returns 3'],
        },
        {
          name: 'unrelated',
          prompt: 'Do something else',
          touchSet: ['other.js'],
          acceptance: ['bun test sum.test.js passes'],
        },
      ],
      decisions: [],
      questions: [],
      nextSteps: [],
    };
    // sum.test.js is owned by nobody here and asserted by the wrong job:
    // either widen its touchSet or move the test into a dependent job.
    expect(() => assertPlanCoherence(draft)).toThrow(/sum\.test\.js/);
  });

  it('checks the ceiling testCommand against the union of touchSets', () => {
    const draft = sumDraftSplit();
    expect(() =>
      assertPlanCoherence(draft, { testCommand: 'bun test sum.test.js' }),
    ).not.toThrow();
    const narrow: AutoPlanDraft = {
      requirements: [{ id: 'r1', text: 'Add sum', acceptance: ['sum works'] }],
      tasks: [
        {
          name: 'implement-sum',
          prompt: 'Implement sum in sum.js',
          touchSet: ['sum.js'],
          acceptance: ['sum(1, 2) returns 3'],
        },
      ],
      decisions: [],
      questions: [],
      nextSteps: [],
    };
    expect(() => assertPlanCoherence(narrow, { testCommand: 'bun test sum.test.js' })).toThrow(
      /sum\.test\.js/,
    );
  });
});
