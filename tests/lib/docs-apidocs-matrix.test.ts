import { describe, it, expect } from 'bun:test';
/**
 * OBJETIVO 1 (lane-apidocs): matriz de bloqueio sem enfraquecer rejeição.
 *
 * Causa-raiz M7 (api-docs @ 7762a146, base 45ba8c0e):
 * - doc CORRETA bloqueada por vocabulário/formato, não por incorreção:
 *   (a) pre-ef4ef45, GLOBAL_PLACEHOLDER/DENIAL casava "todo 0"/"fail 0" do
 *   `node --test` colado em fence (quote começava com "``` ▶ clamp");
 *   (b) pós-ef4ef45, keyword "cont" (fragmento ASCII de "contém") 0/1
 *   not-covered — doc com BK-M7 + tabelas não repete o verbo do critério;
 *   (c) falta sentença instrutiva: tabelas descritivas sem verbo procedural
 *   dão inconclusive, e o gate de execução exigia heuristic covered mesmo
 *   com evidência válida + veredito semântico pass.
 * - Revisão semântica + executedEvidence TINHAM contexto (git show jobHead,
 *   siblings read-only, testedCommit==jobHead), mas a heurística not-covered
 *   nunca é sobrescrita e evidência não resgata doc incorreta — correto, o
 *   falso-positivo era heurístico.
 * - Operador aprovou com ressalva: plan.json job.reviewApproval pin
 *   7762a146/base 45ba8c0e kind accept actor agent-operator (não-humano) +
 *   runtime-state decisions + final-report accept gaps; mergeEvidence
 *   scope=integration (sem task-scoped) → permanece Unverified, sem selo
 *   verified; Verified exclui aceites via excludeAcceptedFromVerified.
 */
import {
  assessDocsCoverage,
  assessDocsCoverageWithSemantics,
} from '../../src/lib/docs-review';

// Doc correta PT (espelha /tmp/opencode/m7-target/docs/api.md: BK-M7,
// tabelas exatas, `node --test` + saída colada em fence).
const CORRECT_PT = `# API

BK-M7

## clamp(value, min, max)

Limita \`value\` ao intervalo \`[min, max]\`. Lança \`TypeError\` se algum argumento não for número finito.

| Entrada | Saída exata |
|---|---|
| \`clamp(-5, 0, 10)\` | \`0\` |
| \`clamp(15, 0, 10)\` | \`10\` |
| \`clamp(5, 0, 10)\` | \`5\` |

## summarize(values, min, max)

Retorna \`{ original, clamped, min, max }\`, com cada item de \`values\` passado por \`clamp\`.

| Entrada | Saída exata |
|---|---|
| \`summarize([1, 2, 3], 0, 2)\` | \`{ original: [1, 2, 3], clamped: [1, 2, 2], min: 0, max: 2 }\` |

## Verificação

\`node --test\` com exit 0. Saída verbatim:

\`\`\`
▶ clamp
  ✔ returns min when below minimum (0.75ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ todo 0
EXIT=0
\`\`\`
`;

// Doc correta EN (mesma estrutura, sem "contém").
const CORRECT_EN = `# API

BK-M7

## clamp(value, min, max)

Limits \`value\` to \`[min, max]\`. Throws \`TypeError\` for non-finite input.

| Input | Exact output |
|---|---|
| \`clamp(-5, 0, 10)\` | \`0\` |
| \`clamp(15, 0, 10)\` | \`10\` |

## Verification

\`node --test\` with exit 0. Verbatim output:

\`\`\`
▶ clamp
  ✔ returns min when below minimum (0.75ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ todo 0
EXIT=0
\`\`\`
`;

const REQ_STAMP = { id: 'api-docs-req-1', description: 'doc contém verbatim o stamp BK-M7' };
const REQ_EXEC = {
  id: 'api-docs-req-2',
  description: 'node --test passa com exit 0 e a saída da execução está colada verbatim no doc',
};
const JOB_HEAD = '7762a1462fb1cf0b6b750dc37f126dd95fd9e989';
const VALID_EVIDENCE = {
  command: 'node --test',
  exitCode: 0,
  output: '▶ clamp\n  ✔ returns min (0.75ms)\nℹ tests 5\nℹ pass 5\nℹ fail 0',
  testedCommit: JOB_HEAD,
  environment: 'worktree:/tmp/x (node v22, linux)',
  dirty: false as const,
};
const SEM_PASS_STAMP = {
  verdict: 'pass' as const,
  demonstrated: true,
  evidence: ['BK-M7', '| `clamp(-5, 0, 10)` | `0` |'],
  reason: 'Docs contain BK-M7 verbatim and document clamp/summarize with exact I/O tables.',
};
const SEM_PASS_EXEC = {
  verdict: 'pass' as const,
  demonstrated: true,
  evidence: ['`node --test` com exit 0', '▶ clamp'],
  reason: 'Docs document the test command and paste the execution output verbatim with exit 0.',
};

describe('apidocs matrix: correct PT/EN pass, incomplete/wrong/stale fail, accept never Verified', () => {
  it('doc correta PT passa (stamp + execução com evidência válida + semântico pass)', () => {
    const r1 = assessDocsCoverageWithSemantics(REQ_STAMP, { 'docs/api.md': CORRECT_PT }, SEM_PASS_STAMP);
    expect(r1.covered).toBe(true);
    expect(r1.status).toBe('covered');
    const r2 = assessDocsCoverageWithSemantics(REQ_EXEC, { 'docs/api.md': CORRECT_PT }, SEM_PASS_EXEC, {
      executedEvidence: VALID_EVIDENCE,
      jobHead: JOB_HEAD,
    });
    expect(r2.covered).toBe(true);
    expect(r2.status).toBe('covered');
  });

  it('doc correta EN passa (sem "contém": sem veto de vocabulário)', () => {
    const EN_STAMP = { id: 'api-docs-req-1', description: 'doc contains verbatim stamp BK-M7' };
    const EN_EXEC = {
      id: 'api-docs-req-2',
      description: 'API documents clamp with exact tables and node --test exit 0 output pasted verbatim',
    };
    const r1 = assessDocsCoverageWithSemantics(EN_STAMP, { 'docs/api.md': CORRECT_EN }, SEM_PASS_STAMP);
    expect(r1.covered).toBe(true);
    const r2 = assessDocsCoverageWithSemantics(EN_EXEC, { 'docs/api.md': CORRECT_EN }, SEM_PASS_EXEC, {
      executedEvidence: VALID_EVIDENCE,
      jobHead: JOB_HEAD,
    });
    expect(r2.covered).toBe(true);
  });

  it('heurística não veta vocabulário do critério ("cont" de "contém"): sem BK-M7 ausente, status nunca é not-covered por keyword', () => {
    const r = assessDocsCoverage(REQ_STAMP, { 'docs/api.md': CORRECT_PT });
    // Correta sem repetir "contém": antes era not-covered "0/1 (need 1: cont)";
    // agora no máximo inconclusive (falta verbo instrutivo), nunca veto de tópico.
    expect(r.reason).not.toMatch(/need 1: cont\b/);
    expect(r.status).not.toBe('not-covered');
  });

  it('doc descritiva adequada passa via semântico (tabelas + detalhe concreto, sem verbo imperativo)', () => {
    // CORRECT_PT não tem verbo procedural ("verifique/run"); a heurística sozinha
    // fica inconclusive fail-closed, mas com semântico pass + evidência vira covered.
    const h = assessDocsCoverage(REQ_EXEC, { 'docs/api.md': CORRECT_PT });
    expect(h.covered).toBe(false);
    expect(h.status).toBe('inconclusive');
    const r = assessDocsCoverageWithSemantics(REQ_EXEC, { 'docs/api.md': CORRECT_PT }, SEM_PASS_EXEC, {
      executedEvidence: VALID_EVIDENCE,
      jobHead: JOB_HEAD,
    });
    expect(r.covered).toBe(true);
  });

  it('doc incompleta falha (sem BK-M7; sem tabela): evidência válida + semântico pass não resgatam', () => {
    const noStamp = CORRECT_PT.replace('BK-M7', 'sem stamp aqui');
    const rMissing = assessDocsCoverageWithSemantics(REQ_STAMP, { 'docs/api.md': noStamp }, SEM_PASS_STAMP);
    expect(rMissing.covered).toBe(false);
    expect(rMissing.status).toBe('not-covered');
    expect(rMissing.reason).toMatch(/BK-M7|verbatim/i);
    // Exec sem literal "0" colado: remove tabelas e saída.
    const bare = '# API\nBK-M7\nDoc curta sem exemplos nem saída.\n';
    const rBare = assessDocsCoverageWithSemantics(
      REQ_EXEC,
      { 'docs/api.md': bare },
      SEM_PASS_EXEC,
      { executedEvidence: VALID_EVIDENCE, jobHead: JOB_HEAD },
    );
    expect(rBare.covered).toBe(false);
  });

  it('evidência ausente/desatualizada falha (sem reescrita pedida para ausente; re-executar para stale/dirty)', () => {
    const rAbsent = assessDocsCoverageWithSemantics(REQ_EXEC, { 'docs/api.md': CORRECT_PT }, SEM_PASS_EXEC, {
      jobHead: JOB_HEAD,
    });
    expect(rAbsent.covered).toBe(false);
    expect(rAbsent.reason).toMatch(/executed evidence|execute e reapresente/i);
    const stale = { ...VALID_EVIDENCE, testedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    const rStale = assessDocsCoverageWithSemantics(REQ_EXEC, { 'docs/api.md': CORRECT_PT }, SEM_PASS_EXEC, {
      executedEvidence: stale,
      jobHead: JOB_HEAD,
    });
    expect(rStale.covered).toBe(false);
    expect(rStale.reason).toMatch(/stale|re-execut/i);
    const dirty = { ...VALID_EVIDENCE, dirty: true as const };
    const rDirty = assessDocsCoverageWithSemantics(REQ_EXEC, { 'docs/api.md': CORRECT_PT }, SEM_PASS_EXEC, {
      executedEvidence: dirty,
      jobHead: JOB_HEAD,
    });
    expect(rDirty.covered).toBe(false);
    expect(rDirty.reason).toMatch(/dirty|re-execut/i);
  });

  it('conteúdo realmente errado falha (semântico fail, mesmo com evidência válida)', () => {
    const wrong = CORRECT_PT.replace('`{ original: [1, 2, 3], clamped: [1, 2, 2], min: 0, max: 2 }`', '`{ original: [1, 2, 3], clamped: [9, 9, 9], min: 0, max: 2 }`');
    const r = assessDocsCoverageWithSemantics(
      REQ_EXEC,
      { 'docs/api.md': wrong },
      {
        verdict: 'fail' as const,
        demonstrated: false,
        evidence: ['clamped: [9, 9, 9]'],
        reason: 'Docs state wrong clamped output [9, 9, 9], does not match clamp behavior.',
      },
      { executedEvidence: VALID_EVIDENCE, jobHead: JOB_HEAD },
    );
    expect(r.covered).toBe(false);
    expect(r.status).toBe('not-covered');
    expect(r.reason).toMatch(/semantic review rejects|fix the docs/i);
  });

  it('aceite supervisionado nunca vira Verified por si só (ressalva permanece Unverified)', async () => {
    const { excludeAcceptedFromVerified } = await import('../../src/lib/reports');
    const { isTaskVerified } = await import('../../src/lib/verification');
    // Mesmo com evidência task-scoped passed, o aceite exclui de Verified.
    const verifiedCandidates = ['api-docs [merged, task-scoped] node --test passed @ 7762a146'];
    const verified = excludeAcceptedFromVerified(verifiedCandidates, ['api-docs']);
    expect(verified).toEqual([]);
    // E sem aceite, a mesma evidência seria Verified (prova que o bloqueio é o aceite).
    const kept = excludeAcceptedFromVerified(verifiedCandidates, []);
    expect(kept).toEqual(verifiedCandidates);
    // isTaskVerified sozinho não conhece aceite — o gate é a exclusão acima.
    expect(
      isTaskVerified({ testStatus: 'passed', scope: 'task', reviewedCommit: JOB_HEAD } as never),
    ).toBe(true);
  });
});
