# Demo 4P — 4 workers simultâneos + 1 dependente via caminho público — relatório final

- PLAN_ID: `2026-11-01-touchset-fluxo-publico`
- Intake: `09eca02f-714a-4ee2-9cfb-3fcc8287b275` · Plan: `c4446599-1c20-465b-878f-8ce13df3c58c`
- HEAD plugin: `1bb984663523563c77baff6f13f170b4c7cb0ea2` + working tree com fixes (preservada, sem commit)
- Fixture base: `/tmp/opencode/touchset-4p/demo-pub@23a7953bf11861557a1d5afa032c0f82d2150703` (git init -b main, fora do plugin)
- Data (UTC): 2026-11-01 ~07:58–08:06 (start 07:59:00Z, 4-running 07:59:29Z, merges 07:59:48/58Z, pausas/approves 08:02–08:06Z)
- Modo: caminho público CLI (`start --repo/--branch/--request/--context/--max-parallel/--test-command`, `follow/task/order/questions/log`, `approve --retry/clear`, `resume --intake`). `src/` e `tests/` **read-only** (nenhum edit). Único arquivo criado neste repo: este relatório. Fixtures/logs só em `/tmp/opencode/touchset-4p/` (demo-pub, xdg, logs, run-start.sh, poll.sh, driver.pid). Sem push/PR/deploy. Sem commit neste repo.
- Isolamento (outra lane usa 14200-14299 e `/tmp/opencode/touchset/xdg`): XDG EXCLUSIVO `/tmp/opencode/touchset-4p/xdg` (`MC_XDG_DATA_DIR`), projeto `demo-pub-b2d3063e6607`, `state/config.json` com `portRangeStart:14300, portRangeEnd:14399`. Faixa verificada livre antes (`ss -ltn | grep 143xx` vazio, `demo-4p-00/10`, `EXIT=0`). Branch destino NOVA `demo-4p` (criada localmente do base, nunca push).
- Modelo autorizado: `opencode-go/muse-spark-1.3-contributor` (`MC_PLANNER_MODEL` setado, `MC_REVIEW_MODEL=(unset)` — revisor herda efetivo).
- Intervenções registradas (só processos nossos, nunca alheios; tmux só `ls`, portas só `ss -ltn` leitura):
  - `start` driver `1926430` (bash) + filho `1926435` (bun start) deixados **vivos e heartbeating** como condutor legítimo.
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
| `capitalize-task` **14302→14304** (relaunch) | `adae334` + `b83ebc7 fix: add lowercase multi-char word test` (5 pass) — revisor rejeitou 1ª versão corretamente (`No test calls capitalize with lowercase multi-char word … fail-closed`), auto-fix despachou relaunch com `REVIEW CORRECTION (attempt 1/2)` no prompt | **PASS** (`@ b83ebc70`, 2×) → **MERGED `c1e8f07` @ 08:00:50Z na integration** (conteúdo correto, `bun test` 5-pass), **mas plano marca `failed: Review blocked: empty diff`** — re-review pós-merge encontra diff vazio para o touchSet (já integrado) e falha em modo estrito. `approve --retry` (epoch 2) resetou para `ready_to_merge` mas o reconciliador re-falhou igual (spurious loop). `approve` clear (epoch 3) deixou `running` com `1 failed`. Bug de produto documentado, não alegado como sucesso. |
| `pad-task` **14303** | `cad1d93 feat: add pad` (4 pass, `bun test` local `4 pass EXIT=0`) | **Nunca revisado/merged**: ficou `ready_to_merge` desde ~08:00, sem decisão `review pad-task` no runtime (só slugify/reverse/capitalize), integração sem `pad.js`. Após `approve/clear` + `resume` epoch 4 (120s, `0 job(s) in flight`), continua `ready_to_merge`. Stall documentado — sem inflar. |
| `index-task` (dependente) | — (sem worktree, sem branch) | **Nunca despachado**: `waiting_deps` (correto — só integra após as 4 merged; como só 2 estão `merged` no plano, o gate funcionou). `task index-task` → `not found EXIT=1` honesto. **Dependente NÃO comprovado** (motivo abaixo). |

- Integration `mc/integration-c4446599-…`: `c1e8f07 Merge capitalize-task / c8fc676 / e7517f0 / 23a7953`. `bun test` lá: **14 pass 0 fail across 3 files** (`demo-4p-60-final.log`, `EXIT=0`). Worktrees: cada uma `4–5 pass EXIT=0`. Destino `demo-4p` intacto no base (correto: só recebe após todas aprovadas).
- Defeito forçado? Não repetido aqui (já provado na demo TOUCHSET §3 com `1 pass` enganoso vs check adequado `REJECT`). Revisor aqui provou valor real ao rejeitar capitalize fraco e exigir teste multi-char.

## 4. Pausa/interrupção + resume (lease, sem duplicar)

- `start` ficou condutor (pid `1926430/1926435`, `epoch 1` implícito). Plano pausou `paused/on_error` (capitalize empty-diff) com `1 failed + 1 ready_to_merge + 1 waiting_deps`.
- `approve --retry capitalize-task` (`demo-4p-52`, `EXIT=0`): `Checkpoint on_error cleared. Job reset to ready_to_merge` + handoff `epoch 2 token-verified … workers live 0/0, model …, ceiling maxParallel=4 testCommand=bun test`. Leitura seguinte mostra `paused` de novo (re-falha spurious — evidência do bug, sem duplicar workers).
- `approve` clear (`demo-4p-53`, `EXIT=0`): `Checkpoint cleared … [running] … 2 merged, 1 failed, 1 ready_to_merge, 1 waiting_deps`, handoff epoch 3. Plano `running checkpoint=null` (confirmado).
- `resume --intake` (`demo-4p-55`, `timeout 120 → EXIT=124` honesto): `conductor live (… epoch 4 token-verified … 0 job(s) in flight)`, sem despacho duplicado (jobs: mesmos 4, index segue único `waiting_deps`). Kill foi do nosso foreground via timeout (registrado); original `1926430/35` preservado vivo (`ps` final prova). Lease/heartbeat via `recordConductorHandoff` em cada passo; `follow` nunca inventa progresso (`0 running` quando correto).

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
| `pad-task` merged | **NÃO comprovado** — `ready_to_merge` sem revisão/merge após 4+ min, mesmo com plano `running` e condutor vivo (stall documentado; `demo-4p-54/56/60`) |
| `capitalize-task merged` no plano | **NÃO comprovado como `merged`** — conteúdo merged na integration (`c1e8f07`, 5-pass) mas status `failed (empty diff)` por re-review pós-merge em modo estrito (bug documentado §3) |
| `index-task` executado/merged, destino `demo-4p` além da base | **NÃO comprovados** — `waiting_deps`, nunca despachado (correto diante das 4 não-merged; gate de dependência funcionou). Destino segue `23a7953`, integration tem só 3 merges. Não alegados. |
| Escala 8 | **NÃO tentado, NÃO comprovado** (conforme ordem) |
| mocks | **Zero** (sem stub; `MC_REVIEW_MODEL` unset prova herança) |

## 6. Verificação (fresco, com exit)

- `demo-4p-00-baseline` (`EXIT=0`): tmux antes (3 antigas), `ss` (14102/03/09 alheias, 143xx livre), versões, HEAD.
- `demo-4p-10-fixture` (`BUNTEST_BASE_EXIT=1` esperado, resto `EXIT=0`): fixture, base `23a7953`, config `14300-14399`, `FREE 14300-14399`.
- `demo-4p-20-start-full` (`EXIT=0` linha `Plan launched: 5 task(s)`): intake `09eca02f`, plano 5 tasks.
- `demo-4p-30-poll` (90×10s): POLL 3 prova 4-running (ver §2). `demo-4p-31-simultaneity` (`EXIT=0`): tmux 7, ss 4, curl 4×200.
- `demo-4p-42/43/44/45/46/47/48` (todos `EXIT=0` exceto `task index-task EXIT=1` esperado): plano `2 merged`, jobs, follow/order/tasks/questions/log via cwd `demo-pub`.
- `demo-4p-50/51` (`EXIT=0`): `paused/on_error`, `failureKind:test_failure`, `empty diff`.
- `demo-4p-52 approve --retry` (`EXIT=0`), `53 approve clear` (`EXIT=0`, plano `running`), `55 resume` (`EXIT=124` timeout honesto, epoch 4), `56 after-resume` (`EXIT=0`, ainda `2 merged/1 failed/1 ready/1 waiting`).
- `demo-4p-60-final` (`EXIT=0`): tmux depois (7 intactas), ss 14300/01/03/04, jobs 4 completed, plano `running` (2 merged/1 failed/1 ready/1 waiting), hashes, `bun test` integration `14 pass EXIT=0`, worktrees `5/4/5/4 pass EXIT=0`.
- Pulei: `bun run build`/`bun test` do plugin (read-only + irrelevante — demo usa working tree como está); suíte da fixture destino (nada fundido lá para testar além da base).

## 7. Limitações e riscos

1. **Re-review pós-merge com diff vazio (achado novo, para o produto)**: após `Merge capitalize-task c1e8f07`, o job voltou a `failed (empty diff)` em modo estrito (`requireReviewPass`). `approve --retry` re-falha deterministicamente (já integrado → diff vazio). Opções: marcar `merged` como terminal (nunca re-revisar), ou tratar re-merge vazio como no-op success mesmo em estrito quando `mergeEvidence` já registra PASS no mesmo commit, ou pausar com checkpoint distinto que permita `accept` sem re-review.
2. **Pad stall**: `ready_to_merge` sem `review pad-task` por 4+ min com condutor vivo sugere reconciliador travado ou fila bloqueada pelo `failed` irmão — investigar `runCoordinatorPass`/`reconcile` com `failed` presente (nesta lane, `failed` não deveria bloquear `ready_to_merge`).
3. `follow` sem `--repo` lê o cwd (plugin → vazio); com cwd `demo-pub` lê correto. Documentado pelo `EXIT=0` vs `0 running` inicial — conferir sempre `plan.json` (`status/checkpoint`) além do dashboard.
4. `task <nome>` só encontra jobs despachados (`jobs.json`); `waiting_deps` só no `plan.json`.
5. Sessões `mc-*-c4446599-*`, worktrees/branches da demo vivem em `/tmp/opencode/touchset-4p/xdg` + `demo-pub`; limpeza futura é `git worktree remove` + apagar branches `mc/*` **na fixture**, nunca no plugin; driver `1926430/35` deixado vivo como condutor (é nosso; `ps` final prova). Poll nosso encerrado; alheios intactos.
6. Skipped: build/suíte do plugin (escopo read-only).

---
Resumo pedido: **4 simultâneos PROVADO** (jobs 4-running 07:59:29Z + tmux 4 + ss 4 + curl 4×200 sobrepostos, `demo-4p-30/31`); **dependente NÃO comprovado** (index `waiting_deps`, capitalize com conteúdo merged mas status `failed empty-diff`, pad `ready_to_merge` sem merge — bugs/stall documentados, não inflados); escala 8 não tentada. Skipped: build/suíte do plugin (read-only).
