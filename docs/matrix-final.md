# Matrix Final — feat/autonomous-orchestrator-v2

Reconciliação de TODAS as seções do Anexo A + tabela de aceitação.
Níveis: **Implementado** (código existe) / **Verificado** (teste automatizado,
hermético ou simulado, verde) / **Validado** (execução real: workers LLM vivos
e/ou serve 2.1.4 descartável) / **Pendente-bloqueado** (motivo explícito).
Não se marca seção inteira por nome de arquivo: cada ID tem implementação +
evidência próprias.

Fontes: `docs/live-proof.md` (+ adendo live-gaps), `docs/fixes-static.md`,
`docs/m{2,3,4,5m7,6}-*.md`, `docs/review-fixes.md`, `MANUAL_TEST_PLAN.md`.

## 1. Interface (mc_* + CLI humano)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| INT-1 | Ferramentas `mc_*` no command-center | `src/index.ts` tool map (21 tools, `mc_report_final` incluso) | Verificado | `tests/plugin-init.test.ts` |
| INT-2 | Mapa reduzido no job-agent (`mc_report` + `mc_status`) | `src/index.ts` job-agent map | Verificado | `tests/plugin-init.test.ts` |
| INT-3 | CLI humana conversacional | `src/orchestrator-cli/` (`help\|follow\|send\|task\|pause\|resume\|add\|answer\|questions\|order\|session\|log\|cancel`) | Verificado | `tests/lib/human-controls.test.ts`, `tests/**/orchestrator-cli/*` |
| INT-4 | Ciclo operado pela interface normal | driver live usou `mc_plan`, `mc_plan_status`, `mc_capture`, `mc_plan_approve`, `mc_kill`, `mc_cleanup` | Validado | `docs/live-proof.md` §1–3, `/tmp/opencode/live-full/driver.log` |

## 2. Coordenador (mesmo modelo, juiz único)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| COR-1 | Loop observe→decide→dispatch→gate→enqueue, juiz único | `src/lib/coordinator.ts` `coordinateOnce` | Verificado | `tests/lib/coordinator.test.ts` |
| COR-2 | Snapshot de modelo pinado (triplo V2ModelRef) atravessa dispatch | `planModelSnapshot`, `resolveCoordinatorModel` (sem mutação) | Verificado | `tests/lib/coordinator.test.ts`, `tests/lib/plan-state.test.ts` (round-trip `remoteSessionID`) |
| COR-3 | Coordenador e workers no mesmo modelo | serve-launch cria sessão com triplo pinado; banners TUI confirmam `Muse Spark 1.3 Contributor` | Validado | `docs/live-proof.md` §5 + adendo G3 (`g3-session-get.json`: `model.{providerID,id,variant}` + agent + location) |
| COR-4 | Sem fallback silencioso | `resolveModelFallback` → `{action:'pause', question}`, `swappedModel` sempre `undefined` | Verificado | `tests/lib/instance-manager.test.ts` |

Limite honesto (COR-3): no launch TUI o CLI 2.1.4 rejeita `-m`, então o launcher
sai sem `-m` e vale o default autorizado (que era o modelo pedido); o pin
estrito vive no caminho serve (`v2CreateSession` com triplo). Sem degradação
silenciosa nos dois casos.

## 3. Estado durável (kill -9 resume)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| EST-1 | Locks inter-processo p/ RMW de estado | `src/lib/file-lock.ts` (O_EXCL + stale-break + timeout) | Verificado | `tests/lib/file-lock.test.ts` (counter 2-processos, timeout, stale, ownership) |
| EST-2 | Sidecar `runtime-state.json` + `reconcileOnBoot` (dedupe, prune, quarantine) | `src/lib/durable-state.ts` | Verificado | `tests/lib/durable-state.test.ts` |
| EST-3 | `job-state`/`plan-state`/`port-allocator` sob lock | chamadas `withFileLock` | Verificado | suítes existentes, sem regressão |
| EST-4 | Crash + resume sem duplicar nem reintegrar | `kill -9` no driver com 3 workers no ar → `resumePlan()` em processo novo | Validado | `docs/live-proof.md` §3 (mesmos job IDs, 0 duplicatas, 0/3 merged antes e depois, plano concluiu) |
| EST-5 | Perguntas/mensagens/acumuladores/SSE cursor duráveis | sidecar + `updateRuntimeSnapshot` (single lock holder) | Verificado | `tests/lib/durable-state.test.ts`, `tests/lib/monitor-v2.test.ts` (forms no sidecar) |

## 4. Instâncias (perfil real)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| INS-1 | Controle de instância real via surface `/api` verificada | `src/lib/instance-manager.ts` + seção v2 de `src/lib/sdk-client.ts` (fetch, openapi 2.1.4) | Verificado | `tests/lib/instance-manager.test.ts`, `tests/lib/sdk-client-v2.test.ts` |
| INS-2 | Equivalência de perfil (triplo + agent + location + projectID/permissions quando pinados) | `assertProfileEquivalence` | Verificado + Validado (serve local 2.1.4, porta 17891: create→get igual, drift com `projectID` → `paused` com pergunta) | testes acima + `docs/m2-instance.md` § evidência real |
| INS-3 | Drift pausa antes de qualquer trabalho, nunca degrada | `launch()` retorna `{status:'paused', question}` | Verificado | `tests/lib/instance-manager.test.ts` |
| INS-4 | Anti-recursão `MC_INSTANCE_DEPTH` (max 1) | `launch()` lança se `depth >= max` | Verificado | `tests/lib/instance-manager.test.ts` |
| INS-5 | Sem reimplementar config/plugins/skills; sem tocar config global | fixa perfil no `session.create`, reverifica no `session.get` | Implementado | `src/lib/instance-manager.ts` (revisão por leitura; sem teste dedicado — Pendente menor, ver §9) |

## 5. Teto configurável (paralelismo 4–8)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| TETO-1 | `clampMaxParallel` 4–8, bounds configuráveis, fallback 4 | `src/lib/coordinator.ts` (exporta `MIN_PARALLEL`/`MAX_PARALLEL`) | Verificado | `tests/lib/coordinator.test.ts` (default + custom-window) |
| TETO-2 | Orçamento preservado sob o clamp (compensação ≥ 0) | `runCoordinatorPass` desloca `runningCount` por `(clamp(config) − config)` | Verificado | `tests/lib/wire-report.test.ts` |
| TETO-3 | Pico real de 3 workers simultâneos (2 frentes + probe) | coordenador + tmux `mc-live-*` | Validado | `docs/live-proof.md` §1 |

## 6. Revisão e testes (gate fail-closed)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| REV-1 | `reviewJob` puro e fail-closed (diff não vazio, touchSet, `exitCode===0` no commit exato, anchors no output, sem relato otimista) | `src/lib/reviewer.ts` | Verificado | `tests/lib/reviewer.test.ts` (inclui "never passes on a 'pass' claim without observed execution") |
| REV-2 | Rejeição real de entrega fora do escopo | touchSet `notes-rascunho.md` → `on_error` (`failureKind=touchset`) | Validado | `docs/live-proof.md` §1 (`plan/jobs-*.json`, `review*.ts`) |
| REV-3 | `PASS` nas 3 entregas finais via `reviewJob` sobre artefatos reais | gate independente pré-correção `FAIL` / finais `PASS` | Validado | `docs/live-proof.md` §1 (`ef77fcb`, `3447f97`) |
| REV-4 | `testAnchors` = substrings que DEVEM aparecer no output (não no diff) | `anchorCovered` | Verificado | `tests/lib/reviewer.test.ts` |
| REV-5 | Mudança de teste exige `reasonPreviousIncorrect` | `validateTestChange` | Verificado | `tests/lib/reviewer.test.ts` |

## 7. Correção iterativa (review-fix loop + relaunch)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| FIX-1 | Loop revisa→fix→re-revisa com backoff, teto e quarentena flaky | `runReviewFixLoop` (`maxFixCycles`, `backoffMs`, `quarantineAfterRepeats`) | Verificado | `tests/lib/reviewer.test.ts` |
| FIX-2 | Correção do mesmo trabalho continua a sessão; tarefa nova abre sessão nova | `shouldContinueSession` (+ fork prefere `remoteSessionID`) | Verificado + Validado (re-relançado no mesmo worktree reverteu com `ef77fcb`) | testes + `docs/live-proof.md` §1 |
| FIX-3 | Fix-before-rollback mira a sessão remota, nunca a do operador | `merge-train.ts` + `plan-types.ts` (`remoteSessionID` obrigatório) | Verificado | `tests/lib/merge-train.test.ts`, `docs/review-fixes.md` §3 |
| FIX-4 | `mc_plan_approve(checkpoint=on_error, relaunch=…)` corrige pela via do produto | `orchestrator.ts` approve→relaunch | Validado | `docs/live-proof.md` §1 (reprovado → relaunch → `ready_to_merge`) |

## 8. Integração serializada

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| MER-1 | Merge-train serializado por branch sob file lock | `withIntegrationLock` (`INTEGRATION_STALE_MS` 660s documentado) | Verificado | `tests/lib/merge-train.test.ts` |
| MER-2 | Sem merge sem `verdict=pass` (`review_blocked`, HEAD intacto) | `processNext`/`processAll` + revalidação de frescura dentro do lock | Verificado | `tests/lib/merge-train.test.ts` |
| MER-3 | `testCommand` (+ `regressionCommand` opcional) com rollback em falha/conflito | `merge-train.ts` | Verificado | `tests/lib/merge-train.test.ts` |
| MER-4 | 3 merges reais com `bun test` por merge + integração 9/9 verde | merge-train sobre `mc/plan/47916cd4/*` | Validado | `docs/live-proof.md` §1 (`testes passed | 9 pass`, worktree `mc/integration-47916cd4`) |
| MER-5 | Fila única idempotente + crash recovery de `merging` + empty-diff no-op | `enqueue` dedupe `has()`, re-entrada única | Verificado | `tests/lib/wire-report.test.ts` |

## 9. Pausa / retoma / cancela

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| PRC-1 | `mc_job_pause` (interrupt + background opcional, código fica) | `src/tools/job-pause.ts` | Verificado + Validado (G1: `interrupt={"interrupted":true}` em loop real, `pauseJob`/`resumeJob` mesma sessão → `idle`) | `tests/lib/human-controls.test.ts` + `docs/live-proof.md` adendo G1 (`g1-*.json`) |
| PRC-2 | `mc_job_resume` (mesma sessão, `interrupt?resume=true`, `wait` opcional) | `src/tools/job-resume.ts` | Verificado + Validado (G1) | idem |
| PRC-3 | Cancel preserva código/worktree/branch/commit | `mc_kill` (só processos da execução) | Validado | `docs/live-proof.md` §3 (`live-probe`, commit `73c034b`, `bun test` 5 pass na árvore preservada) |
| PRC-4 | Descarte só via `mc_cleanup` explícito; parar ≠ descartar | `cancelPlan`/`mc_kill` nunca removem worktree | Verificado (testes de kill/cancel) + Validado (teardown só no fim, main intacta `321cc40`) | testes + `docs/live-proof.md` §1 |

## 10. Perguntas (essenciais, duráveis, sem travar)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| PER-1 | Perguntas do agente chegam como forms de sessão; resposta via form reply | `answerQuestion` (form-first, fallback prompt só sem form) + `QuestionRelay`/`JobComms`/`monitor` migrados p/ V2 | Verificado + Validado (G2: pergunta real → `form.created` → reply `(form reply)` → agente desbloqueou até `idle`) | `tests/lib/human-controls.test.ts`, `tests/lib/monitor-v2.test.ts` + `docs/live-proof.md` adendo G2 |
| PER-2 | Roteamento certo (sessão-irmã sem forms; sem duplicar) | `remoteSessionID` em todo sender V2 | Validado (G2) | `g2-*` em `/tmp/opencode/live-gaps/evidence/` |
| PER-3 | Ausência do operador não trava frentes (auto-resposta 120s) | `QUESTION_AUTO_RESPONSE_MS` / `QUESTION_DEFAULT_RESPONSE` | Implementado + Verificado (unidade do relay) | `src/lib/question-relay.ts` + testes |
| PER-4 | Perguntas duráveis (memória + sidecar, kill-9 safe, sem re-entrega) | `forms.ts` + `updateRuntimeSnapshot` | Verificado | `tests/lib/durable-state.test.ts`, `tests/lib/monitor-v2.test.ts` |
| PER-5 | `session.get` triplo (modelo+agent+location+projectID) | `v2GetSession` | Validado (G3) | `g3-session-get.json` |

## 11. Relatórios (legíveis, verified-vs-gaps)

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| REL-1 | Relatório final padronizado, todas as seções sempre emitidas | `buildFinalReportMarkdown` (+ anexos truncados 12k) | Verificado | `tests/lib/wire-report.test.ts` (11 testes), `tests/tools/report-final.test.ts` |
| REL-2 | `Verified` só com evidência; merges sob `## Integration`; `completed`-sem-merge → `Unverified` | caller `mc_report_final` (builder genérico inalterado) | Verificado | `tests/tools/report-final.test.ts` |
| REL-3 | `mc_report_final` registrado uma única vez, só no command-center | `src/index.ts` tool map | Verificado | `tests/plugin-init.test.ts` |
| REL-4 | Relatórios curtos por marco + alertas imediatos; `(N%)` só com `progress` real | `writeMilestoneReport`/`writeAlertReport`/`formatReportLine` | Verificado | `tests/lib/human-controls.test.ts` |
| REL-5 | `mc_report`/`mc_status`/`mc_overview` expõem reports | monitor poll 10s → overview Alerts + Suggested Actions | Verificado (injeção sintética) | testes de overview/report (fases 8D–8F do plano cobrem o caminho; injeção determinística) |

## 12. Modelo único sem fallback + segredos

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| MOD-1 | Modelo único pedido; inservível pausa com pergunta (nunca troca sozinho) | `resolveModelFallback` + `assertProfileEquivalence` | Verificado | `tests/lib/instance-manager.test.ts` |
| MOD-2 | Observado: `muse-spark-1.3-contributor (opencode-go)` o tempo todo | banners TUI + `session.get` | Validado | `docs/live-proof.md` §5 + adendo |
| SEG-1 | Sem segredos em prompts/logs | `redactSecrets` (offset por ocorrência, não `indexOf`) | Verificado | `tests/lib/coordinator.test.ts` |
| SEG-2 | Sem push/PR/deploy sem `humanAuth` explícito | `requireHumanAuth` (`permission-policy.ts`, `integration.ts`, `pr.ts`, `orchestrator.createPR`) | Verificado | `tests/lib/publish-guards.test.ts` |
| SEG-3 | Nenhum push executado em nenhuma lane | fixture sem remote; `pre_pr` pausa sem auth | Validado | `docs/live-proof.md` §1 (nenhum push; main do fixture `321cc40` intacta) |

## 13. Observabilidade

| ID | Requisito | Implementação | Status | Evidência |
| --- | --- | --- | --- | --- |
| OBS-1 | `mc_status`/`mc_capture`/`mc_overview`/`mc_plan_status`/`mc_diff` | tools + `coordinator-client.getDashboard` (Pauser da LATEST report) | Verificado | `tests/{plugin-init,tools/overview}.test.ts` + suítes de overview |
| OBS-2 | Stream de eventos nativo por sessão + backfill de forms + terminal `session.*` ignorado fora de `running` sem storm | monitor SSE `/api/event` + stale-event guard | Verificado | `tests/lib/monitor-v2.test.ts`, `tests/lib/monitor.test.ts` |
| OBS-3 | Acompanhamento real (`mc_capture` banners, `git diff`, `bun test` nas worktrees) | uso operacional | Validado | `docs/live-proof.md` §1 (`junit-*.log`, `cap*.txt`, `snap-*.json`) |

## 14. E2E (MANUAL_TEST_PLAN A–E + tabela de aceitação)

| ID | Requisito | Status | Evidência / motivo |
| --- | --- | --- | --- |
| E2E-A | Ciclo completo pela interface: plano com deps → 2 workers simultâneos → rejeição → correção → merges gated → integração verde → `pre_pr` sem push | **Validado** | `docs/live-proof.md` §1 (cenário próprio, não o MANUAL_TEST_PLAN passo a passo) |
| E2E-B | Reutilização em repo existente sem regressão (4/4 antes → 7/7 → 4/4 depois) | **Validado** | `docs/live-proof.md` §2 |
| E2E-C | Crash + resume; cancel preservando código; teardown limpo | **Validado** | `docs/live-proof.md` §3 |
| E2E-D | Pausa/retoma, pergunta/resposta, `session.get` triplo | **Validado** | adendo live-gaps (G1/G2/G3), serve descartável 14492 |
| E2E-E | Fases do `MANUAL_TEST_PLAN.md` executadas uma a uma (1–18) | **Pendente** (não bloqueado) | motivo: o ciclo foi provado por cenário live equivalente, não pelo roteiro manual fase a fase; roteiro segue disponível e íntegro para quem for operar |
| ACE-1 | Tabela de aceitação: critérios por job no prompt (`acceptance`), `testAnchors` cobrindo requisitos essenciais, `Verified vs Gaps` no relatório final | **Verificado** | `coordinator.ts` (`acceptance` no prompt), `reviewer.ts` (anchors), `reports.ts` (Verified/Gaps); `tests/lib/{coordinator,reviewer,wire-report}.test.ts` |
| ACE-2 | Nenhum "pass" sem execução observada | **Verificado** | REV-1; `fixes-static.md` §4 |

## 15. Pendentes honestos (não marcam nenhuma seção como "done")

1. `MANUAL_TEST_PLAN.md` fases 1–18 não executadas passo a passo (E2E-E). Roteiro intacto; cenário live equivalente validado.
2. ~~Ask-user `permission escalation` sem push ao operador~~ → **corrigido
   nesta rodada**: `perm:<id>` visível em `mc_overview`/dashboard/TUI
   (`docs/guards-proof.md` §3; testes `question-relay`).
3. ~~`PUSH_PATTERN` não parseia `git -c`/`--git-dir=`~~ → **corrigido**:
   `isGitPushArgs`/`isGitPushText` cobrem `-C/-c`, `--git-dir`,
   `--work-tree`, espaços/aspas; barreira real documentada
   (`docs/guards-proof.md` §2).
4. ~~`updatePlanJob` warn-and-apply~~ → **corrigido**: fail-closed, só
   recuperação força com flag explícita (`docs/guards-proof.md` §1).
5. `coordinator-client.ts` só lê memória + sidecar (correto após persistência do monitor; sem mudança).
6. Senders legados não-`/api` restantes fora do caminho crítico foram migrados nesta branch (job-comms, fork, relay, monitor SSE, answer); herança restante: nenhuma conhecida — item de `review-fixes.md` §legado considerado encerrado pelos testes `monitor-v2` + `human-controls`.
7. INS-5 sem teste dedicado (revisão por leitura). Menor; candidato a 1 teste de contrato futuro.
8. O flake `launch` order-dependent (model-tracker) **não reproduziu** no fechamento (0 fail em 969 testes); o `afterEach` de reset segue como follow-up sugerido, não aplicado.

## 16. Verificação deste fechamento

| # | Comando | Resultado | Evidência |
| --- | --- | --- | --- |
| A | `bun run build` | **exit 0** — `Bundled 221 modules`, `index.js 1.33 MB` | `/tmp/opencode/final-close-build.log` |
| B | `bun test` (full, fresco) | **exit 0** — **953 pass, 16 skip, 0 fail**, 969 testes / 62 arquivos | `/tmp/opencode/final-close-test.log` |
| C | `git status` / `git log` / `git remote -v` / `git diff --stat` | branch `feat/autonomous-orchestrator-v2`, tree limpa após commits deste fechamento, nada publicado | §17 |
| D | Flake launch | **0 fail** — confirma expectativa pós-gaps lane | `/tmp/opencode/final-close-test.log` (tail: `953 pass, 16 skip, 0 fail`) |

## 17. Commits (locais, sem push/PR)

Branch `feat/autonomous-orchestrator-v2` sobre base `6db667e` (`origin/main`):

- `0b90745` feat(m1): durable state, cross-process file locks and publish guards
- `82fb7f2` feat(m2): serve-mode instance manager
- `e7764e7` feat(m3): autonomous coordinator pass
- `d42dad0` feat(m4): reviewer gate and merge-train hardening
- `0a1eb3d` feat(m6): human controls - pause/resume, TUI forms, answer over V2
- `ef73f78` feat(m5-m7): coordinator wiring and verified final report
- `83d28be` docs: milestone notes (m1-m8), user guide and delivery report
- `a8373f5` fix(static): verified-vs-integrated split, throwing-transition guards, configurable parallel clamp
- `0281b85` fix(serve): migrate worker-session senders to the v2 /api surface
- `2f4e762` test(serve): pin v2 contracts for pause, forms, permissions, triple
- `fd86c39` docs(live-gaps): close pause/resume, form answers, session triple
- (+ commit deste fechamento: `docs(matrix-final)` + `DELIVERY-REPORT` atualizado)

Sem perfil global modificado, sem segredos, sem push/PR, sem fixtures úteis apagadas.

## 18. Adendo guards-docs (esta rodada)

| ID | Correção | Evidência |
| --- | --- | --- |
| GUA-1 | `updatePlanJob` fail-closed (rejeita sem aplicar; `force` só na recuperação `launchJob`) | `tests/lib/plan-state.test.ts` (queued→merged e merged→canceled rejeitam, estado intacto) |
| GUA-2 | `PUSH_PATTERN` como auxílio + barreira real (`requireHumanAuth`/`requiresHumanAuth` cobrindo `git -C/-c`, `--git-dir/--work-tree`, espaços/aspas, `git -C`) | `tests/lib/coordinator.test.ts` (`isGitPushArgs`), `tests/lib/permission-policy.test.ts` (`isGitPushText` + `ask-user` dentro do worktree) |
| GUA-3 | `ask-user` visível (`perm:<id>` em memória + sidecar → `mc_overview`/dashboard/TUI) + timeout seguro (publishing auto-deny) + `answer <job> <approve\|deny>` | `tests/lib/question-relay.test.ts` (sem auto-aprovação, pendente visível, `reject` vs `once`) |
| GUA-4 | Primeiro uso reproduzível (5 passos copiáveis, TUI one-shot, repo+branch destino) | `docs/guards-proof.md` §4 (comandos + exits observados em `/tmp/opencode/first-use-demo-*`), `docs/USER-GUIDE.md` §11 |

Verificação: `bun run build` exit 0; `bun test` exit 0 —
**963 pass, 16 skip, 0 fail** (62 arquivos; +10 vs 953).

## 19. Adendo targeted-close (autonomia pontual + revisão funcional)

| ID | Critério | Resultado | Evidência |
| --- | --- | --- | --- |
| AUT-1 | Só NL vira tarefas+deps+prompts (sem DAG prévio) | Pass no recorte pontual | `docs/targeted-proof.md` Caso A: `caseA-send.txt` (só embrulha) + `caseA-order.txt` (`No active plan`) + `caseA-decide.log` (`ELIGIBLE-INITIAL` 2 paralelas, docs `waiting_deps`) |
| AUT-2 | Coordenador decide ordem/paralelismo (2 workers) | Pass no recorte pontual | `decideNextJobs` + `buildWorkerPrompt` puras (`caseA-decide.ts/.log`, `PROMPT-HAS-SLUG:true`); ciclo full com workers LLM vivos coberto por `docs/live-proof.md`, não repetido aqui |
| REV-F1 | Entrega in-scope + verde mas incompleta falha no gate | Pass | `caseB-test1.log` 1 pass + `caseB-verdict1.txt` FAIL `REQ-EMPTY` (`reviewJob` do produto) |
| REV-F2 | Correção pedida + reverificação passa | Pass | `1254110` diff + `caseB-test2.log` 2 pass + `caseB-verdict2.txt` PASS (`reviewedCommit 1254110`) |
| GUA-1..4 | Reafirmado sem mudança de `src/` | Pass | §18 + `docs/guards-proof.md` + `/tmp/opencode/guards-test.log` (963 pass) |

Limitação honesta (AUT): `send` só embrulha com guards; a decomposição
NL→DAG neste proof foi decidida pelo coordenador (modelo, esta sessão) e
exercida via funções puras do produto (`decideNextJobs`/`buildWorkerPrompt`);
o ciclo full com modelo vivo continua coberto por `docs/live-proof.md`.
**Sem pipeline LLM dedicado de NL→DAG provado de ponta a ponta nesta
branch** — marcado como limitação, não como Pass integral.

Verificação desta rodada (só docs, sem tocar `src/`): `bun test
tests/lib/coordinator.test.ts tests/lib/reviewer.test.ts` exit 0 —
**43 pass, 0 fail** (41 na lane targeted +2 guards); `bun run build` exit 0
(`Bundled 221 modules`); `git status` limpo após commit (só este adendo +
`docs/targeted-proof.md`); sem push/PR, sem perfil global, sem segredos.
