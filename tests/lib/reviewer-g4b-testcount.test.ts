import { describe, it, expect } from 'bun:test';
import { reviewJob } from '../../src/lib/reviewer';

// G4b: prose test-counts ("has at least 3 cases") must not become required
// literals to bind. Correct capitalize delivery (4 distinguishing bound
// assertions, global suite green) must PASS the "at least 3 cases"
// requirement even though no assertion mentions the literal 3.
const IMPL = `export function capitalize(s: string): string {\n  if (s.length === 0) return s;\n  return s[0].toUpperCase() + s.slice(1);\n}\n`;
const TEST = `import { test, expect } from "bun:test";\nimport { capitalize } from "../src/capitalize.ts";\ntest("capitalizes first character", () => { expect(capitalize("hello")).toBe("Hello"); });\ntest("empty string stays empty", () => { expect(capitalize("")).toBe(""); });\ntest("leaves rest unchanged", () => { expect(capitalize("hELLO wORLD")).toBe("HELLO wORLD"); });\ntest("single character", () => { expect(capitalize("a")).toBe("A"); });\n`;
const OUTPUT = `bun test v1.3.14\ntests/capitalize.test.ts:\n(pass) capitalizes first character\n(pass) empty string stays empty\n(pass) leaves rest unchanged\n(pass) single character\ntests/placeholder.test.ts:\n(pass) placeholder\n 5 pass\n 0 fail\nRan 5 tests across 2 files.\n`;

describe('G4b: test-count prose is not a required literal', () => {
  it('correct capitalize with "at least 3 cases" requirement → PASS', () => {
    const verdict = reviewJob({
      jobName: 'capitalize',
      jobBranch: 'feature-cap',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['src/capitalize.ts', 'tests/capitalize.test.ts'],
      touchSet: ['src/capitalize.ts', 'tests/capitalize.test.ts'],
      requirements: [
        { id: 'capitalize-req-1', description: 'src/capitalize.ts exports capitalize(s:string):string uppercasing first char only, empty stays empty', testAnchors: ['src/capitalize.ts exports capitalize'] },
        { id: 'capitalize-req-2', description: 'tests/capitalize.test.ts has at least 3 cases', testAnchors: ['tests/capitalize.test.ts has at least 3 cases'] },
        { id: 'capitalize-req-3', description: 'bun test tests/capitalize.test.ts passes', testAnchors: ['bun test tests/capitalize.test.ts passes'] },
      ],
      fileContents: { 'src/capitalize.ts': IMPL, 'tests/capitalize.test.ts': TEST },
      testPaths: ['tests/capitalize.test.ts'],
      evidence: {
        command: 'bun test',
        exitCode: 0,
        output: OUTPUT,
        testedCommit: 'job-1',
        environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
      },
      claimedPass: true,
      sufficiency: { reviewer: 'opencode', decision: 'pass', reasons: [] },
      requireExternalSufficiency: true,
    });
    expect(verdict.verdict).toBe('pass');
  });
});
