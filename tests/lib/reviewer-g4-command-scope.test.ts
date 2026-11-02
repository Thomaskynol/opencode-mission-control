import { describe, it, expect } from 'bun:test';
import { reviewJob, isCommandScopeComplaint, partitionExternalReasons, type ReviewInput } from '../../src/lib/reviewer';
import { buildPrompt } from '../../src/lib/opencode-reviewer';

// G4 repro: correct sum delivery with genuine product evidence (global `bun test`
// at the reviewed commit, covering the task) must PASS even when the external
// reviewer complains only about command shape ("4 pass across 2 files, not an
// isolated tests/sum.test.ts run with 3 tests across 1 file"). Wrong slugify
// (diacritics) must still FAIL.

const SUM_IMPL = `export function sum(a: number, b: number): number { return a + b; }\n`;
const SUM_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(2, 3)).toBe(5); });\ntest("negative", () => { expect(sum(-2, -3)).toBe(-5); });\ntest("zero", () => { expect(sum(0, 0)).toBe(0); });\n`;

// Global suite output as the product really produces it: task tests included,
// plus the base placeholder file (2 files total). Deterministic execution
// proof — the command ran, exit 0, output observable, commit pinned.
const GLOBAL_OUTPUT = `bun test v1.3.14\ntests/sum.test.ts:\n(pass) positive [2ms]\n(pass) negative [1ms]\n(pass) zero [1ms]\ntests/placeholder.test.ts:\n(pass) placeholder [0ms]\n 4 pass\n 0 fail\n 4 expect() calls\nRan 4 tests across 2 files.\n`;

function sumInput(externalReason: string): ReviewInput {
  return {
    jobName: 'sum',
    jobBranch: 'feature-sum',
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles: ['src/sum.ts', 'tests/sum.test.ts'],
    touchSet: ['src/sum.ts', 'tests/sum.test.ts'],
    requirements: [
      { id: 'sum-req-1', description: 'src/sum.ts exports sum returning a+b', testAnchors: ['src/sum.ts exports sum returning a+b'] },
      { id: 'sum-req-2', description: 'tests/sum.test.ts has at least 3 cases including positive, negative, zero', testAnchors: ['tests/sum.test.ts has at least 3 cases'] },
      { id: 'sum-req-3', description: 'bun test tests/sum.test.ts passes', testAnchors: ['bun test tests/sum.test.ts passes'] },
    ],
    fileContents: {
      'src/sum.ts': SUM_IMPL,
      'tests/sum.test.ts': SUM_TEST,
    },
    testPaths: ['tests/sum.test.ts'],
    evidence: {
      command: 'bun test',
      exitCode: 0,
      output: GLOBAL_OUTPUT,
      testedCommit: 'job-1',
      environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
    },
    claimedPass: true,
    sufficiency: { reviewer: 'opencode', decision: 'fail', reasons: [externalReason] },
    requireExternalSufficiency: true,
  };
}

describe('G4: gate accepts task-scoped global evidence, rejects command-shape veto', () => {
  it('correct sum with global evidence + command-scope external complaint → PASS (auditable)', () => {
    const verdict = reviewJob(
      sumInput('sum-req-3: observed output shows 4 pass across 2 files, not an isolated tests/sum.test.ts run with 3 tests across 1 file; no direct evidence the anchored command passes — fail-closed'),
    );
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
  });

  it('correct sum with second mission wording (4 tests across 2 files, command-specific) → PASS', () => {
    const verdict = reviewJob(
      sumInput('sum-req-3: observed output reports 4 tests across 2 files with 4 expect calls, not 3 tests in 1 file; command-specific pass for tests/sum.test.ts not demonstrated. — fail-closed'),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('wrong slugify (no diacritics) with functional external fail → still FAIL', () => {
    const wrongImpl = `export function slugify(s: string): string { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\n`;
    // Tests miss the Café case: they pass, but do not cover the requirement.
    const weakTest = `import { test, expect } from "bun:test";\nimport { slugify } from "../src/slugify";\ntest("lowercases", () => { expect(slugify("  Hello World  ")).toBe("hello-world"); });\ntest("collapses", () => { expect(slugify("foo---bar")).toBe("foo-bar"); });\ntest("trims", () => { expect(slugify("---hello---")).toBe("hello"); });\ntest("dots", () => { expect(slugify("a.b")).toBe("a-b"); });\n`;
    const verdict = reviewJob({
      jobName: 'slugify',
      jobBranch: 'feature-slugify',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['src/slugify.ts', 'tests/slugify.test.ts'],
      touchSet: ['src/slugify.ts', 'tests/slugify.test.ts'],
      requirements: [
        { id: 'slugify-req-1', description: "slugify('Café au lait') becomes 'cafe-au-lait'", testAnchors: ["slugify('Café au lait') becomes 'cafe-au-lait'"] },
      ],
      fileContents: {
        'src/slugify.ts': wrongImpl,
        'tests/slugify.test.ts': weakTest,
      },
      testPaths: ['tests/slugify.test.ts'],
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: 'pass: lowercases (1 passed)\npass: collapses (1 passed)\npass: trims (1 passed)\npass: dots (1 passed)\n 4 pass\n 0 fail\nRan 4 tests across 1 file.\n',
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
      },
      claimedPass: true,
      sufficiency: { reviewer: 'opencode', decision: 'fail', reasons: ["slugify-req-1: tests do not demonstrate diacritics removal — no assertion binds slugify() to 'cafe-au-lait' — fail-closed"] },
      requireExternalSufficiency: true,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
  });

  it('functional external fail still blocks even with local coverage (no discount)', () => {
    const verdict = reviewJob(sumInput('external: sum not demonstrated — no test calls sum()'));
    expect(verdict.verdict).toBe('fail');
  });

  it('classifier: command-shape vs functional', () => {
    expect(isCommandScopeComplaint('observed output shows 4 pass across 2 files, not an isolated run')).toBe(true);
    expect(isCommandScopeComplaint('command-specific pass not demonstrated')).toBe(true);
    expect(isCommandScopeComplaint('no direct evidence the anchored command passes')).toBe(true);
    expect(isCommandScopeComplaint('external: sum not demonstrated — no test calls sum()')).toBe(false);
    expect(isCommandScopeComplaint('tests do not demonstrate diacritics removal — no assertion binds slugify()')).toBe(false);
    const parts = partitionExternalReasons([
      'sum-req-3: observed output shows 4 pass across 2 files, not isolated',
      'sum-req-1: no test calls sum()',
    ]);
    expect(parts.commandScope).toHaveLength(1);
    expect(parts.functional).toHaveLength(1);
  });

  it('discount is auditable (audit trail on pass)', () => {
    const verdict = reviewJob(
      sumInput('sum-req-3: observed output shows 4 pass across 2 files, not an isolated tests/sum.test.ts run'),
    );
    expect(verdict.verdict).toBe('pass');
    expect((verdict.audit ?? []).join(' ')).toMatch(/discounted/i);
  });

  it('external prompt forbids command-shape veto (deterministic rule vs LLM judgment)', () => {
    const prompt = buildPrompt({
      requirements: [{ id: 'r1', description: 'bun test tests/x.test.ts passes', anchors: [] }],
      implFiles: { 'src/x.ts': 'export function x(){return 1;}' },
      tests: { 'tests/x.test.ts': 'test' },
      outputs: '4 pass across 2 files',
    });
    expect(prompt).toMatch(/Scope rule/i);
    expect(prompt).toMatch(/Do NOT fail for command spelling/i);
    expect(prompt).toMatch(/global[\s\S]*satisfies execution/i);
  });
});
