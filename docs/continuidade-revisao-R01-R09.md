# Continuidade — Revisão R01–R09 (pacote 2026-10-29)

Data: 2026-10-30. Sessão de mapeamento read-only + criação deste arquivo. Nenhum `src/`/`tests/` tocado, nenhum commit.

## 1. Estado inicial

- HEAD completo: `3b49a95d812c20d8a3dbb8e050f83b6179fab5bc`
- Branch: `feat/autonomous-orchestrator-v2` (sobre base `6db667e`)
- Árvore: limpa (`git status --short --branch` só mostra `## feat/autonomous-orchestrator-v2`, sem modificados/untracked)
- Divergência `c2759a1..HEAD`: **só docs, 4 arquivos, +175 linhas, 0 em `src/`/`tests/`** (prova: `git diff --stat c2759a1..HEAD`):
  - `docs/matrix-final.md` (+121: §30 dest-live F08 PASS + warning follow-up `running → creating_pr`)
  - `docs/review-packet-2/AUSENCIAS.md` (+9, novo)
  - `docs/review-packet-2/ESTADO.md` (+20, novo — declara HEAD `c2759a1`)
  - `docs/review-packet-2/REVISAO-ENTRADA.md` (+25, novo)
- Commits no intervalo: `f30e6f5` (adendo §29) → `3b49a95` (matrix §30). Sem checkout/regressão executada nesta sessão.
- Material lido integralmente: `AGENTS.md`; `/home/thomaskyn/Downloads/REVISAO_ORQUESTRADOR_PACOTE_20261029.md` (R01–R09, F01–F12); `docs/matrix-final.md` §§1–30; `docs/review-packet-2/{ESTADO,REVISAO-ENTRADA,AUSENCIAS}.md`; `MANUAL_TEST_PLAN.md` (roteiro E2E-E, fases 0–18 + smoke); `README.md`.
- Processos ativos relevantes (levantados via `ps`, não tocados):
  - Workers tmux vivos de demos antigas: `mc-is-even`, `mc-capitalize` (single-4, `opencode --prompt ...isEven/capitalize`, PIDs 472700/472740), + `isOdd` (PID 538328) — leftovers da demo encerrada, não mexer sem coordenar com operador.
  - Reconciliador/CLI vivo: `bun .../src/orchestrator-cli/index.ts resume --intake 74e22607-...` (PID 475078) e `start --repo /tmp/opencode/demo-fixes2/demo-repo --branch demo/dest2 ...` (PID 1533084) + 4 workers `slugify/capitalize/isEven/sumArray` (PIDs 1534159/1534199/1534242/1534296).
  - `opencode serve --service` (PID 1787095) + sessão `ses_e8fc3ad...` (PID 319258). Não matar: pertencem a runs/demos em curso.
  - `logs/v2/` **não existe na árvore** (referências R06/R07 a `logs/v2/*.log` vivem em `/tmp/opencode/v2/` — `load.log`, `exec.log`, `full-test.log`, `v2-exec.mjs`, isolados `tmux-isolated.log`/`wire-isolated.log`).

## 2. Objetivo e restrições

- Objetivo da próxima sessão: corrigir R01–R09 no runtime real (workers OpenCode vivos), mantendo o plano único abaixo, e revalidar cada achado contra a sonda independente correspondente — sem alegar nível além da evidência.
- Restrições duras: **sem push/PR/deploy** (SEG-3, `mc_pr` estrutural; `main` intacta); sem tocar perfil global; sem publicar branch; sem segredos em logs/prompts (`redactSecrets`).
- Qualidade > velocidade: TDD RED→GREEN por lane (repro-antes fail, repro-depois pass isolado + full sem regressão fora do baseline tmux/wire), logs integrais com exit capturado sem pipe (`cmd > log 2>&1; echo $?`), `bun run build` + `bun test` frescos por lane.
- Modelo atual autorizado, sem troca: `opencode-go/muse-spark-1.3-contributor` (banner TUI + `effectiveModel` + `g3-session-get.json`). Triplo vem de env→tracked→config com aviso explícito, nunca fallback silencioso.

## 3. Mapeamento implementação atual (HEAD 3b49a95 — paths exatos verificados)

- R01 (F01) gate/correção: `src/lib/orchestrator.ts:510-538` `reviewJobWithFixLoop` (só pins estruturais `buildStructuralPins:482-499`; diff vazio → fail, senão `pass` direto), consumidores `:1369-1408` (gate pré-merge + `processNext(...,{skipTest:true})`) e `:1498-1560` (gate global único pós-all-merged, fail-closed sem `testCommand`, conserva evidência `:1537-1550`); `src/lib/reviewer.ts:110-...` `reviewJob` (fail-closed real: sem evidência/sem env/sem commit/commit divergente/exit≠0/âncora ausente → fail), `:94-104` `anchorCovered` (exige output maior que âncora + tokens de runner), `:259-293` `runReviewFixLoop` (backoff/teto/quarentena).
- R02 (F03) complemento: `src/lib/orchestrator.ts:2412-2532` `complementAutonomousRequest` (revisão real via modelo `:2468-2474`, cria novas tasks via `applyModelAdjustment:2479-2487`, só deps de existentes `:2489-2505`, persiste versão de requisitos `:2507-2516`); `src/lib/auto-plan.ts:432-440` `requiresUserReview` (heurística keyword PT+EN).
- R03 (F06) modelo: `src/lib/prompt-file.ts:37-51` (triplo só em comentário `# effective model: ... (not pinned: TUI root has no -m/--model in v2.1.4; inherits default)`); `src/lib/orchestrator.ts:1756-1758` (launcher TUI via `writeLauncherScript` + `ensureEffectiveModel`); `src/lib/auto-plan.ts:576-603` (`resolvePlannerModel`/`resolveEffectiveModelRef`: env→tracked→config, fallback com `console.warn` explícito) e `:846-858` (`createRunPlannerGenerate`: `--model provider/id`, **sem variant**); `src/lib/model-tracker.ts` (preserva variant no snapshot).
- R04 (F07/F11) persistência: `src/lib/orchestrator.ts:2169-2187` (intake precoce `awaiting-plan`, **sem `docs`/`contextDocs`/conteúdo** — só após generate `:2197-2216`), `:2262-2269` (vínculo `planId` + `effectiveModel/Variant`), `:2288-2372` (resume: `awaiting-plan→generate :2314-2351`, `merging/creating_pr→reativado :2370-2371`, `reconcileOnBoot :2312`, contexto preservado `:2361-2368`); `src/orchestrator-cli/auto-commands.ts:445-465` (catch cria intake `awaiting-plan` sem contexto/modelo), `:576-585/:631-639/:673-681/:722-730` (approve/resume via `resumePlan` + `shutdown` imediato, sem handoff explícito).
- R05 (F09) relatório: `src/lib/orchestrator.ts:1537-1550` (global escreve `testStatus:passed` por job; `changedFiles: undefined` nesse ramo), `:678-746` (`buildFinalReportMarkdown`: Verified=`testStatus:passed`, files/testes de `evidenceList`); `src/lib/durable-state.ts:486-494` (`saveMergeEvidence` substitui registro inteiro por `jobName`, merge por chave, não por campos).
- R06 (F10) V2: `src/index.ts:341-368` (`v1ToolToV2`: `sessionID:''`, `messageID:''`, `agent:''`, `directory/worktree=process.cwd()`, `abort` próprio) + `:370-409` (`default {id, setup}`, shim `session→client.session`, `config/tui` no-op com `catch{}`); provas em `/tmp/opencode/v2/` (`load.log` 0 failed, `registered-21.json`, `exec.log` 3 ok, `v2-exec.mjs`/`v2-exec-detail.mjs` harness com `ctx` manual).
- R07 suíte: `tests/lib/monitor.test.ts:4,13,19`, `tests/lib/monitor-v2.test.ts:6,14,20`, `tests/integration/z-workflows.test.ts:37,84,96,118` usam `mock.module` global (históricos intocados); 6 arquivos novos da rodada usam `spyOn`+`mock.restore`. Último full citado: `/tmp/opencode/v2/full-test.log` (1113 pass / 7 fail = 6× tmux + 1× wire, mesmos nomes do baseline §22.2).
- R08 (F08) destino: `src/lib/orchestrator.ts:549-612` `completeLocalDestination` (merge `--no-ff` na destino `:580-583`; destino avançado → reverifica `:589-602`; **sem `testCommand` → throw `:593-595` após o merge, sem rollback**; reset só em reteste falho `:600`, catch só restaura checkout `:606-611`, não o HEAD da destino).

## 4. Status por achado no HEAD (código/teste que prova — nada re-executado aqui)

- R01: **não corrigido no caminho de produção** — `reviewJobWithFixLoop:522-529` aprova por diff não vazio sem ler implementação/testes/revisor; `reviewJob`/`runReviewFixLoop` seguem sem chamador no runtime (só `buildStructuralPins` + `pass`). Mitigações reais existem (gate vazio fail `:512-521`, gate global pós-merge `:1504-1532`, `reviewer.ts` fail-closed) mas não equivalem à revisão funcional + fix-loop exigidos. Prova contrária seria teste `review-destination-regression` (eco/sem-env) — cobre o helper, não o runtime.
- R02: **parcial, defeito reproduzível** — `continue` em `:2480` ignora tasks de mesmo nome (prompt/aceitação antigos mantidos); complemento sem `generate` só registra (`:2455-2466`); demo `revalidate/09-complement.log` terminou em pergunta pendente enquanto `19-final-report.md` declarou Verified. Corrigido: nova-task via modelo + `applyModelAdjustment` + decisão `complement revision` (`tests/lib/f03f05f06f07-regression.test.ts`).
- R03: **não corrigido de ponta a ponta** — TUI sem `-m`/variant por limite do CLI 2.1.4 (`prompt-file.ts:50` + `c788c1c` documentam, `launcher-flag-regression.test.ts` trava o comportamento); planner `--model` sem variant (`auto-plan.ts:854-857`); fallback fixo documentado em `resolvePlannerModel:576-586`. Corrigido: snapshot único + planner==coordenador + sem `unknown/unknown` silencioso (mesmo teste F03) + triplo serve (`g3-session-get.json`).
- R04: **parcial** — precoce sem conteúdo (`:2170-2187` sem `contextDocs`), ID provisório ≠ final, resume `awaiting-plan` reconstrói `docs` de `ctxDocs.map(content)` (`:2326-2330`) mas perde `ref/hash/scope`; catch CLI `:451-464` sem contexto/modelo; `resumeAutonomousIntake` não confere `planId` antes de `resumePlan` (`:2288-2360`); continuidade pós-`approve` depende de `resumePlan`+`shutdown` sem handoff (`auto-commands.ts:583-585` etc.). Corrigido: persistência precoce, `planId` durável `:2262-2269`, `reconcileOnBoot :2312`, `context preserved :2361-2368` (mesmo teste F03).
- R05: **parcial, ainda incorreto p/ aceite** — ramo `:1540-1552` marca `passed` global com `changedFiles: undefined` (apaga pins do registro anterior via `saveMergeEvidence:493`); Verified deriva de teste global (`:678-686`), requisitos complementares pendentes e perguntas abertas não entram em Gaps. Corrigido: `mergeEvidence` conservado, `MergeTestReports` como anexos, falha de geração logada (teste `review-destination` + `report-final.test.ts`).
- R06: **parcial-alta, compatibilidade** — carga (0 failed) + registro (21 contratos `tests/v2-contract.test.ts` 26/0) + execução representativa (overview/jobs/plan_status via harness) provados; mas `execute` descarta sessão/localização/cancelamento (`index.ts:355-361`), shim engole falhas (`:384-405`), 17 tools com side effects via LLM vivo pendentes. Não descartar: é harness de adaptador, não despacho do host.
- R07: **não demonstrado como ambiental** — `v2/full-test.log` 7 fails compatíveis com poluição de `mock.module` (focused `getProjectId is not a function` vs isolados verdes); `matrix §29.1` declara 7→0 sem commit entre runs (ordenação/ambiente, sem prova de causa). Corrigido parcialmente: 0 `mock.module` nos 6 arquivos novos + fix real `d6d0d73` achado pela suíte cheia.
- R08: **cenário específico ainda reproduzível** — `completeLocalDestination:588-595` mergeia antes de checar comando; destino avançado sem `testCommand` lança **após** o merge sem `reset` (só `:600` cobre reteste falho; catch `:606-611` só volta checkout). Corrigido em volta: `baseBranch` round-trip `d6d0d73` (`dest-branch.test.ts`), destino explícita validada live pós-fix (`matrix §30`, `dest-live PASS df06519`), suja recusa.
- R09: **divergência resolvida neste HEAD** — `c2759a1` (bytes revisados) vs `3b49a95`: `git diff --stat` prova só-docs (matrix §30 + packet-2). `ESTADO.md` ainda declara `c2759a1`; `df06519` citado na revisão é commit do repo descartável `dest-live`, não do produto. Resta: manifesto hash dos bytes (sem `.git`) p/ amarrar código↔logs↔fechamento.

## 5. Plano único de correção (R01→R09, ordem bloqueante primeiro)

1. R01: ligar `reviewJob`+`runReviewFixLoop` reais ao runtime (requisitos/aceitação estruturados, inspeção código+testes, evidência vinculada ao candidato; fix-loop diagnóstico→prompt→correção→re-revisão com teto; escalar ao usuário só em decisão reservada). Critério: sonda `total([1,2])===0` + teste verde irrelevante → `merged` proibido; `reviewJobWithFixLoop` nunca `pass` por diff.
2. R02: tratar mudança em task existente (atualizar trabalho não iniciado / reenviar orientação / criar task de correção se já entregue); preservar `contextDocs`+estado no replanejo; pergunta pendente ⇒ requisito fora de Verified + em Gaps.
3. R03: resolver 1 seleção por execução, aplicar aos processos reais e observar valor efetivo; se impossível aplicar/verificar triplo, falhar explícito ou pedir decisão — nunca herdar default registrando como observado.
4. R04: persistir entrada completa antes do modelo (ID estável, `docs`+conteúdo+`ref/hash/scope`, teto, modelo, `planId` conferido no resume); definir condutor pós-`approve`/`resume` (processo vivo/serviço/handoff verificável); validar queda no planejamento e no trabalho (não só terminal `completed`).
5. R05: preservar pins+arquivos (merge de campos, nunca replace cego); separar evidência global de por-task; amarrar execução ao commit testado; perguntas/requisitos pendentes em Gaps; install/usage além do checker.
6. R08 (antes do relatório/V2 por ser integridade): verificar candidato antes de promover destino ou rollback total em qualquer falha pós-merge (sem `reset --hard` sem posse/concorrência preservada).
7. R06: propagar sessão/localização/cancelamento reais no adaptador; validar 1 operação V2 dependente de contexto além de leitura sem estado; mapear ou declarar `command.execute.before`/`config` pendentes.
8. R07: isolar mocks (remover `mock.module` global dos 3 arquivos históricos ou provar isolamento), reproduzir combinação mínima, full verde nas mesmas fontes.
9. R09: publicar manifesto do HEAD (HEAD+branch+estado+hashes de produto) junto às evidências; repetir cenário pequeno (requisito ausente + teste verde inicial + complemento em task existente + retomada com trabalho em andamento) exigindo rejeição/correção/efeito real.

## 6. Progresso por achado

| ID | Estado |
| --- | --- |
| R01 | pendente |
| R02 | pendente |
| R03 | pendente |
| R04 | pendente |
| R05 | pendente |
| R06 | pendente |
| R07 | pendente |
| R08 | pendente |
| R09 | pendente (divergência `c2759a1..3b49a95` resolvida como só-docs; manifesto hash pendente) |

Nenhum marcado corrigido: as correções em `matrix §§23-30` são evidência de progresso, não aceite R01–R09 (critério: sonda independente + live com workers reais).

## 7. Evidências e pendências

- Evidências válidas no HEAD: `reviewer.ts` fail-closed + `review-destination-regression` (7/0); `repo-context` + `ceiling-context` (F02/F04/F11); `f03f05f06f07` (F03/F05/F06/F07); `file-lock` lease+heartbeat (F12); `plugin-init` + `v2-contract` + `/tmp/opencode/v2/load.log`+`exec.log` (F10 carga/registro/exec); `dest-live PASS` (F08 pós-`d6d0d73`); `live-proof.md`/`public-demo.md` (coordenador, kill-9 do plano, teto, TUI/G1-G3).
- Pendências honestas (§29.3 + §30): complemento-efeito-em-arquivos; F05 live; B2-paused live (só `completed` revalidado); 17 tools V2 com side effects; E2E-E fase a fase; crash-durante-`running` com workers; metering; `resume --intake` sem plano = no-op por desenho; intake slot único; warning `running → creating_pr` pós-destino (follow-up).
- Não re-alegar sem re-demo live: gate estrito, `completeLocalDestination`, complemento via modelo, permissão fail-closed, lease, execução V2 (`matrix §27`).

## 8. Comandos para continuar (outra sessão)

```bash
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
git status --short --branch && git log --oneline -5 && git rev-parse HEAD
git diff --stat c2759a1..HEAD
bun run build
bun test
# retomada de intake (ver estado antes; nunca duplicar workers):
# bun src/orchestrator-cli/index.ts progress  # ou follow/status
# bun src/orchestrator-cli/index.ts resume --intake <id>
# intake novo (3ª pasta, com contexto, teto explícito, sem push):
# bun src/orchestrator-cli/index.ts start --repo <repo> --branch <dest> --request "<NL>" --context <file> --max-parallel N --test-command "<cmd>"
```

Retomada do intake: ler `docs/review-packet-2/REVISAO-ENTRADA.md` (onde responder cada pergunta) + `matrix §29.2` (nível por F01–F12) + `§29.3` (8 limitações) antes de qualquer código; reproduzir a sonda R correspondente antes do fix; fechar com build+test frescos e log com exit capturado.

---
Skipped: full `bun test`/`bun run build` e qualquer re-demo live (read-only + sem checkout por instrução). Risk: processos/demos legados ainda vivos (`mc-is-even`, `demo-fixes2`, `resume --intake 74e22607`) — coordenar antes de matar/limpar; `logs/v2/` só existe em `/tmp/opencode/v2/`, não na árvore.

## 9. Progresso final por achado (2026-10-30, lane docs — só acréscimo, sem reescrever §§1–8)

Estado selado pelo orquestrador ao fim da rodada; HEAD de referência segue `3b49a95` até o commit/ZIP de reconciliação.

| ID | Situação final |
| --- | --- |
| R01 | Gate funcional + fix-loop + fallback acceptanceLess **verificados**: `defect-1`/`gap1`/`acceptance-less` TDD RED→GREEN (falham no gate antigo, passam no novo); demo-R pública rejeitou entrega errada e pediu correção via fix-loop |
| R02 | Igualdade de conjuntos `sameAcceptance` (mudança de prompt/aceitação em task existente tratada, sem duplicar nem ignorar) |
| R03 | Variant preservada (`parseModelRef` + `formatModelRefForArgv`) + `sessionID` propagado ao launcher/worker (sem `-m` no TUI, triplo registrado) |
| R04 | ID estável do intake ao plano + handoff registrado após `approve`/`resume` (condutor explícito, sem vazio) |
| R05 | Pins preservados (merge por campo) + Verified/Gaps separados (evidência global não promove job; acceptanceLess fora de Verified) |
| R06 | V2 com contexto por chamada (sessão/localização/cancelamento propagados, sem stub fixo; shim sem no-op silencioso) |
| R07 | Mocks `spyOn` (sem `mock.module` global): full 1127 pass / 1 fail / 1128 testes / 79 arquivos — único fail `wire createPR` só-no-full, 11/0 isolado, isolamento pré-existente |
| R08 | Preflight + rollback no destino (verifica antes de promover; desfaz em falha pós-merge) |
| R09 | Manifesto publicado; SHAs finais selados no commit/ZIP pelo orquestrador |

Evidências (reportadas pela reconciliação): `bun run build` exit 0 (1.46 MB); `bun test` 1127 pass / 1 fail / 1128 testes / 79 arquivos; revisor independente: **aceitar**.

Pendências honestas (ficam documentadas, não alegadas como feitas):
1. `wire createPR` só-no-full (isolamento pré-existente; 11/0 isolado).
2. Demo-R pausada em decisão humana legítima (touchSet — `approve` pendente, não executado).
3. Nuance `scope:'integration'`+`acceptanceLess` documentada (§33 da matrix): smoke global refaz `scope` sobre o `'task'` da revisão; flag e relatório corretos.
