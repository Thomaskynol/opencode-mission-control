import { describe, it, expect } from 'bun:test';
import { reviewJob, type ReviewInput } from '../../src/lib/reviewer';

// Heurística cega a re-exports: barrel correto só re-exporta e o teste
// executável passa, mas extractImplCandidates não vê defs no barrel.
// RED: estes dois domínios devem PASSAR (hoje dão FAIL determinístico).

const NODE_TEST_SPEC = 'node' + ':test';

function barrelInput(
  jobName: string,
  changedFiles: string[],
  fileContents: Record<string, string>,
  testPaths: string[],
  requirementId: string,
  description: string,
  output: string,
): ReviewInput {
  return {
    jobName,
    jobBranch: `feature-${jobName}`,
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles,
    requirements: [{ id: requirementId, description, testAnchors: [description] }],
    fileContents,
    testPaths,
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

describe('barrel re-export: heurística persegue re-exports e se abstém sem candidata visível', () => {
  it('strings barrel (export * + export {x} from) com teste via barrel → PASS', () => {
    const verdict = reviewJob(
      barrelInput(
        'strings-barrel',
        ['index.js', 'index.test.js'],
        {
          // Só re-exporta — nenhuma definição direta (caso index-task 34b34ad).
          'index.js': `export * from './slugify.js';\nexport { capitalize } from './capitalize.js';\n`,
          'index.test.js':
            `import { slugify, capitalize } from './index.js';\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('slugify and capitalize via barrel', () => { assert.equal(slugify('Hello World'), 'hello-world'); assert.equal(capitalize('hello'), 'Hello'); });\n`,
        },
        ['index.test.js'],
        'REQ-strings-barrel',
        'slugify strings for url slugs and capitalize words',
        'pass: slugify and capitalize via barrel (2 passed)',
      ),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('validators barrel (module.exports require) com teste via barrel → PASS', () => {
    const verdict = reviewJob(
      barrelInput(
        'validators-barrel',
        ['entry.js', 'entry.test.js'],
        {
          // Barrel CJS — só re-exporta via require (alvo fora do escopo).
          'entry.js': `module.exports = require('./validators.js');\n`,
          'entry.test.js':
            `const { isEmail } = require('./entry.js');\nimport test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\ntest('validate via barrel', () => { assert.equal(isEmail('a@b.co'), true); assert.equal(isEmail('not-an-email'), false); });\n`,
        },
        ['entry.test.js'],
        'REQ-validators-barrel',
        'validate email addresses',
        'pass: validate via barrel (2 passed)',
      ),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('barrel sem teste continua FAIL (sem virar allow-all)', () => {
    const verdict = reviewJob(
      barrelInput(
        'strings-barrel-empty',
        ['index.js'],
        {
          'index.js': `export * from './slugify.js';\n`,
        },
        [],
        'REQ-strings-barrel',
        'slugify strings for url slugs and capitalize words',
        'pass: unrelated suite (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
  });
});
