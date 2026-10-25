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

## 20. Adendo final-reconcile (auto-intake + demo pública)

Reconciliação da lacuna central: NL→requisitos/plano/deps/prompts/aceitação
via modelo, validação runtime, replanejamento adaptativo, persistência+retomada,
conteúdo vs approve/deny, projeto novo sem commit inicial, ciclo completo
pedido→workers reais→decisões→verificação/correção→integração→relatório,
segundo pedido não-codificado.

Código do lane em `8df7cab`
(`feat(auto-intake)` — `src/lib/auto-plan.ts`, `src/orchestrator-cli/auto-commands.ts`,
`validateModelDispatch`/`detectGaps` em `coordinator.ts`, intake no sidecar em
`durable-state.ts`, `startAutonomousPlan`/`complementAutonomousRequest`/`applyModelAdjustment`
em `orchestrator.ts`, `start|complement|auto-plan|close` em `commands.ts`;
testes `auto-plan`/`auto-intake`/`auto-commands`). Prova viva em
`docs/public-demo.md` (evidências numeradas em `/tmp/opencode/public-evidence/`).

| ID | Lacuna | Status | Evidência |
| --- | --- | --- | --- |
| REC-1 | NL→requisitos/plano/deps/prompts/aceitação via MODELO (sem DAG prévio) | **Validado** | `buildPlannerPrompt`/`parsePlannerOutput` (`auto-plan.ts`); 2 respostas reais do modelo (`05/32-generate*.raw.json`, sessões `[REDACTED-SESSION-ID]…`) virando 3+3 tasks com deps e acceptance (`06/09/33-model-plan*.json`) |
| REC-2 | Validação runtime fail-closed (JSON/dep/ciclo/destino/ação) | **Validado** | `parsePlannerOutput`+`assertSafeDestinations`+`assertAuthorizedActions`; Caso 1: eco de "deploy" no prompt rejeitado (`07-autoplan2.txt` exit 1) antes de criar nada; smoke desta rodada: intake desconhecido → exit 1, repo sem commit → exit 1 |
| REC-3 | Replanejamento adaptativo (decisão do modelo pós-dispatch) | **Verificado** (unidade) + **Validado parcial** (via produto) | `validateRuntimeDecision`/`validateModelDispatch`/`detectGaps`/`applyModelAdjustment` com testes; no ciclo live o replanejamento rodou pela via do produto (`Orchestrator.addJob` p/ `docs-readme-retry` + `reviewJob` PASS `51-*` + merge manual `52-*`); `applyModelAdjustment` puro não foi exercitado de ponta a ponta no ciclo live — segue Verificado, não Validado integral |
| REC-4 | Persistência + retomada do intake (sidecar, restart-safe) | **Verificado**; retomada pós-crash **Pendente** | `save/load/mutateAutoIntake`, `appendAutoDecision/Question`, `setAutoNextSteps/Status` + `tests/lib/auto-intake.test.ts`; retomada do *plano* pós `kill -9` validada (`live-proof.md` §3), mas retomada do *intake* (`start` → crash → `auto-plan`) não foi exercitada de ponta a ponta — Pendente (não bloqueado) |
| REC-5 | Conteúdo livre vs approve/deny | **Verificado** + **Validado parcial** | `tests/orchestrator-cli/auto-commands.test.ts` (texto "deny …" em pergunta de conteúdo vai como texto; texto livre em permissão vira `once`+message); caminho permissão validado live (live-gaps G2, form reply); pergunta de conteúdo do intake não teve caso live (questions vazias nos 2 casos) |
| REC-6 | Projeto novo sem commit inicial | **Validado** | `ensureBaseReady` fail-closed: `03-autoplan-nocommit.txt` exit 1 + preparação mínima `04-init-commit.txt` (`fc7b288`); revalidado no smoke desta rodada (`Repo … has no commits … then retry`, exit 1) |
| REC-7 | Ciclo completo pedido→workers reais→decisões→verificação/correção→integração→relatório | **Validado** | Caso 1 (`public-demo.md`): intake `2b2851c5-…` → plano `c3325…` → 2 workers tmux + decisão `12-decision-initial.json` → correções (guard + deny + complemento mesma-sessão) → 3/3 merges → pós-merge 2 pass exit 0 → `mc_report_final` `22-final-report.md` (`Integrated: 3, Unmet: 0, Unverified: 0`) → `pre_pr` sem push |
| REC-8 | Segundo pedido não-codificado (outro domínio, outra decomposição) | **Validado** | Caso 2: clamp/average (`fa7c436d-…` → `48c2ad5f-…`), com 3 incidentes reais recuperados pelo produto (colisão tmux, merge vazio compensado por `reviewJob` PASS, reconciliador parado exigindo `resumePlan()` explícito) |
| REC-9 | `start\|complement\|auto-plan\|close\|follow\|progress` via caminhos completos | **Verificado** + **Validado** (smoke) | `tests/orchestrator-cli/auto-commands.test.ts` (inclui `not.toContain('.../index.ts')`); smoke desta rodada, todos `bun src/orchestrator-cli/index.ts …`: `start` 0, `complement` 0, `auto-plan` válido 0 / intake-inexistente 1 / repo-sem-commit 1, `close` 0, `follow`/`progress` 0, `questions` 0, `order` 0 |

Limitações reais reafirmadas (não bloqueiam, ficam documentadas):
1. `auto-plan` (CLI) valida e persiste, mas **não dispara** workers — o
   despacho continua no coordinator loop (`mc_plan`/driver com os tasks
   verbatim do plan-file; ponte em `11/41-dispatch-map.json`).
2. Driver de recuperação precisa de `resumePlan()` explícito após `addJob`
   (`startReconciler` só roda em `startPlan`) — sem isso, merges não disparam.
3. Prompts do modelo que nomeiam a branch destino podem levar o worker a
   commitar nela (Caso 2) — compensado por inspeção da árvore + `reviewJob`
   independente + merge manual registrado.
4. Merge-train com `testCommand: none` (teto vindo do modelo) relata
   `tests skipped` — a garantia funcional veio dos testes pós-merge.
5. Permissões do TUI em jobs tmux não aparecem no sidecar — resposta foi no
   TUI do worker (deny + complemento mesma-sessão), registrada em
   `19-operator-interventions.txt`.
6. `E2E-E` segue Pendente (roteiro `MANUAL_TEST_PLAN.md` fase a fase não
   executado; cenários live equivalentes validam no lugar).

Verificação deste fechamento (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`Bundled 222 modules`, `index.js 1.36 MB`,
`/tmp/opencode/final-reconcile-build.log`); `bun test` → exit 0 —
**997 pass, 16 skip, 0 fail** (1013 testes / 65 arquivos, +3 arquivos e +28
pass vs o fechamento anterior pelos testes do lane auto-intake;
`/tmp/opencode/final-reconcile-test.log`). Smoke CLI acima com exits
observados um a um (sem pipe mascarando). `git status` limpo após os commits
deste fechamento; sem push/PR, sem perfil global, sem segredos (grep só acha
`token` como nome de variável local em `auto-commands.ts`).

## 21. Adendo final-verify2 (caminho autônomo completo + consolidação)

Escopo: checks frescos + prova de pré-existência dos fails + validação de
artefatos (demo mínima single-4 + demos live anteriores) + commit local do
pendente. Sem push/PR, sem perfil global, modelo autorizado.

### 21.1 Checks frescos (log integral, exit capturado sem pipe)

| # | Comando | Resultado | Evidência |
| --- | --- | --- | --- |
| A | `bun run build` | **exit 0** — `Bundled 222 modules in 31ms`, `index.js 1.37 MB` | `/tmp/opencode/final-verify2-build.log` |
| B | `bun test` (full, com o fix pendente aplicado) | **exit 1** — **1027 pass, 6 fail**, 2414 expects, 1033 testes / 66 arquivos | `/tmp/opencode/final-verify2-test.log` |
| C | `bun test` (full, baseline com fix em stash) | **exit 1** — **1027 pass, 6 fail**, mesmos 6 nomes, mesmos totais | `/tmp/opencode/final-verify2-baseline-full.log` |
| D | `bun test tests/lib/tmux.test.ts tests/lib/tmux-isPaneRunning.test.ts` (com fix) | **exit 0** — **23 pass, 0 fail** | `/tmp/opencode/final-verify2-tmux-withchanges.log` |
| E | idem D (baseline em stash) | **exit 0** — **23 pass, 0 fail** | `/tmp/opencode/final-verify2-baseline-tmux.log` |

Os 6 fails são **pré-existentes e ambientais, com prova** (não classificados
por ausência): B vs C diferem só em timing (nomes dos 6 idênticos, totais
idênticos 1027/6/2414/1033/66); D e E verdes isolados, com e sem o fix —
flake sob paralelismo da suíte cheia (tmux server compartilhado; todos em
`tests/lib/tmux*.test.ts`: 4× `isPaneRunning`, 1× `capturePane` inválido,
1× `tmux.test.ts isPaneRunning`). `src/` do fix não toca tmux; stash prova
que o fix nada introduz. Nenhum teste cobre o comportamento novo do fix
(grep `pollNow|ensureMonitorRunning|writeAutoFinalReport` em `tests/`: zero)
— registrado como lacuna, não como verde.

### 21.2 Status do fix pendente (auto-complete, não-commitado ao abrir a lane)

`src/lib/monitor.ts` (+10: `pollNow`, `isActive`) + `src/lib/orchestrator.ts`
(+126: `ensureMonitorRunning`, `driveMonitorOnce`, `writeAutoFinalReport`,
chamadas em `startPlan`/`resumePlan`/`_doReconcile`/caminhos `completed` e
`pre_pr`) — responde direto ao bloqueante do rerun3 (`single-demo.md` §rerun3:
via autônoma CLI nunca chamava `monitor.start()`, jobs presos em `running`,
sem relatório final). Status honesto: **Implementado + sem regressão
(B vs C idênticos), sem teste dedicado, NÃO Validado** (nenhum re-demo live
após o fix; validar = repetir single do zero e chegar a merges + relatório).

### 21.3 Artefatos validados (existem, lidos)

- Demo mínima single-4 (`/tmp/opencode/single-evidence-4/`, 50 arquivos):
  plano `fb128f07-…` (`17-plan.json`, 3 tasks `is-even`/`capitalize` paralelas
  + `readme` dependente), 2 workers concluíram (`f20023c`/`8bdd707`,
  `node --test` 3+1 pass em `30-verify-*.txt` EXIT=0), kill + `resume
  --intake` sem duplicar (`23-resume.log`), `complement` Caso B (`21-*`).
  Merges/testes pós-merge/relatório final: **não executados** (bloqueio
  monitor, §21.2). Nível: plano/workers/completions **Validados** (trabalho
  real + testes verdes); merges/relatório **Pendentes**.
- Demos live anteriores (`/tmp/opencode/public-evidence/` + `live-full/` +
  `live-gaps/`): `22-final-report.md` (`Integrated: 3, Unmet: 0,
  Unverified: 0`), `55-final-report2.md` (`Integrated: 3, Unmet: 1` trilha do
  incidente), `21-postmerge-tests.log` (2 pass exit 0), `live-full/driver.log`.
  Nível: **Validados** (inalterados por esta lane).
- Leftover: sessões tmux `mc-capitalize`/`mc-is-even` (workers da single-4,
  demo encerrada) seguem no ar — não são do usuário, não foram tocadas aqui.

### 21.4 Limitações registradas (ficam documentadas)

1. Warning de transição de plano: recovery paths com `{ force: true }`
   aplicam e logam `[MC] Invalid job transition: … (forced recovery)`
   (`src/lib/plan-state.ts:112`; observado na suíte: `queued → failed (job:
   fix-login)`). Fail-closed por padrão; force é explícito e visível — por
   desenho, não silencioso.
2. Metering desconhecido: chamadas dos workers via serve não passam pelo
   wrapper `OPENCODE_BIN` (só o planner `--standalone` é contado); consumo
   total de modelo das demos é desconhecido (cf. `single-demo.md` rerun3 §6).
3. `E2E-E` segue Pendente (roteiro fase a fase não executado; cenários live
   equivalentes validam no lugar). `resume --intake` sem plano segue no-op
   por desenho. Intake segue slot único (sobrescreve; trilha em `01-*.txt`).

### 21.5 Commits (locais, sem push/PR)

Branch `feat/autonomous-orchestrator-v2` sobre base `6db667e`. Esta lane
commita o pendente (fix §21.2 + `docs/single-demo.md` do lane anterior) e em
seguida este fechamento (matrix §21 + DELIVERY §12 + public-demo apêndice).
Nada publicado; perfil global intocado; sem segredos.

## 22. Adendo mission-close (fechamento integral, 2026-10-25)

Escopo: inventário, checks frescos com isolamento de falhas, reconciliação
honesta sem upgrades, consolidação do DELIVERY §§1–12, commit local.
`src/` intocado (sem regressão real comprovada, nada a corrigir).
Modelo autorizado: `muse-spark-1.3-contributor (opencode-go)`.

### 22.1 Inventário (estado real)

- Branch `feat/autonomous-orchestrator-v2`, HEAD `8795430`, base `6db667e`
  (`merge-base HEAD 6db667e` = `6db667e`, corte exato).
- 24 commits locais sobre a base (`0b90745`…`8795430`; lista cheia em §22.4).
  SHAs-âncora confirmados: `cec1a78` fix(prompt), `4eb2ffb`
  fix(auto-complete), `404cd6e` docs(final-verify2), `8795430`
  test(prove-autocomplete).
- `git status` limpo, `git stash` vazio, sem untracked (`git ls-files
  --others` vazio). Remotes: `origin git@github.com:Thomaskynol/…` (fetch+push),
  `upstream https://github.com/nigel-dev/…` (fetch, `no_push`).
- Novos `src/lib` na branch: `auto-plan.ts`, `coordinator.ts`,
  `durable-state.ts`, `file-lock.ts`, `instance-manager.ts`, `reviewer.ts`;
  novos `src/orchestrator-cli/`: `auto-commands.ts`, `commands.ts`,
  `coordinator-client.ts`, `forms.ts`, `index.ts`; testes novos cobrindo cada um.

### 22.2 Checks frescos (log integral, exit capturado sem pipe)

| # | Comando | Resultado | Evidência |
| --- | --- | --- | --- |
| A | `bun run build` | **exit 0** — `Bundled 222 modules`, `index.js 1.37 MB` | `/tmp/opencode/mission-close-build.log` |
| B | `bun test` (full) | **exit 1** — **1044 pass, 6 fail**, 2458 expects, 1050 testes / 67 arquivos | `/tmp/opencode/mission-close-test.log` |
| C | `bun test tests/lib/tmux.test.ts tests/lib/tmux-isPaneRunning.test.ts` (isolado) | **exit 0** — **23 pass, 0 fail** | `/tmp/opencode/mission-close-tmux-isolated.log` |

Os 6 fails de B (todos em `tests/lib/tmux*.test.ts`: 4×
`isPaneRunning`, 1× `capturePane` inválido, 1× `tmux.test.ts
isPaneRunning`) são **pré-existentes e ambientais**: árvore limpa no HEAD
commitado = o próprio baseline (nada a `stash` — `git stash list` vazio,
`git status` limpo, `src/` idêntico ao commitado); C verde isolado repete o
padrão das lanes anteriores (flake sob paralelismo da suíte cheia, tmux
server compartilhado). Variação 7→6 fails entre lanes sem nenhuma mudança
de `src/` confirma flake, não regressão. Nenhum fail fora do domínio tmux.

### 22.3 Histórico real de contagens (esta árvore)

| Lane / log | pass | skip/fail | testes / arquivos | exit |
| --- | --- | --- | --- | --- |
| final-close (`final-close-test.log`) | 953 | 16 / 0 | 969 / 62 | 0 |
| guards (`guards-test.log`, §18: +10) | 963 | 16 / 0 | 979 / 62 | 0 |
| final-reconcile (`final-reconcile-test.log`) | 997 | 16 / 0 | 1013 / 65 | 0 |
| single-demo cedo (`single-evidence/00b`) | 1003 | 16 / 0 | — | 0 |
| single-demo meio (`single-evidence/00b`) | 1008 | 16 / 0 | — | 0 |
| single-4 (`single-evidence-4/00b-test.log`) | 1017 | 16 / 0 | 1033 / 66 | 0 |
| final-verify2 (`final-verify2-test.log`, stash-provado) | 1027 | — / 6 tmux | 1033 / 66 | 1 |
| prove-autocomplete (`53-full-test2.log`, +17 novos) | 1043 | — / 7 | 1050 / 67 | 1 |
| **mission-close, esta lane (`mission-close-test.log`)** | **1044** | — / 6 tmux | 1050 / 67 | 1 |

### 22.4 Commits finais (locais, sem push/PR)

Sobre base `6db667e` (`origin/main`): `0b90745` `82fb7f2` `e7764e7`
`d42dad0` `0a1eb3d` `ef73f78` `83d28be` `a8373f5` `0281b85` `2f4e762`
`fd86c39` `cc08140` `5fe245e` `841e9f1` `40dfca0` `8df7cab` `017cfc5`
`8b37e6c` `4065d91` `97a25e8` `cec1a78` `4eb2ffb` `404cd6e` `8795430`.
Esta lane adiciona 1 commit (matrix §22 + DELIVERY §13 + apêndice
public-demo). Nada publicado; perfil global intocado; sem segredos
(grep só acha `ask-user` como string de política).

### 22.5 Reconciliação — níveis finais honestos (sem upgrades nesta lane)

Nenhum `src/` alterado + nenhum ciclo live novo ⇒ nenhum ID sobe de nível
aqui. Reafirmado: INT-1…4 / COR-1…4 / EST-1…5 / INS-1…4 / TETO-1…3 /
REV-1…5 / FIX-1…4 / MER-1…5 / PRC-1…4 / PER-1…5 / REL-1…5 / MOD-1…2 /
SEG-1…3 / OBS-1…3 / E2E-A…D / ACE-1…2 / REC-1…9 mantêm os níveis das §§1–21
(Verificado/Validado conforme cada evidência citada). Pendentes reais que
seguem Pendentes: **E2E-E** (roteiro fase a fase não executado), **REC-4**
retomada do *intake* pós-crash (só testada em unidade), **PUBLISH_HINT** em
negação (2 starts `hello.txt` fail-closed), **`mc_report` ausente** nos
workers (conclusão por idle-threshold, `log` vazio — honesto no relatório),
**INS-5** sem teste dedicado, **E2E-B→E2E-E** lacunas menores já listadas.
Nada declarado completo que siga manual.
