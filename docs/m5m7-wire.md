# M5/M7 — final wiring + readable report

Scope nomeado: `m5m7-wire`. Writer única desta lane:
`src/lib/orchestrator.ts` (fiação `coordinateOnce` → `reconcile`, sem
quebrar o DAG), `src/lib/merge-train.ts` (fiação: fila única idempotente +
empty-merge no-op; gate/lock/regressão M4 intactos),
`src/lib/integration.ts` (somente leitura — lock por branch + `requireHumanAuth`
já existentes, sem mudanças), `src/lib/reports.ts` +
`src/tools/report.ts` (relatório final padronizado), `src/tools/pr.ts`
(`requireHumanAuth` na pendência M1), `tests/lib/wire-report.test.ts`,
este doc. Não toca `coordinator.ts`, `instance-manager.ts`,
`sdk-client.ts`, `reviewer.ts`, `durable-state.ts`, `file-lock.ts`,
`job-state.ts`, `plan-state.ts`, `job-pause/resume`, `answer.ts`,
`overview.ts` exceto leitura.

## Fiação (`orchestrator.ts`)

`runCoordinatorPass(plan, byName, runningCount, maxParallel)` roda dentro do
`_doReconcile`, depois do loop manual de launch:

- **Observe** — snapshot do plano em memória (status já mutados pelo loop
  manual), modelo via `planModelSnapshot ?? getCurrentModel()`, base
  `integrationBranch ?? baseCommit`.
- **Dispatch** — chama o `launchJob` existente (sem segundo lançador), com
  guarda dupla: status em memória (`queued`/`waiting_deps`) + conjunto
  `coordinatedJobs` (`${planId}:${jobName}`). Retry/queda nunca relança:
  o status persistido `running` barra relançamento após restart.
- **Gate = false** — o coordinator nunca enfileira na integração; a seção
  de merge abaixo continua a única integradora (sem reintegrar).
- **Enqueue = no-op** — nunca alcançado (gate falso); registrado como
  prova de não-reintegração.
- **Orçamento preservado** — `coordinateOnce` fixa 4–8 (`clampMaxParallel`);
  o `runningCount` observado é deslocado por
  `(clamp(config) − config)` para manter exatamente o orçamento do
  `maxParallel` configurado (ex.: 2 continua 2, não 4). DAG sem quebra.

## Fila única (merge-train)

- `enqueue` idempotente por `id`/`nome` (`has()` exposto); retry com fila
  em memória vazia não duplica.
- Crash recovery no reconciler: jobs presos em `merging` (fila perdida no
  restart) reentram uma vez — `has()` mantém idempotência.
- Integração serializada por `integrationBranch` sob `withIntegrationLock`
  (M4, inalterado).
- **Empty diff é válido para diagnóstico**: squash/ff-only que resulta em
  "nothing to commit" retorna `success` com `testReport.status = 'skipped'`
  (`reason: No changes to merge (empty diff)`) em vez de `test_failure`.

## Sem push padrão (`pr.ts` + `orchestrator.createPR`)

- `mc_pr` exige `humanAuth: true` explícito; sem a flag,
  `requireHumanAuth('git push')` recusa antes de qualquer spawn.
- `Orchestrator.createPR(opts?)` exige o mesmo par
  (`git push` + `gh pr create`); ausência da flag é recusa.
- No reconciler, a recusa de auth **pausa em `pre_pr`** (trabalho parcial
  preservado, nenhum push feito) em vez de falhar o plano; aprovar com
  `mc_plan_approve(checkpoint: "pre_pr")` para continuar.

## Preservação vs encerramento vs limpeza

- **Preservação** (padrão): parar processo nunca descarta código —
  `cancelPlan`/`mc_kill` param o processo e mantêm worktree/branch;
  pausa em checkpoint mantém tudo para retomada.
- **Encerramento**: só `merged`/`completed`/`failed` com evidência mudam
  estado; `mc_report_final` lista `Preserved` vs `Closed` separadamente.
- **Limpeza**: só via `mc_cleanup` explícito; nunca automática no
  reconciler, no merge-train ou no relatório.

## Relatório final (`reports.ts` + `tools/report.ts`)

- `buildFinalReportMarkdown(input)` — puro, todas as seções sempre
  emitidas (placeholder explícito quando vazio; "não reportado" ≠
  "reportado vazio"). Corpo legível + anexos/referências; logs extensos
  só em `## Annexes`, truncados aos 12000 chars com marcador
  `[truncated N chars, see source]`.
- Seções: Request & Scope · Architecture & Decisions · Plan & Tasks ·
  Per-Instance Contributions · Files & Branches · Integration · Install &
  Usage · Tests (Commands & Results) · Real Evidence · Problems &
  Solutions · **Verified** · **Gaps (Unmet / Unverified)** · Limitations &
  Next Steps · Preservation (Preserved vs Closed vs Cleanup) · Annexes.
- **Verificado vs lacunas por construção**: `Verified` só recebe
  `merged`/`completed`; o resto cai em `Unmet` (failed/conflict/
  needs_rebase/canceled) ou `Unverified` — nunca inventado.
- `writeFinalReport(planId, markdown)` / `readFinalReport(planId)` —
  persiste em `reports/final-<planId>.md`.
- `mc_report_final` (args: `notes?`, `includeAttachments?`) — monta o
  relatório do plano ativo + job-state + milestone reports e persiste;
  retorna contagens `Verified/Unmet/Unverified`.

## Verificação

```sh
bun run build
bun test tests/lib/wire-report.test.ts
bun test
```

- `bun run build`: bundle ok.
- `tests/lib/wire-report.test.ts`: 11 testes (fiação sem duplicar,
  orçamento paralelo, recovery `merging`, dedupe da fila, empty-merge
  no-op, `createPR`/`mc_pr` exigindo `humanAuth`, relatório completo,
  verified-vs-gaps, anexos com truncamento, round-trip de persistência).
- Full suite: sem nova regressão além do flake `launch` conhecido.

## Limites

- `mc_report_final` ainda não registrado em `src/index.ts` (fora do
  escopo da lane) — exportado e testado, registro é follow-up do
  orquestrador.
- O passo de PR automático do autopilot agora pausa em `pre_pr` quando
  sem `humanAuth` (mudança intencional: sem push padrão); o teste
  existente com `createPR` mockado continua verde.
