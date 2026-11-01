# Demo 4P — 4 workers simultâneos + 1 dependente via caminho público — relatório final

- PLAN_ID: `2026-11-01-touchset-fluxo-publico`
- Intake: `09eca02f-714a-4ee2-9cfb-3fcc8287b275` · Plan: `c4446599-1c20-465b-878f-8ce13df3c58c`
- HEAD plugin: `6cbd93faf9062221a2e67ac96143588c306f90d5` (heurística persegue re-exports + abstém-se sem candidata; árvore limpa salvo AGENTS.md + este relatório)
- Fixture base: `/tmp/opencode/touchset-4p/demo-pub@23a7953bf11861557a1d5afa032c0f82d2150703` (git init -b main, fora do plugin)
- Data (UTC): 2026-11-01 ~07:58–08:06 (sessão anterior) + retomadas 08:16–08:40 + **fechamento 08:47–08:49 (`resume` epoch 9: index `pass (functional, scoped bun test @ 34b34adf)` → merged `15ecc3a` → destino `3c9b2544`; plano `completed`)**
- Modo: caminho público CLI (`start --repo/--branch/--request/--context/--max-parallel/--test-command`, `follow/task/order/questions/log`, `approve --retry/clear`, `resume --intake`). `src/` e `tests/` **read-only** (nenhum edit). Único arquivo criado neste repo: este relatório. Fixtures/logs só em `/tmp/opencode/touchset-4p/` (demo-pub, xdg, logs, run-start.sh, poll.sh, driver.pid). Sem push/PR/deploy. Sem commit neste repo.
- Isolamento (outra lane usa 14200-14299 e `/tmp/opencode/touchset/xdg`): XDG EXCLUSIVO `/tmp/opencode/touchset-4p/xdg` (`MC_XDG_DATA_DIR`), projeto `demo-pub-b2d3063e6607`, `state/config.json` com `portRangeStart:14300, portRangeEnd:14399`. Faixa verificada livre antes (`ss -ltn | grep 143xx` vazio, `demo-4p-00/10`, `EXIT=0`). Branch destino NOVA `demo-4p` (criada localmente do base, nunca push).
- Modelo autorizado: `opencode-go/muse-spark-1.3-contributor` (`MC_PLANNER_MODEL` setado, `MC_REVIEW_MODEL=(unset)` — revisor herda efetivo).
- Intervenções registradas (só processos nossos, nunca alheios; tmux só `ls`, portas só `ss -ltn` leitura):
  - Fechamento: `resume --intake` epoch 9 em background (`demo-4p-88`, pids `2021418/2021420`) → index `pass` → merged `15ecc3a` → verificação final integration (`bun test`, 5 siblings) → destino `demo-4p@3c9b2544`; teardown `kill 2021418/2021420` (nossos). Aviso benigno `[MC] Invalid plan transition: running → creating_pr` (guarda anti-PR; conclusão local ocorreu; sem push).
  - Milha final: `kill 1926435` (start obsoleto pré-fix, nosso) derrubou `1926430`; alheios intactos. `approve --retry capitalize-task` 2× `EXIT=1` (running exige paused). `resume` epoch 5 (pad merged) + epoch 6 (~200s sem mudança); teardown `kill 1982805/1982807` (nossos).
  - Milha final-2 (código 2cc9c8d): nenhum nosso vivo → `resume --intake` epoch 7 em background (`demo-4p-83`, pids `2000626/2000628`) → **heal `failed→merged` forçado no reconcile** (`[MC] Invalid job transition … (forced recovery)`, decisão `reconcile healed capitalize-task … already integrated`) → index despachou (porta **14307**, tmux novo). `approve --retry index-task` 1× `EXIT=0` (epoch 8) → re-review falhou igual → auto-fix 1/2 despachou worker (porta **14308**) que **travou em `Permission requires user approval: shell`** (sem perguntas pendentes em `questions`, nada respondível) → `cancel index-task` 1× `EXIT=0` (processo parado, código `34b34ad` preservado, tmux/porta liberados). Sem 2º retry (seria loop). Teardown `kill 2000626/2000628` (nossos); alheios `1914587/1925225` e tmux restantes intactos.
  - Retomada: `approve --intake … --retry capitalize-task` **2 tentativas, ambas `EXIT=1` recusado** (`demo-4p-71`, `demo-4p-74`): `Error: Plan … is not pending or paused (current status: running)` — fail-closed determinístico, sem loop.
  - Retomada: `resume --intake` epoch 5 (foreground, morto pelo tool-timeout 120s mas fundiu o pad em 120s) + epoch 6 em background (`demo-4p-75`, pids `1982805/1982807`, ~200s observado sem mudança em capitalize/index); teardown `kill 1982805` + `kill 1982807` (nossos).
  - `approve --intake … --retry capitalize-task` (`EXIT=0`, epoch 2 pid 1933892) + `approve --intake …` clear (`EXIT=0`, epoch 3 pid 1934816) — one-shot, destacaram sozinhos (handoff `token-verified`).
  - `resume --intake` foreground com `timeout 120` — morto pelo timeout (`EXIT=124` honesto, como wrapper da demo anterior; é o próprio driver, nosso).
  - `pkill -f /tmp/opencode/touchset-4p/poll.sh` matou só nosso poll `1926700` (self-match matou também o shell invocador com SIGTERM — sem afetar alheios; `tmux ls` depois intacto com 3 sessões antigas + 4 nossas).
  - Serve alheias `14102/14103/14109` e tmux `mc-implement-*/mc-slugify-task-7affee88-*` preservadas (só leitura). Nenhum `kill` alheio, nenhum `git reset --hard/clean` no plugin.

## 1. Base, OMO, modelo, intake coerente

- `opencode --version`: **v2.2.5**; `bun --version`: **1.3.14** (`demo-4p-01-versions.log`, ambos `EXIT=0`).
- OMO `detectOMO`: **detected:true, configSource:global** (`demo-4p-02-omo.log`, `EXIT=0`).
- Modelo efetivo sem `MC_REVIEW_MODEL`: `opencode-go/muse-spark-1.3-contributor` (fallback triple, `resolveReviewModel=effective`) (`demo-4p-03-model.log`, `EXIT=0`). Com `MC_PLANNER_MODEL` setado, workers observam triple `{opencode-go/muse-spark-1.3-contributor, variant:default}` (jobs.json, 4 jobs).
- Fixture: `package.json` (ESM, `bun test`), `README.md`, `CONTEXT.md` (scope repo, sha `0ce93fd38a91`), `request.txt` (5 tarefas explícitas, touchSets disjuntos, `dependsOn` só no index). `bun test` base: `error: 0 test files`, `BUNTEST_BASE_EXIT=1` — Bun/Git reais (`demo-4p-10-fixture.log`).
- Intake real via CLI pública: `start --repo …/demo-pub --branch demo-4p --request "$(cat request.txt)" --context …/CONTEXT.md --max-parallel 4 --test-command "bun test"` → intake persisted running + plano **5 tasks** `[slugify-task, reverse-task, capitalize-task, pad-task, index-task]` (`demo-4p-20-start-full.log`, `EXIT=0` linha `Plan launched: 5 task(s)`).
- Planner 100% real: `model answered in 1 attempt(s)`, `effectiveModel: opencode-go/muse-spark-1.3-contributor`, `context loaded scope:repo` (runtime-state.json). Base pronta `demo-4p@23a7953b`.
- Coerência pré-despacho (sem `sum.js` hardcoded, sem allow-all): `touchSet=[slugify.js,slugify.test.js]` etc. disjuntos; `index touchSet=[index.js,index.test.js]` + `dependsOn=[4 base]`; `testCommand "bun test"` sem alvo fora da união (bare, passa). Plano aceito e despachado — prova que validação geral funciona em domínio ≠ soma.

## 2. Simultaneidade REAL — PROVADA (não nº de sessões)

Evidência com timestamps sobrepostos (todos em `/tmp/opencode/touchset-4p/logs/`):

- **POLL 3 @ 2026-11-01T07:59:29Z** (`demo-4p-30-poll.log`, 483K, 90 polls a cada 10s):
  - `jobs.json`: **4× `status:"running"`** — `slugify-task port 14300 createdAt 07:59:14.055Z`, `reverse-task 14301 07:59:16.695Z`, `capitalize-task 14302 07:59:19.094Z`, `pad-task 14303 07:59:21.535Z` (todos com `modelRequested/Observed {opencode-go/muse-spark-1.3-contributor, variant:default}`, `remoteSessionID ses_…`, `serverPassword …`).
  - `plan.json`: `status=running`, 4× `running` + `index-task waiting_deps` (mesmo segundo).
  - `tmux ls`: 4 nossas (`mc-slugify-task-c4446599-aa5cf27b 04:59:14`, `mc-reverse-task-… 04:59:16`, `mc-capitalize-task-… 04:59:19`, `mc-pad-task-… 04:59:21`) + 3 antigas preservadas.
  - `ss -ltn`: `14300/14301/14302/14303 LISTEN` simultâneos.
- **Simultaneidade dedicada @ 07:59:41Z** (`demo-4p-31-simultaneity.log`, `EXIT=0`):
  - `tmux ls DURANTE`: 4 nossas vivas + 3 antigas (`TMUX_EXIT=0`).
  - `ss -ltn`: 4× `1430x LISTEN` (`SS_EXIT=0`).
  - `curl -m 5 http://127.0.0.1:1430x/`: **4× `HTTP 200`** (`CURL_EXIT=0` cada) — serve respondendo em 4 portas distintas.
  - `jobs.json` então já mostrava `2 running + 2 completed` (workers rápidos: slugify `completedAt 07:59:37`, reverse `07:59:40`) — por isso o POLL 3 (12s antes) é a prova primária de 4-running; o snapshot 07:59:41 prova 4 tmux + 4 ports + 4 HTTP 200 sobrepostos.
- Via pública com cwd correto (`/tmp/opencode/touchset-4p/demo-pub`, `MC_XDG_DATA_DIR` isolado): `follow` → `1 running, 3 completed` (`demo-4p-44`, `EXIT=0`); `order` → `0 eligible, 1 running` (`EXIT=0`); `task {slugify,reverse,pad,capitalize}` com status reais; `task index-task` → `Error: Job "index-task" not found. EXIT=1` (correto: nunca despachado, só no plano — como `average-task` na demo anterior); `questions` none; `log` sem reports (`mc_report` indisponível na via pública — contribuições = commits reais).

## 3. Workers: 2 merged, 1 merged-mas-failed (bug), 1 ready sem merge, 1 nunca despachado

| Instância | Contribuição (commit real) | Resultado pelo fluxo real |
|---|---|---|
| `slugify-task` serve **14300** | `9929eaa feat: add slugify with tests` (5 pass) | **PASS funcional** (`review … pass (functional, scoped bun test @ 9929eaa1)`) → **MERGED `e7517f0` @ 07:59:48Z** (`mergeEvidence`, `testOutput "5 pass"`) |
| `reverse-task` **14301** | `57a9bc7 feat: add unicode-safe reverse` (4 pass) | **PASS** (`@ 57a9bc78`) → **MERGED `c8fc676` @ 07:59:58Z** |
| `capitalize-task` **14302→14304** (relaunch) | `adae334` + `b83ebc7 fix: add lowercase multi-char word test` (5 pass) — revisor rejeitou 1ª versão corretamente (`No test calls capitalize with lowercase multi-char word … fail-closed`), auto-fix despachou relaunch com `REVIEW CORRECTION (attempt 1/2)` no prompt | **PASS** (`@ b83ebc70`; `mergeEvidence` task-scope `passed`) → **conteúdo MERGED `c1e8f07` @ 08:00:50Z na integration**. Status ficou `failed (empty-diff)`; **milha final (2cc9c8d `healAlreadyIntegratedFailures`): `resume` epoch 7 curou sem re-review e sem exigir pause — `failed→merged` forçado (`[MC] Invalid job transition … (forced recovery)`) + decisão `reconcile healed capitalize-task … already integrated` → `merged @ 08:31:54.247Z` terminal. Cura COMPROVADA.** |
| `pad-task` **14303** | `cad1d93 feat: add pad` (4 pass) | Sessão anterior: `ready_to_merge` sem revisão/merge (stall). **Retomada curou (fix c): `resume` epoch 5 revisou `review pad-task: pass (functional, scoped bun test @ cad1d93c)` → MERGED `06658e8` @ 08:16:56Z.** |
| `index-task` (dependente) | `34b34ad feat: add index barrel re-exporting four utilities with test` — barrel correto + 4 testes distinguíveis via `./index.js` | Despachou após os 4 merged (porta **14307**). Review com código velho falhava cego a barrels; **fechamento (6cbd93f): heurística persegue re-exports → `review index-task: pass (functional, scoped bun test @ 34b34adf)` → MERGED `15ecc3a` @ 08:47:37.958Z** (`mergeEvidence`: 22 pass, scope task). Quem decidiu o PASS: (1) **teste executável** — `bun test` scoped @34b34adf, `22 pass 0 fail` (+ verificação final integration com 5 siblings); (2) **heurística** — candidatos via re-exports do touchSet, asserts vinculados; (3) **revisor OpenCode real** — caminho exige `requireExternalSufficiency` (autopilot com acceptance; F01 `requireReviewPass:true` bloqueia merge sem pass; fail-closed: binário ausente/timeout/unparseable nunca passa), modelo herdado `MC_REVIEW_MODEL=(unset)`. Auto-fix workers do ciclo velho travaram em permissão shell (observação §7) mas o `cancel` preservou `34b34ad`, que foi o commit merged. |

- Integration `mc/integration-c4446599-…`: `15ecc3a Merge index-task / 06658e8 / c1e8f07 / c8fc676 / e7517f0 / 23a7953` (**5/5**). `bun test` lá e **no destino: 22 pass 0 fail across 5 files** (`demo-4p-82/89`, `EXIT=0`). Destino `demo-4p` = **`3c9b2544` Merge mc/integration-… (local autonomous completion)** — além da base `23a7953` (correto: fundiu após todas aprovadas).
- mergeEvidence final: 5 chaves `passed` task-scope (slugify `9929eaa1`, reverse `57a9bc78`, capitalize `b83ebc70`, pad `cad1d93c`, index `34b34adf`).
- Defeito forçado? Não repetido aqui (já provado na demo TOUCHSET §3 com `1 pass` enganoso vs check adequado `REJECT`). Revisor aqui provou valor real ao rejeitar capitalize fraco e exigir teste multi-char.

## 4. Pausa/interrupção + resume (lease, sem duplicar)

- `start` ficou condutor (pid `1926430/1926435`, `epoch 1` implícito) até a milha final, quando foi morto por obsoleto (código pré-fix; `kill` registrado acima). Plano pausou `paused/on_error` (capitalize empty-diff) com `1 failed + 1 ready_to_merge + 1 waiting_deps`.
- `approve --retry capitalize-task` (`demo-4p-52`, `EXIT=0`): `Checkpoint on_error cleared. Job reset to ready_to_merge` + handoff `epoch 2 token-verified … workers live 0/0, model …, ceiling maxParallel=4 testCommand=bun test`. Leitura seguinte mostra `paused` de novo (re-falha spurious — evidência do bug, sem duplicar workers).
- `approve` clear (`demo-4p-53`, `EXIT=0`): `Checkpoint cleared … [running] … 2 merged, 1 failed, 1 ready_to_merge, 1 waiting_deps`, handoff epoch 3. Plano `running checkpoint=null` (confirmado).
- `resume --intake` (`demo-4p-55`, `timeout 120 → EXIT=124` honesto): `conductor live (… epoch 4 token-verified … 0 job(s) in flight)`, sem despacho duplicado (jobs: mesmos 4, index segue único `waiting_deps`). Kill foi do nosso foreground via timeout (registrado); original `1926430/35` preservado vivo (`ps` final prova). Lease/heartbeat via `recordConductorHandoff` em cada passo; `follow` nunca inventa progresso (`0 running` quando correto).
- Milha final: `resume --intake` epoch 7 (`demo-4p-83`, pids `2000626/2000628`, `[MC] Invalid job transition: failed → merged … (forced recovery)` + decisão `reconcile healed capitalize-task`) → capitalize `merged`, index despachou (14307). `approve --retry index-task` 1× (`demo-4p-85`, `EXIT=0`, epoch 8, `4 merged, 1 ready_to_merge`) → re-review falhou igual → auto-fix 1/2 (worker 14308 travado em `Permission requires user approval: shell`, sem `questions`) → `cancel index-task` 1× (`demo-4p-86`, `EXIT=0`, código preservado). Sem 2º retry (loop). Teardown `kill 2000626/2000628` (nossos); alheios intactos.

## 5. Tabela mock × real × não comprovado

| Item | Classificação |
|---|---|
| `opencode --version`, `bun --version`, `tmux ls`, `ss -ltn`, `git` | Reais |
| `bun test` base/5-pass/4-pass/integration 14-pass | Reais (Bun) |
| `detectOMO detected:true global` | Real |
| planner (`opencode run --standalone --model …`, 1 tentativa, `effectiveModel`) | Real (OpenCode) |
| workers serve **14300–14303**, tmux `mc-*-c4446599-*`, `modelRequested/Observed` triple, `remoteSessionID`/senha | Reais (OpenCode serve + SDK) |
| coerência pré-despacho (5 tasks, touchSets disjuntos, `dependsOn` só no index, `bun test` sem alvo órfão) | Real (fluxo do plugin, sem mock) |
| 4 simultâneos (POLL 3 jobs 4-running + plan 4-running + tmux 4 + ss 4 + curl 4×200 sobrepostos) | **PROVADO** |
| rejeição capitalize fraco → correção → re-review PASS → merge `c1e8f07` (conteúdo correto na integration) | Real (revisor OpenCode real + teste + heurística) |
| `mc_report` por instância via CLI | Não disponível na via pública (`log … No milestone reports yet`, `EXIT=0` — contribuições = commits reais) |
| `pad-task` merged | **COMPROVADO na retomada** — `review pass @ cad1d93c` → `merged 06658e8 @ 08:16:56Z` (fix c funciona; `demo-4p-73`) |
| `capitalize-task merged` no plano | **COMPROVADO na milha final** — `resume` epoch 7: `failed→merged` forçado + decisão `reconcile healed capitalize-task … already integrated` → `merged @ 08:31:54.247Z` terminal (`demo-4p-83`). |
| `index-task` merged, destino `demo-4p` além da base | **COMPROVADOS no fechamento** — index `pass (functional, scoped bun test @ 34b34adf)` → merged `15ecc3a @ 08:47:37Z`; plano `completed`; destino `3c9b2544` (de `15ecc3a6`) além da base `23a7953` (`git rev-parse`, `demo-4p-89`); `bun test` destino 22 pass `EXIT=0`. |
| Escala 8 | **NÃO tentado, NÃO comprovado** (conforme ordem) |
| mocks | **Zero** (sem stub; `MC_REVIEW_MODEL` unset prova herança) |

## 6. Verificação (fresco, com exit)

- `demo-4p-00-baseline` (`EXIT=0`): tmux antes (3 antigas), `ss` (14102/03/09 alheias, 143xx livre), versões, HEAD.
- `demo-4p-10-fixture` (`BUNTEST_BASE_EXIT=1` esperado, resto `EXIT=0`): fixture, base `23a7953`, config `14300-14399`, `FREE 14300-14399`.
- `demo-4p-20-start-full` (`EXIT=0` linha `Plan launched: 5 task(s)`): intake `09eca02f`, plano 5 tasks.
- `demo-4p-30-poll` (90×10s): POLL 3 prova 4-running (ver §2). `demo-4p-31-simultaneity` (`EXIT=0`): tmux 7, ss 4, curl 4×200.
- `demo-4p-42/43/44/45/46/47/48` (todos `EXIT=0` exceto `task index-task EXIT=1` esperado): plano `2 merged`, jobs, follow/order/tasks/questions/log via cwd `demo-pub`.
- `demo-4p-50/51` (`EXIT=0`): `paused/on_error`, `failureKind:test_failure`, `empty diff`.
- `demo-4p-52 approve --retry` (`EXIT=0` sessão anterior, código velho), `53 approve clear` (`EXIT=0`), `55 resume` (`EXIT=124` timeout honesto, epoch 4), `56 after-resume` (ainda `2 merged/1 failed/1 ready/1 waiting`).
- Retomada: `demo-4p-70 baseline` (`EXIT=0`: HEAD `194298d`, driver obsoleto vivo, plano `2 merged/1 failed/1 ready/1 waiting`); `demo-4p-71 approve --retry` (`EXIT=1` recusado) + `demo-4p-74` (2ª tentativa, `EXIT=1` — determinístico, sem loop); `demo-4p-72/73 resume` epoch 5 (tool-timeout 120s; em 120s: `review pad-task pass` + `merged 06658e8`); `demo-4p-75/76 resume` epoch 6 background (~200s, `3 merged/1 failed/1 waiting`, sem mudança); `demo-4p-77/78/79/80` follow/order/tasks/questions via cwd demo-pub (`EXIT=0`, `task index-task EXIT=1` esperado); `demo-4p-81 final2` (hashes, 18-pass); `demo-4p-82 integration` (`18 pass EXIT=0`).
- Fechamento: `demo-4p-88 resume` epoch 9 (heal + `index running` em 25s); `demo-4p-89` (plano `completed` 5/5, destino `3c9b2544` de `15ecc3a6`, base `23a7953`, 22 pass integration + destino, `EXIT=0`); `demo-4p-90 follow-final` (`0 running, 4 completed, 0 failed, 1 stopped`, `EXIT=0`); teardown `kill 2021418/2021420` (nossos).
- Pulei: `bun run build`/`bun test` do plugin (read-only + irrelevante — demo usa working tree como está); suíte da fixture destino (nada fundido lá para testar além da base).
- Concorrência de lane: `tests/lib/port-allocator.test.ts` aparece `M` com mtime `05:16:53 -0300` (08:16:53Z), dentro da minha janela — edição de outra lane paralela (helper `findFreeBase`, coerente com fix d), **não minha** (meus writes: só este relatório + `/tmp/opencode/touchset-4p/`); preservado sem tocar. `src/lib/*` já estavam `M` no meu baseline 08:16:34Z (fixes da tarefa, esperados).

## 7. Limitações e riscos

1. **`failed→merged` sem transição pública: CURADO e comprovado** — `healAlreadyIntegratedFailures` no `_doReconcile` curou `capitalize-task` no primeiro reconcile (`forced recovery`, sem re-review, sem exigir pause). Item encerrado.
2. **Pad stall: CURADO e comprovado** — `failed` irmão não bloqueia mais `ready_to_merge` independente (`resume` epoch 5: `review pad-task pass` → `merged 06658e8`). Item encerrado.
3. **Heurística cega a barrels: CURADA e comprovada** — `extractImplCandidates` agora persegue re-exports no escopo (`export */{x} from`, `module.exports=require`) e se abstém sem candidata visível (decidem teste + revisor). `review index-task: pass (functional, scoped bun test @ 34b34adf)` comprova. Resíduo observado (não bloqueou): auto-fix workers do ciclo velho travaram em `Permission requires user approval: shell` sem `questions` pendentes — correction-workers sem `shell` aprovado na política padrão merecem revisão própria.
4. Sessões `mc-*-c4446599-*` restantes, worktrees/branches da demo vivem em `/tmp/opencode/touchset-4p/xdg` + `demo-pub`; limpeza futura é `git worktree remove` + apagar branches `mc/*` **na fixture**, nunca no plugin; drivers nossos todos encerrados (`kill` registrados); alheios intactos.
5. `follow` sem `--repo` lê o cwd (plugin → vazio); com cwd `demo-pub` lê correto. Documentado pelo `EXIT=0` vs `0 running` inicial — conferir sempre `plan.json` (`status/checkpoint`) além do dashboard.
6. `task <nome>` só encontra jobs despachados (`jobs.json`); `waiting_deps`/stopped só no `plan.json`/`jobs.json`.
7. Skipped: build/suíte do plugin (escopo read-only).

---
Resumo pedido (fechamento): **4 simultâneos PROVADOS** (§2); **capitalize MERGED `08:31:54Z`** (heal); **pad MERGED `06658e8`**; **index MERGED `15ecc3a @ 08:47:37Z`** (quem decidiu o PASS: teste 22-pass + heurística com re-exports + revisor OpenCode — ver §3); **destino ALÉM da base** (`demo-4p` = `3c9b2544` de `15ecc3a6`; base `23a7953`); plano `completed` 5/5. Skipped: build/suíte do plugin (read-only).
