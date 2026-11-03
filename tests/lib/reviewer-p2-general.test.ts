import { describe, it, expect } from 'bun:test';
import { reviewJob, isCommandScopeComplaint, partitionExternalReasons, type ReviewInput, type ReviewVerdict } from '../../src/lib/reviewer';
import { toSufficiencyDecision } from '../../src/lib/opencode-reviewer';

// P2-GENERAL: a causa geral do falso-pass não é uma palavra faltando no regex,
// e sim o formato da decisão: qualquer objeção funcional embutida em linguagem
// de comando era descontada por denylist de palavras-chave. O contrato novo:
// mensagem mista/ambígua com objeção funcional NUNCA vira aprovação por forma
// textual (fail-closed); desconto só para razão PURA de forma + prova de que
// os testes da tarefa executaram (registro observado do runner, não nome de
// arquivo como texto); teste pulado (skip) nunca exercita a tarefa.

const BUGGY_SUM = `export function sum(a: number, b: number): number { return a < 0 || b < 0 ? 0 : a + b; }\n`;
const FIXED_SUM = `export function sum(a: number, b: number): number { return a + b; }\n`;
const THIN_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(2, 3)).toBe(5); });\n`;
const FULL_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(2, 3)).toBe(5); });\ntest("negative", () => { expect(sum(-2, -3)).toBe(-5); });\ntest("zero", () => { expect(sum(0, 0)).toBe(0); });\n`;
// Negativo existe no arquivo mas NUNCA executa (skip): não exercita a tarefa.
const SKIP_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(1, 2)).toBe(3); });\ntest.skip("negative", () => { expect(sum(-4, -6)).toBe(-10); });\n`;
const DESCRIBE_SKIP_TEST = `import { describe, test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(1, 2)).toBe(3); });\ndescribe.skip("negatives", () => { test("negative", () => { expect(sum(-4, -6)).toBe(-10); }); });\n`;
// Testa outra coisa: nunca chama a implementação da tarefa.
const UNRELATED_TEST = `import { test, expect } from "bun:test";\ntest("arithmetic", () => { expect(1 + 1).toBe(2); });\ntest("strings", () => { expect("a" + "b").toBe("ab"); });\n`;

const OUTPUT_THIN = `bun test v1.3.14\ntests/sum.test.ts:\n(pass) positive [2ms]\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file.\n`;
const OUTPUT_FULL = `bun test v1.3.14\ntests/sum.test.ts:\n(pass) positive [2ms]\n(pass) negative [1ms]\n(pass) zero [1ms]\n 3 pass\n 0 fail\n 3 expect() calls\nRan 3 tests across 1 file.\n`;
const OUTPUT_SKIP = `bun test v1.3.14\ntests/sum.test.ts:\n(pass) positive [2ms]\n(skip) negative [0ms]\n 1 pass\n 1 skip\n 0 fail\n 1 expect() calls\nRan 2 tests across 1 file.\n`;
// Comando cita o arquivo, mas a saída observada NÃO registra execução dele:
// nome de arquivo como texto não é prova (P2-general).
const OUTPUT_FILENAME_ONLY_IN_COMMAND = `1 pass\n0 fail\n1 expect() calls\nRan 1 test.\n`;

// Caso EXATO da revisão: sem "across N files" — só "observed output shows".
const EXACT = 'sum-neg: observed output shows 1 pass; the implementation returns zero for inputs below zero';

const EN_VARIANTS = [
  'sum-neg: observed output shows 1 pass across 1 file; sum returns 0 for negative inputs',
  'sum-neg: observed output shows 2 pass across 1 file but sum(-1,-2) gives 0 instead of -3',
  'sum-neg: observed output shows 1 pass; expected -5 but got 0 for sum(-2,-3)',
  'sum-neg: isolated run shows 1 pass across 1 file; tests miss the negative case entirely',
  'sum-neg: command-specific evidence: 1 pass in 1 file, yet negatives behave incorrectly',
  'sum-neg: observed output shows 3 pass across 2 files; wrong result for inputs below zero',
  'sum-neg: anchored command run reports 1 pass across 1 file; the negative branch is never exercised',
];

const PT_VARIANTS = [
  'sum-neg: observed output shows 1 pass; implementação retorna zero para entradas negativas',
  'sum-neg: observed output shows 2 pass; esperado -5 mas obteve 0 para entradas negativas',
  'sum-neg: saída observada mostra 1 passe; resultado incorreto para valores abaixo de zero',
  'sum-neg: observed output shows 1 pass across 1 file; faltando cobertura para entradas negativas',
  'sum-neg: observed output shows 1 pass; comportamento incorreto não coberto pelos testes',
];

// Sem nenhuma palavra da denylist antiga: a correção geral não depende de vocabulário.
const KEYWORD_FREE_VARIANTS = [
  'sum-neg: observed output shows 1 pass; sum maps (-2,-3) to 0',
  'sum-neg: observed output shows 1 pass across 1 file; (-2,-3) yields 0',
  'sum-neg: observed output shows 1 pass; soma de (-2,-3) resulta em 0',
  'sum-neg: observed output shows 1 pass across 1 file; only positives verified',
];

const PURE_COMMAND_SHAPE = [
  'sum-req-3: observed output shows 4 pass across 2 files, not an isolated run',
  'command-specific pass not demonstrated',
  'no direct evidence the anchored command passes',
  'sum-req-3: observed output shows 4 pass across 2 files, not an isolated tests/sum.test.ts run with 3 tests across 1 file; no direct evidence the anchored command passes — fail-closed',
];

const NL_NEG = { id: 'sum-neg', description: 'somar entradas positivas e negativas', testAnchors: ['somar entradas positivas e negativas'] };
const CODE_NEG = { id: 'sum-neg', description: 'sum(-4,-6) === -10', testAnchors: ['sum(-4,-6) === -10'] };

function sumInput(over: Partial<ReviewInput> & { externalReason: string; command?: string; output?: string }): ReviewInput {
  return {
    jobName: 'sum',
    jobBranch: 'feature-sum',
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles: ['src/sum.ts', 'tests/sum.test.ts'],
    touchSet: ['src/sum.ts', 'tests/sum.test.ts'],
    requirements: [NL_NEG],
    fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/sum.test.ts': THIN_TEST },
    testPaths: ['tests/sum.test.ts'],
    evidence: {
      command: over.command ?? 'bun test',
      exitCode: 0,
      output: over.output ?? OUTPUT_THIN,
      testedCommit: 'job-1',
      environment: 'worktree:/tmp/x (bun 1.3.14, linux)',
    },
    claimedPass: true,
    sufficiency: { reviewer: 'opencode', decision: 'fail', reasons: [over.externalReason] },
    requireExternalSufficiency: true,
    ...over,
  } as ReviewInput;
}

/** Espelha o gate de integração (orchestrator: merge só com pass não-bloqueante). */
function mergeBlockedBy(v: ReviewVerdict): boolean {
  return v.verdict !== 'pass' || v.blocking;
}

describe('P2-general: objeção funcional nunca vira pass por forma textual', () => {
  it('classificador: caso EXATO (returns zero … below zero) é funcional (false)', () => {
    expect(isCommandScopeComplaint(EXACT)).toBe(false);
  });

  it('classificador: redações EN variadas são funcionais (false)', () => {
    for (const r of EN_VARIANTS) expect(isCommandScopeComplaint(r)).toBe(false);
  });

  it('classificador: redações PT variadas são funcionais (false)', () => {
    for (const r of PT_VARIANTS) expect(isCommandScopeComplaint(r)).toBe(false);
  });

  it('classificador: sem palavra-chave da denylist antiga, continua funcional (false)', () => {
    for (const r of KEYWORD_FREE_VARIANTS) expect(isCommandScopeComplaint(r)).toBe(false);
  });

  it('classificador: pura forma de comando continua command-scope (true)', () => {
    for (const r of PURE_COMMAND_SHAPE) expect(isCommandScopeComplaint(r)).toBe(true);
  });

  it('partition: mistas vão para o balde funcional', () => {
    const parts = partitionExternalReasons([EXACT, ...EN_VARIANTS.slice(0, 2), PURE_COMMAND_SHAPE[0]!]);
    expect(parts.functional).toContain(EXACT);
    expect(parts.functional).toHaveLength(3);
    expect(parts.commandScope).toHaveLength(1);
  });

  it('reviewJob: caso EXATO → FAIL bloqueante, sem audit de desconto', () => {
    const verdict = reviewJob(sumInput({ externalReason: EXACT }));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(mergeBlockedBy(verdict)).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/zero|below zero/i);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('reviewJob: variantes EN/PT com objeção funcional → FAIL bloqueante', () => {
    for (const r of [...EN_VARIANTS, ...PT_VARIANTS, ...KEYWORD_FREE_VARIANTS]) {
      const verdict = reviewJob(sumInput({ externalReason: r }));
      expect(verdict.verdict).toBe('fail');
      expect(verdict.blocking).toBe(true);
      expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
    }
  });

  it('reviewJob: teste pulado (test.skip) não exercita a tarefa → FAIL', () => {
    const verdict = reviewJob(
      sumInput({
        externalReason: 'sum-neg: observed output shows 2 pass across 1 file, not an isolated run',
        requirements: [CODE_NEG],
        fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/sum.test.ts': SKIP_TEST },
        output: OUTPUT_SKIP,
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join('\n')).toMatch(/skip|do not cover requirement/i);
  });

  it('reviewJob: describe.skip também não executa → FAIL', () => {
    const verdict = reviewJob(
      sumInput({
        externalReason: 'sum-neg: observed output shows 2 pass across 1 file, not an isolated run',
        requirements: [CODE_NEG],
        fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/sum.test.ts': DESCRIBE_SKIP_TEST },
        output: OUTPUT_SKIP,
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
  });

  it('reviewJob: teste que não chama a implementação → FAIL', () => {
    const verdict = reviewJob(
      sumInput({
        externalReason: 'sum-neg: tests never cover the negative case',
        requirements: [CODE_NEG],
        fileContents: { 'src/sum.ts': FIXED_SUM, 'tests/sum.test.ts': UNRELATED_TEST },
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join('\n')).toMatch(/do not cover requirement/);
  });

  it('reviewJob: comportamento incorreto sem cobertura bloqueia mesmo com externo pass', () => {
    const verdict = reviewJob(
      sumInput({
        externalReason: 'irrelevant',
        requirements: [CODE_NEG],
        fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/sum.test.ts': THIN_TEST },
        sufficiency: { reviewer: 'opencode', decision: 'pass', reasons: [] },
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join('\n')).toMatch(/do not cover requirement/);
  });

  it('reviewJob: arquivo citado só no comando (sem registro no output) não prova execução → FAIL', () => {
    const verdict = reviewJob(
      sumInput({
        externalReason: PURE_COMMAND_SHAPE[0]!,
        requirements: [
          { id: 'sum-req-1', description: 'src/sum.ts exports sum returning a+b', testAnchors: ['src/sum.ts exports sum returning a+b'] },
          { id: 'sum-req-2', description: 'tests/sum.test.ts has at least 1 case', testAnchors: ['tests/sum.test.ts has at least 1 case'] },
          { id: 'sum-req-3', description: 'bun test tests/sum.test.ts passes', testAnchors: ['bun test tests/sum.test.ts passes'] },
        ],
        fileContents: { 'src/sum.ts': FIXED_SUM, 'tests/sum.test.ts': FULL_TEST },
        command: 'bun test tests/sum.test.ts',
        output: OUTPUT_FILENAME_ONLY_IN_COMMAND,
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/no proof|not.*execut/i);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('reviewJob: entrega correta + pura forma + prova de execução → PASS com audit (guarda G4)', () => {
    const verdict = reviewJob(
      sumInput({
        externalReason: PURE_COMMAND_SHAPE[3]!,
        requirements: [
          { id: 'sum-req-1', description: 'src/sum.ts exports sum returning a+b', testAnchors: ['src/sum.ts exports sum returning a+b'] },
          { id: 'sum-req-2', description: 'tests/sum.test.ts has at least 1 case', testAnchors: ['tests/sum.test.ts has at least 1 case'] },
          { id: 'sum-req-3', description: 'bun test tests/sum.test.ts passes', testAnchors: ['bun test tests/sum.test.ts passes'] },
        ],
        fileContents: { 'src/sum.ts': FIXED_SUM, 'tests/sum.test.ts': FULL_TEST },
        output: OUTPUT_FULL,
      }),
    );
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
    expect(mergeBlockedBy(verdict)).toBe(false);
    expect((verdict.audit ?? []).join(' ')).toMatch(/discounted/i);
  });

  it('caminho revisão→integração: veredito fail bloqueia merge; pass libera', () => {
    const blocked = reviewJob(sumInput({ externalReason: EXACT }));
    expect(blocked.verdict).toBe('fail');
    expect(mergeBlockedBy(blocked)).toBe(true);

    const viaDecision = toSufficiencyDecision([
      { id: 'sum-neg', demonstrated: false, missing: ['external evidence'], verdict: 'fail', reason: EXACT },
    ]);
    expect(viaDecision.decision).toBe('fail');
    const blocked2 = reviewJob(sumInput({ externalReason: 'unused', sufficiency: viaDecision }));
    expect(blocked2.verdict).toBe('fail');
    expect(mergeBlockedBy(blocked2)).toBe(true);
  });
});
