import { describe, it, expect } from 'bun:test';
import { reviewJob, isCommandScopeComplaint, partitionExternalReasons, type ReviewInput } from '../../src/lib/reviewer';
import { toSufficiencyDecision } from '../../src/lib/opencode-reviewer';

// P2: rejeição semântica/funcional ou ambígua/mista NUNCA vira pass por regex
// de comando. Sonda: sum(-2,-3)->0 (deveria ser -5), teste cobre SÓ 2+3, e o
// revisor externo relata o gap funcional junto com linguagem de comando
// ("observed output shows 1 pass across 1 files; tests never cover negative
// numbers"). Antes do fix isso era descontado como command-scope -> pass.
// Também: aceitar suíte global exige prova de que os testes da tarefa
// executaram (arquivo de teste listado na saída) — nome/contagem não basta.

const BUGGY_SUM = `export function sum(a: number, b: number): number { return a < 0 || b < 0 ? 0 : a + b; }\n`;
const THIN_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(2, 3)).toBe(5); });\n`;
// Saída completa: o runner lista tests/sum.test.ts como executado.
const OUTPUT_FULL = `bun test v1.3.14\ntests/sum.test.ts:\n(pass) positive [2ms]\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file.\n`;
// Saída incompleta/órfã: suíte global verde que NÃO executou os testes da tarefa.
const OUTPUT_ORPHAN = `bun test v1.3.14\ntests/placeholder.test.ts:\n(pass) placeholder [0ms]\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file.\n`;

const MIXED_EN = 'sum-req-3: observed output shows 1 pass across 1 files; tests never cover negative numbers';
const MIXED_PT = 'sum-req-3: observed output shows 1 pass across 1 files; testes não cobrem números negativos';
const MIXED_VALUES = 'sum-req-1: observed output shows 1 pass across 1 file, but sum returns 0 instead of -5 for negative inputs';
const MIXED_EXPECTED = 'sum-req-1: observed output shows 1 pass across 1 file; expected -5 but got 0 for sum(-2,-3)';
const PURE_R1 = 'sum-req-3: observed output shows 4 pass across 2 files, not an isolated tests/sum.test.ts run with 3 tests across 1 file; no direct evidence the anchored command passes — fail-closed';
const PURE_R2 = 'sum-req-3: observed output reports 4 tests across 2 files with 4 expect calls, not 3 tests in 1 file; command-specific pass for tests/sum.test.ts not demonstrated. — fail-closed';

function sumInput(externalReason: string, output = OUTPUT_FULL, extraReqs: ReviewInput['requirements'] = []): ReviewInput {
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
      { id: 'sum-req-2', description: 'tests/sum.test.ts has at least 1 case', testAnchors: ['tests/sum.test.ts has at least 1 case'] },
      { id: 'sum-req-3', description: 'bun test tests/sum.test.ts passes', testAnchors: ['bun test tests/sum.test.ts passes'] },
      ...extraReqs,
    ],
    fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/sum.test.ts': THIN_TEST },
    testPaths: ['tests/sum.test.ts'],
    evidence: {
      command: 'bun test',
      exitCode: 0,
      output,
      testedCommit: 'job-1',
      environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
    },
    claimedPass: true,
    sufficiency: { reviewer: 'opencode', decision: 'fail', reasons: [externalReason] },
    requireExternalSufficiency: true,
  };
}

describe('P2: mista/ambígua nunca vira pass por regex de comando', () => {
  it('classificador: EN funcional com prefixo de comando → funcional (false)', () => {
    expect(isCommandScopeComplaint(MIXED_EN)).toBe(false);
  });

  it('classificador: PT funcional com prefixo de comando → funcional (false)', () => {
    expect(isCommandScopeComplaint(MIXED_PT)).toBe(false);
  });

  it('classificador: contraste de valores (instead of / expected X but got Y) → funcional', () => {
    expect(isCommandScopeComplaint(MIXED_VALUES)).toBe(false);
    expect(isCommandScopeComplaint(MIXED_EXPECTED)).toBe(false);
  });

  it('classificador: puras de comando continuam command-scope (true)', () => {
    expect(isCommandScopeComplaint(PURE_R1)).toBe(true);
    expect(isCommandScopeComplaint(PURE_R2)).toBe(true);
  });

  it('partition: mista cai no balde funcional', () => {
    const parts = partitionExternalReasons([MIXED_EN, PURE_R1]);
    expect(parts.functional).toContain(MIXED_EN);
    expect(parts.commandScope).toContain(PURE_R1);
  });

  it('reviewJob: gap real de negativos (EN misto) → FAIL bloqueante, sem audit de desconto', () => {
    const verdict = reviewJob(sumInput(MIXED_EN));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/negative|cover/i);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('reviewJob: gap real de negativos (PT misto) → FAIL bloqueante', () => {
    const verdict = reviewJob(sumInput(MIXED_PT));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
  });

  it('reviewJob: saída incompleta (tarefa não executou) + razão pura → FAIL sem desconto', () => {
    const verdict = reviewJob(sumInput(PURE_R1, OUTPUT_ORPHAN));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/task test|not.*execut|no proof|unproven/i);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('reviewJob: pura + saída que prova execução da tarefa → PASS com audit (guarda G4)', () => {
    const verdict = reviewJob(sumInput(PURE_R1, OUTPUT_FULL));
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
    expect((verdict.audit ?? []).join(' ')).toMatch(/discounted/i);
  });

  it('reviewJob: requisito não coberto (caso ausente do teste) bloqueia mesmo com externo pass', () => {
    const verdict = reviewJob({
      ...sumInput('irrelevant', OUTPUT_FULL),
      requirements: [
        { id: 'sum-big', description: 'sum(10,20)===30', testAnchors: ['sum(10,20)===30'] },
      ],
      sufficiency: { reviewer: 'opencode', decision: 'pass', reasons: [] },
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(/do not cover requirement/);
  });

  it('fluxo revisão→decisão→integração: misto bloqueia, puro com prova libera', () => {
    const mixedDecision = toSufficiencyDecision([
      { id: 'sum-req-3', demonstrated: false, missing: ['external evidence'], verdict: 'fail', reason: MIXED_EN },
    ]);
    expect(mixedDecision.decision).toBe('fail');
    const blocked = reviewJob({ ...sumInput(MIXED_EN), sufficiency: mixedDecision });
    expect(blocked.verdict).toBe('fail');
    expect(blocked.blocking).toBe(true);

    const pureDecision = toSufficiencyDecision([
      { id: 'sum-req-3', demonstrated: false, missing: ['external evidence'], verdict: 'fail', reason: PURE_R1 },
    ]);
    expect(pureDecision.decision).toBe('fail');
    const released = reviewJob({ ...sumInput(PURE_R1, OUTPUT_FULL), sufficiency: pureDecision });
    expect(released.verdict).toBe('pass');
    expect(released.blocking).toBe(false);
  });
});
