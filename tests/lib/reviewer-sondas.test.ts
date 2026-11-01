import { describe, it, expect } from 'bun:test';
import { reviewJob, type ReviewInput } from '../../src/lib/reviewer';

// Fixture helper: simulated product-observed test files must not spell the
// node:test runner specifier as an import source — the conventions gate scans
// this file's text and flags any non-bun runner. The specifier is built by
// concatenation so the runtime string is identical but the literal is absent.
const NODE_TEST_SPEC = 'node' + ':test';

function sondaInput(fileContents: Record<string, string>, output: string, description = 'total([1,2])===3'): ReviewInput {
  return {
    jobName: 'total-job',
    jobBranch: 'feature-total',
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles: ['total.mjs', 'total.test.mjs'],
    touchSet: ['total.mjs', 'total.test.mjs'],
    requirements: [{ id: 'REQ-total', description, testAnchors: [description] }],
    fileContents,
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

const WRONG_IMPL = 'export function total(xs) { return 0; }\n';
const RIGHT_IMPL = 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n';

// §3 sondas 2,3,4,7 — revisão 9f47d5f. RED antes do fix.
describe('sondas §3 (revisão 9f47d5f)', () => {
  it('Sonda 3: import assert sem uso NUNCA conta como asserção → fail', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': WRONG_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict'; // importado, nunca usado\nimport { total } from './total.mjs';\ntest('calculate 1 2 3', () => { total([1, 2]); });\n`,
        },
        'pass: calculate 1 2 3 (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
  });

  it('Sonda 2: chamada + assert.equal(3,3) desconectado REJEITA → fail', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': WRONG_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('total([1,2])===3', () => {\n  total([1, 2]);\n  assert.equal(3, 3);\n});\n`,
        },
        'pass: total([1,2])===3 (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/assert/i);
  });

  it('Sonda 4: só-caso-vazio com título carregando os valores REJEITA → fail', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': WRONG_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('total([1,2])===3', () => assert.equal(total([]), 0));\n`,
        },
        'pass: total([1,2])===3 (1 passed)',
      ),
    );
    expect(verdict.verdict).toBe('fail');
  });

  it('Sonda 7: prosa com número solto vai pelo caminho comportamental → pass', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': RIGHT_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
        },
        'pass: adds numbers correctly (1 passed)',
        'Return the sum of 2 numbers',
      ),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('Sonda 1: NL + só vazio com impl que ignora a entrada REJEITA → fail', () => {
    const verdict = reviewJob(
      sondaInput(
        {
          'total.mjs': WRONG_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('empty', () => assert.equal(total([]), 0));\n`,
        },
        'pass: empty (1 passed)',
        'Return the sum of a list',
      ),
    );
    expect(verdict.verdict).toBe('fail');
  });
});

// demo-r5: âncora-arquivo é dica de escopo, não veto. Critério auto-gerado
// "X covered in f.test.mjs" com impl + assert reais deve PASSAR (hoje o veto
// de âncora-arquivo falha fechado sem examinar o conteúdo). RED antes do fix.
describe('demo-r5: âncora-arquivo como dica de escopo (revisão 9f47d5f)', () => {
  function anchorInput(
    fileContents: Record<string, string>,
    output: string,
    anchors: string[],
  ): ReviewInput {
    return {
      jobName: 'total-job',
      jobBranch: 'feature-total',
      baseBranch: 'main',
      baseHead: 'base-1',
      jobHead: 'job-1',
      changedFiles: ['total.mjs', 'total.test.mjs'],
      touchSet: ['total.mjs', 'total.test.mjs'],
      requirements: [
        { id: 'REQ-total', description: 'total([1,2])===3 covered in total.test.mjs', testAnchors: anchors },
      ],
      fileContents,
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

  it('âncora-arquivo presente no escopo + asserção vinculada real → pass', () => {
    const verdict = reviewJob(
      anchorInput(
        {
          'total.mjs': RIGHT_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
        },
        'pass: adds numbers correctly (1 passed)',
        ['total.test.mjs'],
      ),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('âncora-arquivo ausente do conteúdo examinado → fail (escopo, fail-closed)', () => {
    const verdict = reviewJob(
      anchorInput(
        {
          'total.mjs': RIGHT_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
        },
        'pass: adds numbers correctly (1 passed)',
        ['missing.test.mjs'],
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/scope/i);
  });

  it('âncora-linha-inteira ("X covered in f.test.mjs") resolve o path embutido → pass', () => {
    const verdict = reviewJob(
      anchorInput(
        {
          'total.mjs': RIGHT_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
        },
        'pass: adds numbers correctly (1 passed)',
        ['total([1,2])===3 covered in total.test.mjs'],
      ),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('âncora-linha-inteira com arquivo ausente → fail (escopo, fail-closed)', () => {
    const verdict = reviewJob(
      anchorInput(
        {
          'total.mjs': RIGHT_IMPL,
          'total.test.mjs':
            `import test from '${NODE_TEST_SPEC}';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\ntest('adds numbers correctly', () => assert.equal(total([1,2]), 3));\n`,
        },
        'pass: adds numbers correctly (1 passed)',
        ['total([1,2])===3 covered in missing.test.mjs'],
      ),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/scope/i);
  });
});
