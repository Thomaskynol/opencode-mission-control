import { describe, it, expect } from 'bun:test';
/**
 * k2/req-4 bloqueio: docs-only sem canal de evidência executada.
 * Fonte: req-4 = `- [ ] node --test passes` (k2-req-4); doc tem comando em
 * bloco sh mas sem saída; gate docs-only nunca executa a suíte.
 * TDD RED: estes testes falham antes do fix (sem canal executedEvidence).
 */
import {
  assessDocsCoverageWithSemantics,
  isExecutionRequirement,
  validateDocsExecutedEvidence,
} from '../../src/lib/docs-review';

const REQ4 = { id: 'k2-req-4', description: 'node --test passes' };
const JOB_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567';

// Doc correta: documenta o comando + link relativo, mas NÃO contém saída
// de execução (como docs/mean.md @ bd00ae0: comando em bloco sh sem output).
const CORRECT_DOC = `# mean

Run \`node --test\` to execute the suite against [tests](../mean.test.mjs).
Open the folder, run the command, then verify the output shows passing cases.
`;

const SEM_FAIL_NO_OUTPUT = {
  verdict: 'fail' as const,
  demonstrated: false,
  evidence: ['Run `node --test` to execute the suite'],
  reason:
    'Documentation contains no test execution output or result proving node --test passes.',
};

const VALID_EVIDENCE = {
  command: 'node --test',
  exitCode: 0,
  output: 'ok 1 - mean ([1,2,3])\nok 2 - mean ([2,4])\n# pass 2\n# fail 0',
  testedCommit: JOB_HEAD,
  environment: 'worktree:/tmp/k2 (node v22, linux)',
  dirty: false as const,
};

describe('docs executed evidence (k2/req-4)', () => {
  it('detecta critério de execução sem alterar texto do req-4', () => {
    expect(isExecutionRequirement('node --test passes')).toBe(true);
    // Documentar COMO rodar não exige prova de execução (k2-req-2).
    expect(
      isExecutionRequirement('docs/mean.md explains running tests with node --test against mean.test.mjs'),
    ).toBe(false);
    expect(isExecutionRequirement('Explain the backup restoration procedure')).toBe(false);
  });

  it('(a) doc correta + evidência válida → pass', () => {
    const r = assessDocsCoverageWithSemantics(REQ4, { 'docs/mean.md': CORRECT_DOC }, SEM_FAIL_NO_OUTPUT, {
      existingPaths: ['docs/mean.md', 'mean.test.mjs'],
      executedEvidence: VALID_EVIDENCE,
      jobHead: JOB_HEAD,
    });
    expect(r.covered).toBe(true);
    expect(r.status).toBe('covered');
  });

  it('(b) doc correta + evidência ausente → fail "execute e reapresente" sem pedir reescrita', () => {
    const r = assessDocsCoverageWithSemantics(REQ4, { 'docs/mean.md': CORRECT_DOC }, SEM_FAIL_NO_OUTPUT, {
      existingPaths: ['docs/mean.md', 'mean.test.mjs'],
      jobHead: JOB_HEAD,
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/executed evidence|execute e reapresente/i);
  });

  it('(c) doc incorreta + evidência válida → fail pedindo correção da doc', () => {
    const wrong = '# mean\nThis guide is about deployment rollback steps for production servers.';
    const r = assessDocsCoverageWithSemantics(
      REQ4,
      { 'docs/mean.md': wrong },
      {
        verdict: 'fail' as const,
        demonstrated: false,
        evidence: ['deployment rollback steps'],
        reason: 'Docs describe the wrong topic and give no usable test command.',
      },
      {
        existingPaths: ['docs/mean.md', 'mean.test.mjs'],
        executedEvidence: VALID_EVIDENCE,
        jobHead: JOB_HEAD,
      },
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/fix the docs|correct/i);
  });

  it('(d) evidência stale/dirty → fail pedindo re-executar', () => {
    const stale = { ...VALID_EVIDENCE, testedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    const rStale = assessDocsCoverageWithSemantics(REQ4, { 'docs/mean.md': CORRECT_DOC }, SEM_FAIL_NO_OUTPUT, {
      existingPaths: ['docs/mean.md', 'mean.test.mjs'],
      executedEvidence: stale,
      jobHead: JOB_HEAD,
    });
    expect(rStale.covered).toBe(false);
    expect(rStale.reason).toMatch(/stale|re-execut|diverges/i);

    const dirty = { ...VALID_EVIDENCE, dirty: true as const };
    const rDirty = assessDocsCoverageWithSemantics(REQ4, { 'docs/mean.md': CORRECT_DOC }, SEM_FAIL_NO_OUTPUT, {
      existingPaths: ['docs/mean.md', 'mean.test.mjs'],
      executedEvidence: dirty,
      jobHead: JOB_HEAD,
    });
    expect(rDirty.covered).toBe(false);
    expect(rDirty.reason).toMatch(/dirty|re-execut/i);

    const check = validateDocsExecutedEvidence(stale, JOB_HEAD);
    expect(check.ok).toBe(false);
  });
});
