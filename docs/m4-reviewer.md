# M4 — reviewer (fail-closed evidence gate)

Scope nomeado: `m4-reviewer`. Writer única desta lane: `src/lib/reviewer.ts`
(+ testes `tests/lib/reviewer.test.ts`, este doc). Toques aditivos nas
trilhas de integração: `src/lib/merge-train.ts` (gate + lock + regressão),
`src/lib/integration.ts` (lock por branch), `src/lib/git.ts` (leituras
`getBranchHead`/`listChangedFiles`). Não toca coordinator/instance-manager/
sdk-client/durable-state/file-lock/job-state/plan-state exceto leitura.

## Veredito (`src/lib/reviewer.ts`)

`reviewJob(input)` é puro e fail-closed: qualquer prova ausente é `fail`
bloqueante (`blocking: true`), nunca `pass`. Pass exige TODOS:

- diff não vazio (`changedFiles` do `base...job`);
- touchSet respeitado (mesmo glob `Bun.Glob` do merge-train);
- evidência de teste: `command` não vazio + `exitCode === 0` + `output`
  observável + `testedCommit === jobHead` (código testado = código revisado);
- cada requisito essencial com ao menos um `testAnchor` no output ou nos
  arquivos alterados — verde sem cobrir requisito falha;
- `claimedPass` sem evidência/verde = relato otimista sem prova, falha;
- arquivos de teste alterados exigem `reasonPreviousIncorrect` (enfraquecer
  teste para aprovar sem registrar o porquê do teste anterior estar errado
  é rejeitado via `validateTestChange`).

Aprovação fixa `(reviewedCommit, reviewedBase)`. `needsReReview(old, cur)`
= `old !== cur`: base moveu (merge) ou job moveu → re-revisar, nunca
auto-aplica árvore antiga.

## Loop com limite (`runReviewFixLoop`)

`{ maxFixCycles, backoffMs, backoffMultiplier?, quarantineAfterRepeats? }`:
revisa → (falhou? backoff → `fix()` → revisa). `fix()` retornando `null`
para; repetir a mesma assinatura de falha quarentena como flaky em vez de
girar (`quarantined: true`). `isFlakySequence` marca mesmo commit com
pass+fail como flaky.

## Integração (só com `verdict=pass`)

- `MergeTrain.processNext(verdict?)` / `processAll(verdicts?)`:
  sem `verdict=pass` não há merge (`type: 'review_blocked'`, HEAD intacto).
  Com `requireReviewPass: true`, ausência de veredito também bloqueia.
  Chamada legada sem veredito e sem a flag preserva o comportamento antigo.
- Frescura revalidada **dentro** do lock: `reviewedBase` vs HEAD da
  integração e `reviewedCommit` vs HEAD do job — divergiu, bloqueia.
- Tudo sob `withIntegrationLock(worktree)` (`integration.ts`, lockfile por
  branch via `file-lock.ts`); rollback existente mantido em conflito,
  falha de teste/setup e timeout.
- Pós-integração: `testCommand` (existente) + opcional `regressionCommand`
  (nova config; falha reverte o merge como `test_failure`).

## Sem enfraquecer teste

Mudança legítima de teste exige `testChange.reasonPreviousIncorrect`
não vazio explicando por que o teste anterior estava incorreto.

## Limites

Sem push remoto, sem perfil global, sem segredos (revisor não executa
comandos de rede nem lê env). Sem auto-fix silencioso: correção só via
`fix()` injetado pelo chamador, com backoff e teto.
