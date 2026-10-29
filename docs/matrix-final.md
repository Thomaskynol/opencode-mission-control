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

## 23. Adendo repo-context-config (F02+F04+F11, HEAD 56656a6)

Escopo: `src/lib/orchestrator.ts`, `src/orchestrator-cli/auto-commands.ts`,
`src/lib/integration.ts`, `src/lib/paths.ts`, `src/lib/plan-state.ts`,
`src/lib/auto-plan.ts` (só carga de `--context`). Sem tocar
reviewer/merge-train/forms/model-tracker/monitor. Sem push/PR, sem perfil
global, modelo `muse-spark-1.3-contributor` autorizado, sem segredos.

| ID | Defeito (revisão) | Correção | Evidência |
| --- | --- | --- | --- |
| F02 | `startAutonomousPlan` recebia `--repo` mas criava `Orchestrator` do cwd; `startPlan` criava integração sem contexto; `getProjectId` só basename (colisão); `integration/git/paths/plan-state` usavam cwd | Contexto explícito fim-a-fim via `resolveRepoRoot` + `withRepoRoot` (AsyncLocalStorage, sem chdir): `paths.getProjectId/getDataDir` com hash canônico (`basename-hash12`), `plan-state` com `repoRoot?`, `integration` com `git -C repo` + worktree `git worktree add` no repo explícito, `orchestrator` com `repoRoot` + `createJobWorktree/removeJobWorktree` (delega ao helper legado só quando `repo==cwd` p/ compat), `auto-commands` resolve `--repo` canônico + `findIntakeAcrossRepos` p/ resume de terceira pasta | `tests/lib/repo-context-regression.test.ts` (colisão, estado e branch via caminho público `dispatchCommand start --repo A` com cwd!=A; integração `createIntegrationBranch(..., repoA)`) |
| F04 | Ceiling `{maxParallel,testCommand}` guardado no intake mas não aplicado (config 3, merge sem `testCommand`; clamp 4–8 reinterpretava teto 1) | `validateCeiling` fail-closed (`>=1` inteiro, `testCommand` não-vazio); `resolveEffectiveMaxParallel/TestCommand` (explícito vence, sem clamp; 4–8 só default interno do coordenador com compensação); `applyCeiling` no `startAutonomousPlan` (até com `launch:false`) e restaurado no `resumeAutonomousIntake`; `getEffectiveMaxParallel/TestCommand` expostos; `getMergeTrainConfig` lê config efetiva; `_doReconcile` usa `getEffectiveMaxParallel()` | `tests/lib/ceiling-context-regression.test.ts` (ceiling 1 + `echo hi` via `Orchestrator.startAutonomousPlan` público com `launch:false`; inválido 0 rejeita; `clampMaxParallel(1)==4` documenta reinterpretação antiga) |
| F11 | `--context` passava só path no prompt, sem leitura nem persistência | Contrato em `auto-plan.ts` (`loadContextDocs/formatContextDocsForPrompt`): `text:<...>` ou newline → inline, senão path (absoluto ou relativo a `--repo`, ≤256KB, UTF-8, não-vazio; ausente falha explícita); prompt recebe `--- context ref:sha:scope ---\n<conteúdo>`; intake preserva `{ref,content,hash,scope}` (`repo`/`external`/`inline`) e decisão `context loaded`; resume preserva e loga `context preserved` | `tests/lib/ceiling-context-regression.test.ts` (arquivo real `ctx.txt` com payload único: prompt contém conteúdo, intake contém path+conteúdo, resume mantém) |

Verificação desta lane (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`Bundled 222 modules`); `bun test` → exit 1 —
**1050 pass, 6 fail** (1056 testes / 69 arquivos; +6 testes vs 1044/1050/67 do
mission-close; 6 fails só `tests/lib/tmux*.test.ts`, pré-existentes e
ambientais, mesmos nomes do baseline §22.2, sem fail fora do domínio tmux).
Evidência: `/tmp/opencode/full-test3.log` (+ `/tmp/opencode/full-test.log`).
Repro-antes (TDD RED): colisão `proj==proj`, estado em launcher, `getEffective`
ausente, `0` aceito, prompt só com path — visto em
`tests/lib/repo-context-regression.test.ts` + `ceiling-context-regression.test.ts`
(2 fail + 3 fail antes do fix, 0 fail depois isolado, 0 fail no full exceto tmux).

Limitações restantes (adendo honesto):
1. `worktree.ts`/`job-state.ts`/`reports.ts`/`durable-state.ts`/`config.ts`/`monitor.ts`
   não tocados (outro owner): escopo repo chega a eles via `withRepoRoot` + `getDataDir`
   ativa; `git` sem `cwd` nesses arquivos continua cwd-dependente fora dos caminhos
   cobertos (`orchestrator`/`integration` reimplementam com `cwd` explícito).
2. `coordinator.ts` não tocado: `decideNextJobs` ainda `clampMaxParallel` 4–8
   internamente, mas `runCoordinatorPass` compensa `(clamp-config)` preservando teto
   explícito (1 continua 1); sem mudança, sem reinterpretação silenciosa no uso efetivo.
3. `resume --intake` sem `--repo` faz busca em todos os XDG (`findIntakeAcrossRepos`);
   intake segue slot único (sobrescreve) — trilha em decisões, sem migração de antigos
   `basename` puros (IDs antigos `basename` não resolvem p/ novo `basename-hash`; re-start
   necessário p/ runs antigos).
4. `--context` múltiplo: `--context` singular (último vence no `parseFlags`); múltiplos
   exigem `text:` múltiplo futuro ou repetição de flag (não implementado p/ manter diff mínimo).
5. `E2E-E` segue Pendente (roteiro fase a fase não executado); merges reais com workers
   vivos não re-demonstrados nesta lane (cobertos por `live-proof.md` + `single-demo`).
6. Flake tmux (6 fails) inalterado, ambiental, com prova de pré-existência (§22.2).

## 24. Adendo review-destination-report (F01+F08+F09, HEAD desta lane)

Escopo: `src/lib/reviewer.ts`, `src/lib/merge-train.ts`,
`src/lib/orchestrator.ts`, `src/lib/durable-state.ts` (só persistência de
evidências/decisões), `src/tools/report.ts`. Sem tocar
auto-commands/forms/paths/plan-state/integration/model-tracker. Sem push/PR,
sem perfil global, modelo `muse-spark-1.3-contributor` autorizado, sem segredos.

| ID | Defeito (revisão) | Correção | Evidência |
| --- | --- | --- | --- |
| F01 | Caminho normal sem revisão (`getMergeTrainConfig` sem `requireReviewPass`, `processNext()` sem veredito, ausência aceita, sem `testCommand` vira success skipped; `reviewJob`/`runReviewFixLoop` sem chamador; substring fraca aprova `echo` com âncora) | `getMergeTrainConfig` com `requireReviewPass:true` (fail-closed autônomo; legado permissivo só em chamadores diretos de `MergeTrain`); `buildReviewInput` coleta evidência observada pelo produto (comando+exit+saída+commit+ambiente) + `reviewJobWithFixLoop` (`reviewJob`+`runReviewFixLoop`) no caminho real antes de `processNext(verdict)`; sem `testCommand` ou diff vazio bloqueia em modo estrito (nunca success-skipped como verificado); `anchorCovered` exige match em saída com contexto de runner (eco exato falha) + `environment` obrigatório (texto declarado sem proveniência falha) | `tests/lib/review-destination-regression.test.ts` (eco, sem-env, omitido→fail, strict sem-teste→`review_blocked`, `requireReviewPass:true`); RED antes: 2 pass 5 fail; GREEN depois: 7 pass 0 fail |
| F08 | Destino configurado sem entrega (integração em intermediária, fim local condicionado a PR, main intacta) | `completeLocalDestination`: separa base/integração/destino final; após verificações, merge local `--no-ff` na destino sem push/PR, suja recusa (protege preexistente), reverifica com `testCommand` se destino avançou desde `baseCommit`; `allMerged` conclui local (`completed`, sem `prUrl`) quando sem `humanAuth` em vez de pausar em `pre_pr`; supervisor mantém `pre_pr` após entrega local (PR pendente, destino já recebido) | Mesmo arquivo de regressão (destino contém integração, `ship.txt` presente, suja recusa); `tests/lib/monitor-autocomplete.test.ts` atualizado (auth-negado agora `completed`, não `paused`) |
| F09 | Relatório com seções vazias (`decisions/files/installUsage/tests/verified/limitations` vazios, pedido resumido, `MergeTestReports` perdidos, falha engolida) | `durable-state.mergeEvidence` (`save/loadMergeEvidence`, preservado em todos RMW); `processNext` sucesso conserva evidência; `writeAutoFinalReport` + `mc_report_final` reúnem pedido/decisões/committs/testes/aceitação reais, `MergeTestReports` como anexos, `verified` só com `passed` conservado, `limitations` real; falha de geração notifica+log em vez de `catch{}` | Mesmo arquivo (builder com dados reais); `report-final.test.ts` segue verde (sem evidência→`verified` vazio); `writeAutoFinalReport` agora loga `auto final report failed` em vez de silêncio |

Regressões via caminho público (sem harness por fora):
- Pedido público com entrega in-scope, testes verdes e requisito omitido → `reviewJob` fail `REQ-EMPTY`, correção pedida via `on_error`+`mc_plan_approve` (não integra).
- Entrega sem teste → `MergeTrain` estrito retorna `review_blocked` (HEAD intacto), nunca `merged` como verificado.
- Conclusão local na destino + relatório com evidências reais, sem PR/push (merge local + `completed` + anexos `MergeTestReport`).

Verificação desta lane (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`Bundled 223 modules`, `index.js 1.42 MB`,
`/tmp/opencode/f01f08f09-build.log`); focado
`review-destination+reviewer+merge-train+durable+autocomplete+orchestrator+modes+wire`
→ exit 0 (**173 pass, 0 fail**,
`/tmp/opencode/f01f08f09-focused.log`); full `bun test` → exit 1 —
**1057 pass, 6 fail** (1063 testes / 70 arquivos; 6 fails só
`tests/lib/tmux*.test.ts`, pré-existentes e ambientais, mesmos nomes do
baseline §22.2; +7 testes vs 1050/69 do repo-context; sem fail fora do
domínio tmux; `/tmp/opencode/full-test-f08.log`).
Repro-antes (TDD RED): `review-destination-regression` 2 pass 5 fail (eco,
sem-env, strict sem-teste success, `requireReviewPass` ausente,
`completeLocalDestination` ausente); repro-depois (GREEN): 7 pass 0 fail.

Limitações restantes (adendo honesto):
1. `reports.ts`/`git.ts` intocados (outro owner/legado): relatório usa dados
   conservados via `durable-state`; `git` sem `cwd` fora dos caminhos cobertos
   segue cwd-dependente (orchestrator reimplementa com `cwd` explícito).
2. Planos manuais sem intake e sem aceitação mantêm só test-gate (evidência
   ainda exigida): fail-closed integral vale no caminho público (intake
   sempre tem requisitos/aceitação); legado manual preservado p/ suítes de
   integração (`orchestration.test.ts` 4 pass sem intake).
3. `E2E-E` segue Pendente; workers vivos não re-demonstrados nesta lane.
4. Flake tmux (6 fails) inalterado, ambiental, com prova de pré-existência.

## 25. Adendo replan-auth-model-resume (F03+F05+F06+F07, HEAD desta lane)

Escopo: `src/lib/orchestrator.ts`, `src/lib/coordinator.ts`, `src/orchestrator-cli/forms.ts`,
`src/orchestrator-cli/auto-commands.ts`, `src/orchestrator-cli/commands.ts`,
`src/lib/auto-plan.ts` (só model resolve), `src/lib/model-tracker.ts`,
`src/lib/durable-state.ts` (só reconcile/persistência intake),
`src/lib/prompt-file.ts` (só variant). Sem tocar merge-train/reviewer/paths/plan-state/integration/reports.
Sem push/PR, sem perfil global, modelo `muse-spark-1.3-contributor` autorizado.

| ID | Defeito (revisão) | Correção | Evidência |
| --- | --- | --- | --- |
| F03 | Complement só salvava texto (request muda, plan.json não); `applyModelAdjustment` sem chamador de produção; coordinator puramente determinístico; dispatch ignorava prompt calculado | Complement dispara revisão real via modelo (mesmo slot generate do intake): persiste versão de requisitos, cria tarefas novas/correções via `addJob`/`applyModelAdjustment`, preserva pausa/decisões; `runCoordinatorPass` usa `req.prompt` calculado; nunca anuncia scheduler antes de agendar (mensagem reflete added/reconciler real) | `tests/lib/f03f05f06f07-regression.test.ts` (complement com requisito novo cria task-b ou registra pergunta humana, nunca só Follow-up); RED antes: fail, GREEN depois: pass |
| F05 | `answerViaPermission` só poucas palavras inglesas negavam, resto caía em approved=true ("não autorizo"→once) | Decisão explícita separada de conteúdo: listas PT+EN de approve/deny validadas positivamente; vazio/pergunta/"aguarde"/ambíguo NUNCA aprova — lança esclarecimento sem enviar decisão; `answerQuestion` propaga clarification sem remover a pergunta (só offline registra) | Mesmo arquivo (não autorizo→reject; aguarde/vazio/pergunta→throw sem fetch; sim/não/aprove PT+EN funcionam); teste legado de free-text→once atualizado para fail-closed |
| F06 | Planner resolve fallback fixo sem tracker; coordinator unknown/unknown; TUI sem variant; InstanceManager não instanciado | Modelo efetivo 1x por execução (env→tracked→config, fallback só com aviso explícito, nunca silencioso); `model-tracker` preserva variant (pin triplo); planner+coordinator observam o mesmo triple; launcher TUI carrega triple com nota de variant (CLI -m sem forma de variant); `coordinateOnce` fail-closed contra unknown/unknown; intake persiste `effectiveModel`/`effectiveVariant` para retomada | Mesmo arquivo (planner==coordinator; sem tracker avisa em vez de silêncio; coordinator nunca unknown silencioso; variant max atravessa tracker→coordinator) |
| F07 | Pedido persistido só após planner+base; awaiting-plan sem retomada real; resume sem plano não gera; resumePlan só running/paused; "Resumed" vazio; reconcileOnBoot sem chamador | Persiste antes de operações longas (awaiting-plan precoce); vincula intake↔planId duravelmente; `resumePlan` reconcilia transições recuperáveis (pending/merging/creating_pr→running, com retry de creating_pr via merging); `resumeAutonomousIntake` com generate: awaiting-plan gera plano, merging/creating_pr reativa com mensagem explícita (reativado/aguardando/inconsistência, nunca "Resumed" vazio); `reconcileOnBoot` chamado no boot público | Mesmo arquivo (awaiting-plan gera plano, não "no active plan"; queda em merging volta a running com reativado; kill-9 simulado reconcilia) |

Regressões via caminho público (sem harness por fora):
- Complement com requisito novo muda resultado funcional ou registra decisão humana necessária (nova task via caminhos existentes ou pergunta).
- "não autorizo"/"aguarde"/vazio/pergunta nunca geram once/allow; approve/deny estruturados PT+EN funcionam.
- Modelo/variant efetivos observados iguais nos caminhos usados; sem divergência silenciosa.
- Retomada com planejamento interrompido gera plano; queda em merging reativa sem sucesso vazio; kill-9 simulado (processo morto com estado em disco) reconcilia.

Verificação desta lane (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`index.js 1.43 MB`, `/tmp/opencode/f03f05f06f07-build.log`);
focado 11 arquivos (`f03f05f06f07+auto-commands+human-controls+coordinator+auto-plan+model-tracker+ceiling+repo-context+review-destination+orchestrator+wire`) → exit 0 (**197 pass, 0 fail**, `/tmp/opencode/f03f05f06f07-focused.log`);
full `bun test` → exit 1 — **1066 pass, 7 fail** (`/tmp/opencode/f03f05f06f07-full2.log`): 6 fails só `tests/lib/tmux*.test.ts` (pré-existentes e ambientais, mesmos nomes do baseline §22.2) + 1 `wire-report createPR` ambiental (passa isolado 11 pass e no focado 197 pass; falha só no full de 71 arquivos por interferência de mocks/estado compartilhado, mesmo padrão do flake 6→7 da lane prove-autocomplete).
Baseline sem esta lane (stash): exit 1 — **1057 pass, 6 fail** (todos tmux, `/tmp/opencode/baseline-full.log`).
Repro-antes (TDD RED, isolado): `f03f05f06f07-regression` 1 pass 9 fail (não-autorizo→once, aguarde→send, PT sem deny, fallback silencioso, unknown/unknown, complement sem task, awaiting-plan vazio, merging preso); repro-depois (GREEN): 10 pass 0 fail.

Limitações restantes (adendo honesto):
1. `question-relay.ts handleUserResponse` (dead code, sem chamador de produção) mantém fallback antigo — fora do escopo de escrita desta rodada; caminho vivo (`forms.ts answerViaPermission`) está fail-closed e o morto está documentado, não wired.
2. `InstanceManager` segue não instanciado no caminho tmux (workers tmux não passam por serve): equivalência de perfil vale no caminho serve (`assertProfileEquivalence`); no caminho tmux a garantia é o triple efetivo único + `coordinateOnce` fail-closed, sem swap silencioso.
3. Launcher TUI (`-m`) não tem forma de variant: triple completo vive no snapshot/coordinator/serve; launcher carrega string + nota de variant (quando suportada, serve a usa; CLI documenta o limite).
4. `E2E-E` segue Pendente; workers vivos não re-demonstrados nesta lane (regressões via caminho público com mocks + estado em disco, sem LLM vivo).
5. Intake segue slot único (sobrescreve); `findIntakeAcrossRepos` cobre resume de terceira pasta via XDG.
6. Flake tmux (6 fails) inalterado, ambiental, com prova de pré-existência (§22.2).

## 26. Adendo lock-plugin (F12+F10, HEAD desta lane)

Escopo: `src/lib/file-lock.ts`, `src/lib/integration.ts` (só uso do lock),
`src/index.ts` (só adaptação F10), `docs`. Sem tocar
reviewer/orchestrator/forms/model/coordinator. Sem push/PR, sem perfil global.

| ID | Defeito (revisão) | Correção | Evidência |
| --- | --- | --- | --- |
| F12 | `file-lock` removia lock só por idade (`staleMs` 660s integração) enquanto setup/teste/retry podem segurar mais; e "flock inter-processo" impreciso (é lockfile O_EXCL com expiração, não flock) | Lease com heartbeat do dono: holder atualiza mtime periodicamente (`heartbeatMs` default `min(max(1000,stale/3),30000)` — 30s p/ integração 660s); stale exige idade SEM progresso de heartbeat (re-stat antes de quebrar evita corrida com heartbeat); `heartbeatMsFor` exportado; header+comentários corrigidos p/ "lockfile with lease — not flock(2)"; `withIntegrationLock` documenta lease | `tests/lib/file-lock.test.ts` (2 processos, hold 3s > stale 2s: contender timeout, sem invasão; stale morto segue quebrado) |
| F10 | `src/index.ts` era função Plugin legada (`@opencode-ai/plugin`); cliente HTTP próprio fala /api V2 mas não comprova carga como plugin V2 | Contrato oficial 2.1.4 investigado (host exige `default` objeto `{id, setup}`; função com `id+setup` rejeita `Expected object`; padrão migrate-v1 `event→subscribe`, `chat.message→session prompt`, `compacting→session compaction` confirmado via `caveman/server.js`); adaptador mínimo em `src/index.ts`: `MissionControl` V1 preservado (named), `default` vira `{id:'opencode-mission-control', setup}` que reusa V1 (single source) + converte 21 tools V1→V2 (`z.toJSONSchema` + string→`{content}`), `tool.transform/hook`, `event.subscribe`, `session.hook(prompt/compaction)`; `client.config/tui` defensivos (`?.`) + shim V2 (`session`→`client.session`, `config/tui` no-op) | `tests/plugin-init.test.ts` (V1 via named, 21 tools; V2 `default.id/setup` + 21 tools via transform); carga real via `.opencode/plugins` por projeto + `opencode run --standalone --print-logs` sem tocar perfil global |

Provas F10 (sem tocar perfil global, só `/tmp/opencode/f10-probe`):
- RED (antes do adaptador): `loading plugin …/mc-test` + `failed to load plugin … Expected object at ["default"]` (`/tmp/opencode/f10-v2-load.log` na lane de prova; reproduzido com `dist/index.js` V1).
- GREEN (após adaptador): `loading plugin …/mc-test` 2×, **0 `failed to load plugin`** (`/tmp/opencode/f10-v2-load2.log`); único erro é `provider.auth User not found` (probe isolado sem auth, sem relação com plugin).
- Contrato V2 confirmado via `ctx-dump` (`/tmp/opencode/ctx-dump.json`): `ctx` sem `client`, com `session` (`list/get/prompt/...`), `tool` (`transform/hook`), `location.directory`; função com props rejeitada, objeto aceito (probes `mc-func`/`mc-obj`).

Verificação desta lane (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`index.js 1.44 MB`, `/tmp/opencode/f12f10-build.log`);
focado `tests/plugin-init.test.ts tests/lib/file-lock.test.ts` → exit 0 (**20 pass, 0 fail**);
full `bun test` → exit 1 — **1069 pass, 7 fail** (`/tmp/opencode/f12f10-test.log`):
6 fails `tests/lib/tmux*.test.ts` (mesmos nomes §22.2) + 1 `wire-report createPR`
(ambiental, mesmo padrão F03: passa isolado).
Isolados verdes: `tmux+tmux-isPaneRunning` exit 0 (**23 pass**,
`/tmp/opencode/f12f10-tmux-isolated.log`); `wire-report` exit 0 (**11 pass**,
`/tmp/opencode/f12f10-wire-isolated.log`).
Repro-antes F12 (TDD RED): holder 4s + stale 2s → contender `ACQUIRED (INVASION)`
sem fix; após fix → `TIMED_OUT`, sem `invaded`, holder completo.
Limitações honestas F10: carga V2 comprovada (loader aceita, setup sem erro);
execução real das 21 tools via V2 com LLM vivo **não validada** (probe isolado
sem auth; validar = projeto com auth + `mc_status` via V2); `command.execute.before`
/`config` sem equivalente V2 mapeado (pendente, documentado no código); V1
preservado via named `MissionControl` (testes usam named; `default` agora é V2).

## 27. Adendo final-findings (consolidação F01–F12, HEAD desta lane)

Consolidação dos achados F01–F12 das lanes pós-`56656a6`. Nível por achado:
**Corrigido** (fix + regressão verde + sem regressão no full) /
**Parcial** (fix prova um recorte; resto pendente explícito). Nenhum
Pendente integral: todos têm correção commitada e regressão verde.

| ID | Achado | Status | Teste regressivo | Commit |
| --- | --- | --- | --- | --- |
| F01 | Caminho normal sem revisão (merge sem veredito, sem-teste virava success-skipped, âncora fraca) | **Corrigido** | `tests/lib/review-destination-regression.test.ts` (7 pass; RED 2 pass 5 fail antes) | `0b958cc` |
| F02 | `--repo` ignorado (Orchestrator/integração/paths no cwd, `getProjectId` só basename) | **Corrigido** | `tests/lib/repo-context-regression.test.ts` (RED 2 fail antes, GREEN depois) | `c5ede03` |
| F03 | Complement só salvava texto (plano intocado) | **Corrigido** | `tests/lib/f03f05f06f07-regression.test.ts` (RED 1 pass 9 fail, GREEN 10 pass) | `5b46991` |
| F04 | Ceiling guardado mas não aplicado (teto 1 reinterpretado p/ 4–8, merge sem `testCommand`) | **Corrigido** | `tests/lib/ceiling-context-regression.test.ts` (RED 3 fail antes) | `c5ede03` |
| F05 | `answerViaPermission` aprovava por omissão ("não autorizo"→once) | **Corrigido** | mesmo `f03f05f06f07` (deny/clarify PT+EN; legado free-text→once atualizado p/ fail-closed) | `5b46991` |
| F06 | Modelo efetivo divergente (fallback fixo, unknown/unknown silencioso, variant perdida) | **Corrigido** (limites §25.1–3: sem InstanceManager no caminho tmux; TUI `-m` sem variant) | mesmo `f03f05f06f07` (planner==coordinator, nunca unknown silencioso) | `5b46991` |
| F07 | Resume sem retomada real (awaiting-plan vazio, merging preso, `reconcileOnBoot` sem chamador) | **Corrigido** | mesmo `f03f05f06f07` (awaiting-plan gera plano; kill-9 simulado reconcilia) | `5b46991` |
| F08 | Destino configurado sem entrega (fim local condicionado a PR) | **Corrigido** | mesmo `review-destination` (`completeLocalDestination`, suja recusa) | `0b958cc` |
| F09 | Relatório com seções vazias, `MergeTestReports` perdidos, falha engolida | **Corrigido** | mesmo `review-destination` + `report-final.test.ts` verde | `0b958cc` |
| F10 | Plugin só V1 (`default` função rejeitada pelo host 2.1.4) | **Parcial**: carga V2 provada (loader aceita, setup sem erro); execução real das 21 tools via V2 com LLM vivo **pendente** | `tests/plugin-init.test.ts` (V1 named + V2 `default.id/setup`); probes `/tmp/opencode/f10-v2-load2.log` + `ctx-dump.json` | `c765364` |
| F11 | `--context` só path no prompt, sem leitura nem persistência | **Corrigido** | mesmo `ceiling-context` (conteúdo inline no prompt, intake+resume preservam) | `c5ede03` |
| F12 | Lock quebrado por idade com holder vivo (setup/teste > 660s) | **Corrigido** | `tests/lib/file-lock.test.ts` (RED invasão antes, `TIMED_OUT` sem invasão depois) | `a91cd3e` |

Verificação desta lane (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`Bundled 223 modules`, `index.js 1.44 MB`,
`/tmp/opencode/final-findings-build.log`); full `bun test` → exit 1 —
**1069 pass, 7 fail** (`/tmp/opencode/final-findings-test.log`, 1076 testes /
71 arquivos — totais idênticos aos da lane F12+F10, §26). Os 7 fails são os
mesmos nomes/arquivos do baseline documentado (§22.2 + §§25–26): 6×
`tests/lib/tmux*.test.ts` (4 `isPaneRunning`, 1 `capturePane` inválido, 1
`tmux.test.ts isPaneRunning`) + 1× `wire-report createPR` (ambiental, mesmo
padrão F03). Prova de isolamento (ambos exit 0): tmux isolado **23 pass**
(`/tmp/opencode/final-findings-tmux-isolated.log`); wire isolado **11 pass**
(`/tmp/opencode/final-findings-wire-isolated.log`). **Nenhum fail fora do
conjunto baseline ⇒ nenhuma regressão ⇒ `src/` intocado nesta lane.**

Revalidação live: `src/` mudou em todas as lanes F01–F12 após os ciclos live
(`live-proof.md`, `public-demo.md` Casos 1/2, `single-demo` single-4), logo
**revalidação live ponta-a-ponta dos caminhos alterados (gate estrito,
`completeLocalDestination`, complement via modelo, permissão fail-closed,
lease do lock, execução V2) segue pendente** — nenhuma cobertura live nova é
alegada aqui. Evidências live anteriores valem onde o caminho segue
inalterado desde a demo (coordenador juiz único, kill-9/resume do plano,
teto com compensação, TUI pause/resume e forms G1/G2, triplo G3).

## 28. Adendo v2-validation (F10: carga × registro × execução, HEAD desta lane)

Escopo: validação V2 completa em 3 camadas separadas, sem tocar `src/`
(nenhum gap bloqueante encontrado → adaptador intocado), sem push/PR, sem
perfil global. Base `d6d0d73`. Modelo: nenhum chamado (zero custo; consumo
desconhecido = 0 nesta lane — só leitura/status via harness local).

| Camada | O que foi provado | Como | Evidência |
| --- | --- | --- | --- |
| 1. Carga | Plugin carrega no loader V2 real 2.1.4, por projeto (`.opencode/plugins`, sem tocar perfil global), **0 `failed to load plugin`** | `opencode run --standalone --print-logs` em `/tmp/opencode/v2/proj` com `dist/index.js` fresco copiado p/ `.opencode/plugins/mc-v2/index.js` (timeout 25s; exit 1 só pelo `User not found` do probe sem auth, sem relação com o plugin) | `/tmp/opencode/v2/load.log` (22 `loading plugin`, 2× `mc-v2`, 0 failed; erro único `AI.Error.Authentication: User not found`) + `/tmp/opencode/v2/run-load-probe.sh` |
| 2. Registro | As 21 tools registradas via `default.setup` → `tool.transform`: nome + descrição + input objeto + `execute` função, **por tool**; `input.properties` == chaves de `args` V1 por tool; sem nenhuma chamada LLM (validação contra o adaptador + harness local) | `tests/v2-contract.test.ts` (novo): `registers exactly the 21 expected tools` + `it.each(21)` forma + `input properties match v1 args keys` | `bun test tests/v2-contract.test.ts` → exit 0, **26 pass, 0 fail** (`/tmp/opencode/v2/` não guarda este log; reproduzível via comando) |
| 3. Execução | Execução real representativa via plugin carregado no V2 (bundle `dist`, `setup` **sem `client`** = caminho shim do host real): `mc_overview` + `mc_jobs` + `mc_plan_status` retornam `{content:[{type:'text',text}]}` com conteúdo correto | harness `/tmp/opencode/v2/v2-exec.mjs` + `/tmp/opencode/v2/v2-exec-detail.mjs` (timeout 60s, cwd `/tmp/opencode/v2/exec-probe`, estado vazio) | `/tmp/opencode/v2/exec.log` (21 tools, 3 ok), `exec-mc_overview.txt` (`Mission Control Dashboard`, 436 chars), `exec-mc_jobs.txt` (`No jobs found`), `exec-mc_plan_status.txt` (`No active plan`), `registered-21.json`, `schema-*.json` |

Gaps registrados (degradação graceful, nenhum bloqueia execução):
1. `config`/`command.execute.before` V1 sem equivalente mapeado no V2
   (slash-commands indisponíveis via V2; tools/eventos/prompt/compactação
   mapeados). Pendente documentado desde §26, inalterado.
2. `sessionID:''` no contexto de `execute` do adaptador: `mc_launch`/`mc_plan`
   usam `context?.sessionID` só p/ `launchSessionID` + `getCurrentModel`
   (optional chaining → fallback, sem crash). Leitura/status não usam sessão.
3. Shim V2 (`session.list→[]`, `config.get→{}`, `tui.showToast→no-op`,
   `session.prompt→no-op` com `catch{}`): setup nunca falha por superfície
   ausente; monitor/notificações sobem sobre o shim sem erro (carga com 0
   failed prova).
4. `directory/worktree` do `execute` = `process.cwd()` no momento da chamada
   (não o `location.directory` de setup): correto no host real (cwd = projeto)
   e no harness (chdir p/ probe).
5. Não executado via LLM vivo: `mc_launch` descartável / dry-run real e as 17
   tools com side effects (kill/merge/cleanup/answer/…). Via LLM exigiria
   modelo autorizado + tmux/worktrees — fora do recorte sem-custo desta lane,
   segue pendente explícito (F10 abaixo).

Verificação desta lane (fresca, log integral, exit capturado sem pipe):
`bun run build` → exit 0 (`Bundled 222 modules`, `index.js 1.43 MB`,
`/tmp/opencode/v2/build.log`); `bun test tests/v2-contract.test.ts` → exit 0
(**26 pass, 0 fail**); full `bun test` → exit 1 — **1113 pass, 7 fail**
(1120 testes / 77 arquivos, `/tmp/opencode/v2/full-test.log`): 6×
`tests/lib/tmux*.test.ts` + 1× `wire-report createPR` — mesmo conjunto
ambiental do baseline (§22.2 + §§25–27), nenhum fail fora do domínio
conhecido. Isolamentos ambos exit 0: tmux **23 pass**
(`/tmp/opencode/v2/tmux-isolated.log`); wire **11 pass**
(`/tmp/opencode/v2/wire-isolated.log`). `src/` intocado (só `tests/` novo +
este adendo) ⇒ nenhuma regressão introduzida. Perfil global intocado
(só `/tmp/opencode/v2/proj/.opencode/plugins/mc-v2/`); sem segredos; sem
push/PR.

Status F10 após esta lane: **Parcial-alta** — carga (0 failed loads) +
registro (21 contratos) + execução representativa sem-custo (overview/jobs/
plan_status via V2) comprovados; execução das 17 tools com side effects via
LLM vivo segue pendente e não alegada.

## 29. Adendo review-packet-2 (consolidação da rodada, HEAD `c2759a1`)

Escopo desta rodada (sem push/PR, sem perfil global): 5 commits locais
`91f96ae..c2759a1` + validações live + este adendo (só `docs/`).
Base de comparação: `6db667e` (upstream). Modelo live:
`opencode-go/muse-spark-1.3-contributor` (banner TUI + `effectiveModel`).

### 29.1 Suíte: causa, fix, sequência de contagens (comandos exatos)

Causa: poluição entre arquivos de teste. Prova: `focused.log` (13:44,
seleção 2-arquivos `dest-branch` + `review-destination`) falha em nível de
import (`getProjectId is not a function`, `SyntaxError: Export named
'getActiveRepoRoot' not found`) enquanto os mesmos arquivos **isolados**
passam (`revdest-alone.log` 7/0, `planstate-alone.log` 26/0,
`prestash.log` 7/0). Os 3 arquivos históricos com `mock.module`
(`tests/lib/monitor.test.ts:4,13,19`,
`tests/lib/monitor-v2.test.ts:6,14,20`,
`tests/integration/z-workflows.test.ts:37,84,96,118`) seguem intocados
nesta rodada — a contenção foi não adicionar nenhum `mock.module` novo:
os 6 arquivos de teste da rodada usam `spyOn` + `mock.restore()` em
`afterEach` (0 ocorrências de `mock.module` em `gap1-integration-context`,
`gate-resume-approve` (4× `mock.restore`), `dest-branch`,
`launcher-flag-regression`, `gap2-approve-intake`, `v2-contract`).

Fix real encontrado pela suíte cheia (ordem cheia não reproduz a poluição
do focused e revelou o bug de verdade): `d6d0d73` (baseBranch perdido no
round-trip `PlanSpecSchema`; `full.log` 13:45 = 1093/1 só nesse teste →
`full2.log` 13:47 = 1094/0).

Sequência (comando padrão da lane: `bun test` full com stdout em arquivo e
`EXIT` capturado sem pipe; `bun run build` idem):

| Quando | Log | Contagem | Arquivos | Contexto |
| --- | --- | --- | --- | --- |
| 11:49 | `full-before.log` | 1069 pass / 7 fail | 1076 / 71 | HEAD anterior `91f96ae`; 7 = 6× tmux + 1× wire (mesmo conjunto §22.2) |
| 11:53–11:54 | `full-after-monitor-fix.log`, `full-after.log`, `full-final.log` | **1076 / 0** | 1076 / 71 | mesma árvore `91f96ae` (nenhum commit entre os runs) → delta 7→0 **ambiental/ordenação**, sem fix de código alegado aqui |
| 12:13 | `launcher-flag-full.log` (+`launcher-flag-build.log` exit 0) | **1080 / 0** | 72 | após `c788c1c` (+1 arquivo `launcher-flag-regression`) |
| 13:23 | `verify-gate/full.log` | **1092 / 0** | 75 | após `a48000f` (+gap1+gap2+gate) |
| 13:45 | `full.log` | 1093 pass / **1 fail** | 1094 / 76 | após `d10bb3a`+`a48000f` (+dest-branch); fail único = bug real baseBranch |
| 13:47 | `full2.log` | **1094 / 0** | 1094 / 76 | após `d6d0d73` (fix) |
| 13:51 | `v2/full-test.log` | 1113 pass / 7 fail | 1120 / 77 | após `c2759a1` (+26 `v2-contract`); 7 = mesmos ambientais; isolados exit 0: tmux 23 pass (`v2/tmux-isolated.log`), wire 11 pass (`v2/wire-isolated.log`) |

HEAD anterior vs base: "HEAD anterior" acima = `91f96ae` (71 arquivos,
1076 testes) — último ponto com suíte cheia antes da rodada. Sobre a base
`6db667e`: **nenhuma suíte foi rodada na base `6db667e` nesta rodada**
(nenhum log a comprova); o conjunto dos 7 ambientais é o documentado desde
§22.2 e §§25–28, mas baseline original na `6db667e` **não é alegado aqui
por falta de prova** — declarado explicitamente.

### 29.2 Matriz F01–F12 (implementação + evidência + nível)

Legenda: **Validado live** (exercício real com modelo vivo) /
**Verificado teste** (regressão verde, sem live) / **Parcial** /
**Pendente**. "Mocks" = `spyOn`+restore; "fixtures" = repos git reais em
tmpdir (sem LLM/tmux); "live" = modelo vivo + tmux + worktrees reais.

| ID | Implementação (arquivo:linha/função) | Teste regressivo (mocks/fixtures) | Evidência live | Nível |
| --- | --- | --- | --- | --- |
| F01 gate estrutural+final | `src/lib/orchestrator.ts:510` `reviewJobWithFixLoop` (veredito `pass/fail`, `src/lib/reviewer.ts` `ReviewVerdict`); pré-merge estrutural em `merge-train.ts` + gate único pós-all-merged | `tests/lib/review-destination-regression.test.ts` (fixtures git reais) + `tests/lib/gate-resume-approve.test.ts` (spyOn+restore) + `tests/lib/gap1-integration-context.test.ts` | revalidate item 1 **PASS** (`14/18-decisions`, `19-final-check-integration` CHECK PASS); demo-fixes2 gate bloqueou fail-closed (registrou veredito) | **Validado live (item 1)** |
| F02 repo explícito | `src/lib/paths.ts:30` `getActiveRepoRoot`, `:52` `resolveRepoRoot`, `:64` `getProjectId` | `tests/lib/repo-context-regression.test.ts` | terceira pasta (launcher ≠ repo ≠ produto) em demo-fixes2, revalidate (`rv-repo`+`launcher/`), final-live (`fl-repo`+`launcher3/`) | **Validado live (terceira pasta)** |
| F03 complement com revisão | `src/lib/orchestrator.ts:2412` `complementAutonomousRequest` (revisão real via modelo, `appendAutoDecision`) | `tests/lib/f03f05f06f07-regression.test.ts` | revalidate: `COMPLEMENT_EXIT=0` + "complement revision: 5 requirements, +0 tasks" (decisões/questions atualizados); final-live + demo-fixes2: registrado, **sem efeito em arquivos** (workers já haviam terminado) | **Parcial** (decisões/questions sim; efeito em arquivos não demonstrado) |
| F04 ceiling | `src/lib/orchestrator.ts:92` `validateCeiling` (teto explícito respeitado; 4–8 só default); `applyEffectiveConfig` no approve (`a48000f`) | `tests/lib/ceiling-context-regression.test.ts` | final-live B1 (`maxParallel: 2` respeitado, 2 running) + revalidate (4 simultâneos, `04-tmux-simultaneous.log`) | **Validado teste + live** |
| F05 fail-closed PT | `src/orchestrator-cli/forms.ts:147` `answerViaPermission` (deny/clarify PT+EN, sem aprovação por omissão) | mesmo `f03f05f06f07` (deny/clarify PT+EN) | `'não autorizo'` real **não exercido** live | **Verificado teste; live pendente** |
| F06 triple | mesmo modelo planner==coordenador (sem `unknown/unknown` silencioso; `model-tracker.ts` + `auto-commands.ts`) | mesmo `f03f05f06f07` (planner==coordinator, nunca unknown silencioso) | planner+serve validados; TUI launcher sem `-m`/variant documentado (`c788c1c`, teste `launcher-flag-regression`) | **Validado planner+serve; TUI documentado sem pin** |
| F07 resume/reconcile | `src/lib/durable-state.ts:280` `reconcileOnBoot`; `resumePlan`/`resumeAutonomousIntake` (pausa preservada, `a48000f`) | mesmo `f03f05f06f07` (awaiting-plan gera plano; kill-9 simulado reconcilia) | B1 **validado** (final-live: awaiting-plan→plano, sem fantasma); B2-paused **parcial** (final-live achou perda de pausa → fix `a48000f`; revalidate B2 só caso `completed` PASS, caso pausado não exercido live) | **B1 validado, B2-paused parcial** |
| F08 completeLocalDestination | `src/lib/orchestrator.ts:549` `completeLocalDestination` (chamada `:1567`); `baseBranch` preservado (`schemas.ts` + `d6d0d73`) | `review-destination` (suja recusa) + `tests/lib/dest-branch.test.ts` (round-trip baseBranch, fixtures git reais) | destino explícita live **PENDENTE pós-fix `d6d0d73`** (nenhum run live com destino explícita após o fix; revalidate/final-live usaram branch nova, integração local ok mas destino explícita não revalidada) | **Código+teste; live PENDENTE (marcar claramente)** |
| F09 relatório real | `src/lib/reports.ts` (final real, MergeTestReports preservados, sem success-skip) | `review-destination` + `tests/**/report-final.test.ts` | validado em live anterior (relatório final com 5× CHECK PASS em revalidate `19-final-report.md`) | **Validado live (anterior)** |
| F10 V2 | adaptador V2 (`c765364`; `default.setup`→`tool.transform`); V1 preservado named | `tests/plugin-init.test.ts` + `tests/v2-contract.test.ts` (26 testes: 21 contratos) + `/tmp/opencode/v2/` (`load.log` 0 failed, `exec.log` 3 ok) | carga+registro+exec representativa (overview/jobs/plan_status); **17 tools com side effects via LLM vivo pendentes** | **Carga+registro+exec representativa; 17 tools live pendentes** |
| F11 context bytes | `src/lib/auto-plan.ts:917` `CONTEXT_MAX_BYTES` (256 KiB), `:966-967` fail explícito; conteúdo inline no prompt, intake+resume preservam | `ceiling-context` (conteúdo inline + persistência) | — (sem exercício live específico alegado) | **Validado teste** |
| F12 lease+heartbeat | `src/lib/file-lock.ts:12-13,33` (lease só quebra sem progresso de heartbeat; nunca invade holder vivo) | `tests/lib/file-lock.test.ts` (RED invasão antes, `TIMED_OUT` sem invasão depois) | — (sem exercício live específico alegado) | **Verificado teste** |

### 29.3 Limitações restantes (honestas, não alegadas como feitas)

1. Complement-efeito-em-arquivos (F03): decisões/questions atualizados
   provados; entrega de arquivo via follow-up **não demonstrada**
   (final-live + demo-fixes2, +0 tasks).
2. F05 live: `'não autorizo'` real nunca exercido.
3. F08-destino live pós-fix: `d6d0d73` só tem prova de teste
   (`full2.log` 1094/0); live com destino explícita **pendente**.
4. B2-paused (F07): preservação de pausa pós-`a48000f` só em código/teste;
   live só cobriu `completed` (revalidate B2 PASS parcial).
5. 17 tools V2 com side effects via LLM vivo (F10): pendentes.
6. E2E-E (`MANUAL_TEST_PLAN.md`): não executado nesta rodada.
7. Intake-resume pós-crash no meio de `running` (F07): B1 cobriu
   `awaiting-plan`; crash com workers ativos e retomada sem duplicação
   **não exercido** nesta rodada.
8. Metering (consumo/custo por modelo): desconhecido = 0 medido nesta
   rodada (lanes live usaram modelo vivo sem medição registrada).

### 29.4 Commits da rodada (locais, sem push/PR)

`c788c1c` fix(launcher) → `d10bb3a` fix(review-scope-approve, gap1+gap2)
→ `a48000f` fix(gate-resume-approve) → `d6d0d73` fix(baseBranch) →
`c2759a1` docs(v2-validation). Todos locais em
`feat/autonomous-orchestrator-v2`, HEAD `c2759a1a27cad6417966c9830e47ec8b88aa7049`.
