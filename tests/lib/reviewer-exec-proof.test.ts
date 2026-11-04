import { describe, it, expect } from 'bun:test';
import {
  reviewJob,
  parseTaskFileExecution,
  isCommandScopeComplaint,
  type ReviewInput,
  type ReviewVerdict,
} from '../../src/lib/reviewer';
import { toSufficiencyDecision } from '../../src/lib/opencode-reviewer';

// Achado B: `taskTestExecuted` aceitava nome do arquivo da tarefa + QUALQUER
// sinal de pass global — teste da tarefa em skip + teste de outro arquivo
// passando gerava pass indevido (razão "N pass across M files" descontada
// como escopo-de-comando). Correção: prova de execução VINCULADA — pass
// atribuído ao caminho completo do arquivo da tarefa (seção console
// `path:` com `(pass)`, ou `<testsuite>`/`<testcase>` junit); skip/todo/
// filtrado/falha = sem evidência; zero testes = sem evidência; saída
// parcial/ambígua = falta de evidência (fail-closed).
//
// EVIDÊNCIAS REAIS abaixo: capturadas de `bun 1.3.14 (0d9b296a)` em linux
// (x86_64), worktree descartável /tmp/opencode/execproof-fx, comandos:
//   bun test                                                    (condensado)
//   bun test -t "other"                                         (filtrada)
//   bun test --reporter=junit --reporter-outfile=<f>           (XML)
// `output` = console capturado + XML (como o orquestrador observa ambos).

const BUGGY_SUM = `export function sum(a: number, b: number): number { return a < 0 || b < 0 ? 0 : a + b; }\n`;
const FIXED_SUM = `export function sum(a: number, b: number): number { return a + b; }\n`;
const SKIP_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(1, 2)).toBe(3); });\ntest.skip("negative", () => { expect(sum(-4, -6)).toBe(-10); });\n`;
const FULL_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("positive", () => { expect(sum(1, 2)).toBe(3); });\ntest("negative", () => { expect(sum(-4, -6)).toBe(-10); });\n`;
const OTHER_TEST = `import { test, expect } from "bun:test";\ntest("other passes", () => { expect(1 + 1).toBe(2); });\n`;
const TODO_TEST = `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum";\ntest("sanity", () => { expect(sum(1, 2)).toBe(3); });\ntest.todo("remember negative case");\n`;

// Requisito comportamental (sem refs de código): o positivo executado cobre
// o local check mesmo com impl bugada — isola o gate em taskTestExecuted.
const NL_NEG = { id: 'sum-neg', description: 'somar entradas positivas e negativas', testAnchors: ['somar entradas positivas e negativas'] };

// Razão PURA de forma (descontável SOMENTE com prova vinculada).
const PURE = 'sum-req-3: observed output shows 2 pass across 2 files, not an isolated tests/sum.test.ts run; no direct evidence the anchored command passes — fail-closed';

// --- real: `bun test` (buggy + skip + other passando) ---
const REAL_RED_CONSOLE = `bun test v1.3.14 (0d9b296a)

 2 pass
 1 skip
 0 fail
 2 expect() calls
Ran 3 tests across 2 files. [12.00ms]
`;
const REAL_RED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="2" failures="0" skipped="1" time="0.012013633">
  <testsuite name="tests/other.test.ts" file="tests/other.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="localhost.localdomain">
    <testcase name="other passes" classname="" time="0.00005" file="tests/other.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="tests/sum.test.ts" file="tests/sum.test.ts" tests="2" assertions="1" failures="0" skipped="1" time="0" hostname="localhost.localdomain">
    <testcase name="positive" classname="" time="0.000045" file="tests/sum.test.ts" line="3" assertions="1" />
    <testcase name="negative" classname="" time="0" file="tests/sum.test.ts" line="4" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
`;

// --- real: `bun test` (fixed + tudo passando) ---
const REAL_GREEN_CONSOLE = `bun test v1.3.14 (0d9b296a)

 3 pass
 0 fail
 3 expect() calls
Ran 3 tests across 2 files. [12.00ms]
`;
const REAL_GREEN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="3" failures="0" skipped="0" time="0.012780284">
  <testsuite name="tests/other.test.ts" file="tests/other.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="localhost.localdomain">
    <testcase name="other passes" classname="" time="0.000058" file="tests/other.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="tests/sum.test.ts" file="tests/sum.test.ts" tests="2" assertions="2" failures="0" skipped="0" time="0" hostname="localhost.localdomain">
    <testcase name="positive" classname="" time="0.000053" file="tests/sum.test.ts" line="3" assertions="1" />
    <testcase name="negative" classname="" time="0.000031" file="tests/sum.test.ts" line="4" assertions="1" />
  </testsuite>
</testsuites>
`;

// --- real: `bun test -t "other"` (tarefa filtrada = skipped no junit) ---
const REAL_FILTERED_CONSOLE = `bun test v1.3.14 (0d9b296a)

 1 pass
 2 filtered out
 0 fail
 1 expect() calls
Ran 1 test across 2 files. [12.00ms]
`;
const REAL_FILTERED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="1" failures="0" skipped="2" time="0.012231903">
  <testsuite name="tests/other.test.ts" file="tests/other.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="localhost.localdomain">
    <testcase name="other passes" classname="" time="0.000078" file="tests/other.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="tests/sum.test.ts" file="tests/sum.test.ts" tests="2" assertions="0" failures="0" skipped="2" time="0" hostname="localhost.localdomain">
    <testcase name="positive" classname="" time="0" file="tests/sum.test.ts" line="3" assertions="0">
      <skipped />
    </testcase>
    <testcase name="negative" classname="" time="0" file="tests/sum.test.ts" line="4" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
`;

// --- real: colisão de basename (tests/a/sum.test.ts skip-only, tests/b/sum.test.ts pass) ---
const REAL_COLLISION_CONSOLE = `bun test v1.3.14 (0d9b296a)

 1 pass
 1 skip
 0 fail
 1 expect() calls
Ran 2 tests across 2 files. [12.00ms]
`;
const REAL_COLLISION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="1" failures="0" skipped="1" time="0.012016073">
  <testsuite name="tests/b/sum.test.ts" file="tests/b/sum.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="localhost.localdomain">
    <testcase name="other b passes" classname="" time="0.00006" file="tests/b/sum.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="tests/a/sum.test.ts" file="tests/a/sum.test.ts" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="localhost.localdomain">
    <testcase name="negative a" classname="" time="0" file="tests/a/sum.test.ts" line="3" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
`;

// --- real: test.todo vira `<skipped message="TODO"/>` (prova de não-execução) ---
const REAL_TODO_CONSOLE = `bun test v1.3.14 (0d9b296a)

 3 pass
 1 skip
 1 todo
 0 fail
 3 expect() calls
Ran 5 tests across 3 files. [16.00ms]
`;
const REAL_TODO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="3" failures="0" skipped="2" time="0.014194446">
  <testsuite name="tests/todo.test.ts" file="tests/todo.test.ts" tests="2" assertions="1" failures="0" skipped="1" time="0" hostname="localhost.localdomain">
    <testcase name="remember negative case" classname="" time="0" file="tests/todo.test.ts" line="2" assertions="0">
      <skipped message="TODO"/>
    </testcase>
    <testcase name="sanity" classname="" time="0.00006" file="tests/todo.test.ts" line="3" assertions="1"/>
  </testsuite>
  <testsuite name="tests/sum.test.ts" file="tests/sum.test.ts" tests="2" assertions="1" failures="0" skipped="1" time="0" hostname="localhost.localdomain">
    <testcase name="positive" classname="" time="0.000071" file="tests/sum.test.ts" line="3" assertions="1"/>
    <testcase name="negative" classname="" time="0" file="tests/sum.test.ts" line="4" assertions="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>
`;

// --- real: zero testes (`bun test` em dir vazio) ---
const REAL_ZERO_OUTPUT = `bun test v1.3.14 (0d9b296a)
error: 0 test files matching **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx} in --cwd="/tmp/opencode/execproof-fx/emptydir"
`;

// --- real: falha lista o arquivo (`tests/failing.test.ts:` + `(fail)`) ---
const REAL_FAILURE_OUTPUT = `bun test v1.3.14 (0d9b296a)

tests/failing.test.ts:
1 | import { test, expect } from "bun:test";
2 | test("boom", () => { expect(1).toBe(2); });
                                   ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/opencode/execproof-fx/tests/failing.test.ts:2:32)
(fail) boom [0.13ms]

 3 pass
 1 fail
 4 expect() calls
Ran 4 tests across 3 files. [12.00ms]
`;

// Formato console legado (bun antigo listava arquivos/casos — mesma convenção
// das fixtures G4/P2 existentes): múltiplos arquivos mistos.
const LEGACY_MIXED_CONSOLE = `bun test v1.3.14
tests/sum.test.ts:
(pass) positive [2ms]
(pass) negative [1ms]
tests/other.test.ts:
(pass) other [0ms]
(skip) slow [0ms]
 3 pass
 1 skip
 0 fail
Ran 4 tests across 2 files.
`;
const LEGACY_TASK_SKIP_CONSOLE = `bun test v1.3.14
tests/sum.test.ts:
(pass) positive [2ms]
(skip) negative [0ms]
tests/other.test.ts:
(pass) other [0ms]
 2 pass
 1 skip
 0 fail
Ran 3 tests across 2 files.
`;

function execProofInput(over: Partial<ReviewInput> & { output: string; externalReason: string }): ReviewInput {
  return {
    jobName: 'sum',
    jobBranch: 'feature-sum',
    baseBranch: 'main',
    baseHead: 'base-1',
    jobHead: 'job-1',
    changedFiles: ['src/sum.ts', 'tests/sum.test.ts'],
    touchSet: ['src/sum.ts', 'tests/sum.test.ts'],
    requirements: [NL_NEG],
    fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/sum.test.ts': SKIP_TEST, 'tests/other.test.ts': OTHER_TEST },
    testPaths: ['tests/sum.test.ts'],
    evidence: {
      command: 'bun test --reporter=junit --reporter-outfile=/tmp/junit.xml',
      exitCode: 0,
      output: over.output,
      testedCommit: 'job-1',
      environment: 'worktree:/tmp/opencode/execproof-fx (bun 1.3.14, linux)',
    },
    claimedPass: true,
    sufficiency: { reviewer: 'opencode', decision: 'fail', reasons: [over.externalReason] },
    requireExternalSufficiency: true,
    ...over,
  } as ReviewInput;
}

/** Espelha o gate de integração: merge só com pass não-bloqueante. */
function mergeBlockedBy(v: ReviewVerdict): boolean {
  return v.verdict !== 'pass' || v.blocking;
}

describe('Achado B: prova de execução vinculada ao arquivo da tarefa', () => {
  it('classificador ainda trata razão pura de forma como command-scope', () => {
    expect(isCommandScopeComplaint(PURE)).toBe(true);
  });

  it('RED: skip na tarefa + outro passando (junit real) → FAIL bloqueante, sem desconto', () => {
    const verdict = reviewJob(execProofInput({ output: `${REAL_RED_CONSOLE}\n${REAL_RED_XML}`, externalReason: PURE }));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/no proof|not.*execut/i);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
    expect(mergeBlockedBy(verdict)).toBe(true);
  });

  it('todo na tarefa (skipped message=TODO real) → FAIL bloqueante', () => {
    const verdict = reviewJob(
      execProofInput({
        output: `${REAL_TODO_CONSOLE}\n${REAL_TODO_XML}`,
        externalReason: PURE,
        testPaths: ['tests/todo.test.ts'],
        fileContents: { 'src/sum.ts': BUGGY_SUM, 'tests/todo.test.ts': TODO_TEST },
        changedFiles: ['src/sum.ts', 'tests/todo.test.ts'],
        touchSet: ['src/sum.ts', 'tests/todo.test.ts'],
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('zero testes (exit 1 + erro real) → FAIL bloqueante, sem evidência', () => {
    const verdict = reviewJob(
      execProofInput({
        output: REAL_ZERO_OUTPUT,
        externalReason: PURE,
        evidence: {
          command: 'bun test',
          exitCode: 1,
          output: REAL_ZERO_OUTPUT,
          testedCommit: 'job-1',
          environment: 'worktree:/tmp/opencode/execproof-fx/emptydir (bun 1.3.14, linux)',
        },
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect(parseTaskFileExecution(REAL_ZERO_OUTPUT)).toEqual([]);
  });

  it('basename igual em dirs diferentes: tarefa tests/a (skip-only real) → FAIL', () => {
    const verdict = reviewJob(
      execProofInput({
        output: `${REAL_COLLISION_CONSOLE}\n${REAL_COLLISION_XML}`,
        externalReason: PURE,
        testPaths: ['tests/a/sum.test.ts'],
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('basename igual em dirs diferentes: tarefa tests/b (pass real) liga ao caminho certo', () => {
    const tripleImpl = `export function triple(n: number): number { return n * 3; }\n`;
    const tripleTest = `import { test, expect } from "bun:test";\nimport { triple } from "../../src/b";\ntest("other b passes", () => { expect(triple(2)).toBe(6); });\n`;
    const verdict = reviewJob(
      execProofInput({
        output: `${REAL_COLLISION_CONSOLE}\n${REAL_COLLISION_XML}`,
        externalReason: 'tests/b/sum-req-3: observed output shows 1 pass across 2 files, not an isolated run; no direct evidence the anchored command passes — fail-closed',
        requirements: [{ id: 'b-triple', description: 'triplicar valores de entrada', testAnchors: ['triplicar valores de entrada'] }],
        fileContents: { 'src/b.ts': tripleImpl, 'tests/b/sum.test.ts': tripleTest },
        changedFiles: ['src/b.ts', 'tests/b/sum.test.ts'],
        touchSet: ['src/b.ts', 'tests/b/sum.test.ts'],
        testPaths: ['tests/b/sum.test.ts'],
      }),
    );
    expect(isCommandScopeComplaint('observed output shows 1 pass across 2 files, not an isolated run')).toBe(true);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
    expect((verdict.audit ?? []).join(' ')).toMatch(/discounted/i);
  });

  it('múltiplos arquivos mistos (console legado): tarefa limpa → evidência; tarefa com skip → sem evidência', () => {
    const clean = reviewJob(execProofInput({ output: LEGACY_MIXED_CONSOLE, externalReason: PURE }));
    expect(clean.verdict).toBe('pass');
    expect(clean.blocking).toBe(false);
    const tainted = reviewJob(execProofInput({ output: LEGACY_TASK_SKIP_CONSOLE, externalReason: PURE }));
    expect(tainted.verdict).toBe('fail');
    expect(tainted.blocking).toBe(true);
  });

  it('suite filtrada real (tarefa filtrada = skipped no junit) → FAIL bloqueante', () => {
    const verdict = reviewJob(execProofInput({ output: `${REAL_FILTERED_CONSOLE}\n${REAL_FILTERED_XML}`, externalReason: PURE }));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
    expect((verdict.audit ?? []).join(' ')).not.toMatch(/discounted/i);
  });

  it('tarefa executada-e-passando (junit real, zero skip) + razão pura → PASS com audit (G4 preservado)', () => {
    const verdict = reviewJob(
      execProofInput({
        output: `${REAL_GREEN_CONSOLE}\n${REAL_GREEN_XML}`,
        externalReason: PURE,
        fileContents: { 'src/sum.ts': FIXED_SUM, 'tests/sum.test.ts': FULL_TEST, 'tests/other.test.ts': OTHER_TEST },
      }),
    );
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blocking).toBe(false);
    expect(mergeBlockedBy(verdict)).toBe(false);
    expect((verdict.audit ?? []).join(' ')).toMatch(/discounted/i);
  });

  it('saída condensada sem atribuição (só contagens) nunca é prova, mesmo citando o arquivo', () => {
    const condensed = `bun test v1.3.14 (0d9b296a)\n\n 2 pass\n 1 skip\n 0 fail\nRan 3 tests across 2 files.\n`;
    const verdict = reviewJob(execProofInput({ output: condensed, externalReason: PURE }));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
  });

  it('caminho revisão→integração: bloqueado barra merge; liberado libera', () => {
    const blocked = reviewJob(execProofInput({ output: `${REAL_RED_CONSOLE}\n${REAL_RED_XML}`, externalReason: PURE }));
    expect(mergeBlockedBy(blocked)).toBe(true);
    const released = reviewJob(
      execProofInput({
        output: `${REAL_GREEN_CONSOLE}\n${REAL_GREEN_XML}`,
        externalReason: PURE,
        fileContents: { 'src/sum.ts': FIXED_SUM, 'tests/sum.test.ts': FULL_TEST, 'tests/other.test.ts': OTHER_TEST },
      }),
    );
    expect(mergeBlockedBy(released)).toBe(false);
    const viaDecision = toSufficiencyDecision([
      { id: 'sum-req-3', demonstrated: false, missing: ['external evidence'], verdict: 'fail', reason: PURE },
    ]);
    expect(viaDecision.decision).toBe('fail');
    const blocked2 = reviewJob(execProofInput({ output: `${REAL_RED_CONSOLE}\n${REAL_RED_XML}`, externalReason: 'unused', sufficiency: viaDecision }));
    expect(mergeBlockedBy(blocked2)).toBe(true);
  });
});

describe('parseTaskFileExecution: estrutura por arquivo/caso/status', () => {
  it('junit real: pass e skip por arquivo', () => {
    const entries = parseTaskFileExecution(`${REAL_RED_CONSOLE}\n${REAL_RED_XML}`);
    const sum = entries.filter((e) => e.file === 'tests/sum.test.ts');
    expect(sum.reduce((n, e) => n + e.pass, 0)).toBe(1);
    expect(sum.reduce((n, e) => n + e.skip, 0)).toBe(1);
    const other = entries.filter((e) => e.file === 'tests/other.test.ts');
    expect(other.reduce((n, e) => n + e.pass, 0)).toBe(1);
    expect(other.reduce((n, e) => n + e.skip, 0)).toBe(0);
  });

  it('falha real: seção console com (fail) atribuído ao arquivo', () => {
    const entries = parseTaskFileExecution(REAL_FAILURE_OUTPUT);
    const failing = entries.filter((e) => e.file === 'tests/failing.test.ts');
    expect(failing.length).toBe(1);
    expect(failing[0]!.fail).toBe(1);
    expect(failing[0]!.pass).toBe(0);
  });

  it('condensado sem seções: nenhuma evidência vinculada', () => {
    expect(parseTaskFileExecution('bun test v1.3.14\n\n 2 pass\n 0 fail\nRan 2 tests across 2 files.\n')).toEqual([]);
    expect(parseTaskFileExecution('')).toEqual([]);
  });

  it('basename ambíguo (dois dirs, tarefa sem path) não vira prova do arquivo errado', () => {
    const verdict = reviewJob(
      execProofInput({
        output: `${REAL_COLLISION_CONSOLE}\n${REAL_COLLISION_XML}`,
        externalReason: PURE,
        testPaths: ['sum.test.ts'],
      }),
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blocking).toBe(true);
  });
});
