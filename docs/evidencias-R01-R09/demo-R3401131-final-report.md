# Demo R3401131 — relatório final (caminho público, sem tocar src/tests)

- PLAN_ID: 2026-11-01-orquestrador-r3401131
- HEAD (repo plugin): `34011312edb16939916b615a251994dea113e9be` (confere prefixo 3401131)
- Data (UTC): 2026-11-01 ~03:04–03:25
- Modo: demonstração pelo caminho público; `src/` e `tests/` **read-only** (nenhum edit).
  Único arquivo criado em `docs/`: este relatório. Fixtures em `/tmp/opencode/r3401131/demo-*`,
  logs em `/tmp/opencode/r3401131/demo-*.log`. Sem push/PR/deploy. Sem commit neste repo.
- Intervenções registradas (processos **nossos**, nunca alheios):
  matar driver `resume` nohup pid 1724129 (reiniciar com `MC_REVIEW_MODEL`) e pid 1735931
  (loop travado em touchSet sistemático). Sessões tmux apenas lidas (`tmux ls`), preservadas.

## 1. Base: versão, serve, modelo, perfil, OMO

- `opencode --version`: **v2.2.5**; `bun --version`: **1.3.14** (evidência: `demo-00-env.log`).
- Serve: porta **efêmera por worker** via `allocatePort` (faixa 14100–14199, `port.lock` inter-process);
  observado na prática: workers servindo em **14101 → 14102 → 14103** (sessões distintas).
  Senha **por worker** (`resolveServePassword`: configurada vence, senão gera; fail-closed nunca vazio —
  `src/lib/prompt-file.ts:142`; persistida em `job.serverPassword`, ex.
  `d584453c…3912bb` / `f5b67e28…`). `v2WaitForServer(port,{password})` nunca sonda sem auth.
- Modelo efetivo (comprovado real):
  - planner/worker: `opencode-go/muse-spark-1.3-contributor` (default `PLANNER_MODEL_DEFAULT`,
    `src/lib/auto-plan.ts:568`; `resolveEffectiveModelRef()` sem `MC_PLANNER_MODEL` cai no default
    com warning explícito — nunca silencioso). Demo rodou com
    `MC_PLANNER_MODEL=opencode-go/muse-spark-1.3-contributor` (sem variant → sem `#`).
  - worker observado: `jobs.json` registra `modelRequested {opencode-go/muse-spark-1.3-contributor}` e
    `modelObserved {…, variant:"default"}` — pin serve observado, não alegado.
  - reviewer: `src/lib/opencode-reviewer.ts:190` usa `MC_REVIEW_MODEL` ou **omite `--model`**.
    Sem `MC_REVIEW_MODEL`, o reviewer rodou sem pin e falhou com `provider.auth 401 "User not found."`
    (default sem auth neste ambiente) → **fail-closed em todos os reviews** (causa-raiz §3).
    Prova direta: `demo-42-reviewer-probe.log` (sem `--model` → 401; com
    `--model opencode-go/muse-spark-1.3-contributor` → `REVIEW-PROBE`, cost 0).
    Correção válida sem tocar código: exportar `MC_REVIEW_MODEL` (feito a partir de 06:22Z).
- Perfil/capacidades: `~/.config/opencode/oh-my-opencode-slim.json` → `preset:"openai"`,
  `backgroundJobs.concurrency.defaultConcurrency: 2`, agentes `orchestrator`/`oracle` com skills
  (tdd-workflow, sp-*, …). Concorrência do plano respeitou `ceiling maxParallel=2`.
- OMO (`detectOMO`, `src/lib/omo.ts`): **não detectado** —
  `{"detected":false,"configSource":null,"sisyphusPath":null}` (`demo-02-omo.log`).
  Motivo real: o config global `~/.config/opencode/opencode.json` é **JSONC com comentários**
  e `checkConfigFile` faz `JSON.parse` (falha → `detected:false`), embora contenha
  `oh-my-opencode-slim@3.0.4` (que contém a substring `oh-my-opencode`). Execução **vanilla**,
  sem paridade serve/`/command`. Risco conhecido, declarado — não alegado.

## 2. Fixture isolada + pedido→plano reais (CLI pública)

- Fixture: `git init -b main /tmp/opencode/r3401131/demo-pub` (fora do repo do plugin).
  Base: `package.json` (ESM, `bun test`), `README.md`, `CONTEXT.md` (scope `repo`,
  sha `079598cd96fc`, carregado no prompt do planner). `bun test` base: **2 pass** (antes do
  reskeleton) — Bun real, Git real.
- Pedido real (sem `--model` na CLI; modelo via env):
  `start --repo …/demo-pub --branch demo-r3401131 --request "Implement sum(xs)…average(xs)…" --context …/CONTEXT.md --max-parallel 2 --test-command "bun test"`
  → intake `ff9e7bb2-…` **persisted (running)**, plano `94e18d4d-…` **4 tasks**
  `[implement-sum, implement-average, test-sum, test-average]`, deps
  (`implement-average`/`test-sum` ← `implement-sum`; `test-average` ← `implement-average`),
  `ceiling {maxParallel:2, testCommand:"bun test"}` (`demo-20-start.log`, `runtime-state.json`).
- Planner 100% real: `opencode run --standalone --model … --format json` (média 1 tentativa,
  "model answered in 1 attempt(s)"). Base pronta: `demo-r3401131@9ed1e6e7` criada localmente,
  nunca push.

## 3. Workers reais: entrega inadequada forçada → REJEIÇÃO → correção (merge travado)

Contribuições por instância (commits reais no branch `mc/plan/94e18d4d/implement-sum`):

| Instância (evidência) | Contribuição | Resultado |
|---|---|---|
| worker serve 14101 (tmux `mc-implement-sum-…-fae985c5`) | `879c588 feat: add sum ESM utility` (sum correto) + `a588f72 fix: add sum.test.js…` | REJEITADO: `plan.status=failed/paused on_error`, `touchSetViolations: [sum.test.js]`, `error: Modified files outside touchSet` (gate local real) |
| correção worker (jobs.json `completed`, port 14101, `modelObserved` triple) | tentativa de correção | REJEITADO de novo: review funcional — `tests exit 1`, `optimistic report without proof`, `opencode reviewer unavailable (exit 1) — fail-closed`, `green tests do not cover requirements` |
| **defeito forçado por mim** (registrado) | `sum.js → return xs.length` | **REJEITADO pelo Bun real**: `bun test` → `1 pass 1 fail`, `Expected: 6, Received: 3` (`demo-32-inadequate.log`, `DEFECT_EXIT=1`); baseline antes: `2 pass`, `BASELINE_EXIT=0` |
| minha correção manual | `3b4ba31` restaura sum + remove `sum.test.js` (touchSet só `sum.js`); smoke `bun -e`: `sum([1,2,3])=6, sum([])=0`, `SMOKE_EXIT=0` | `approve --retry` → `EXIT=0`, `ready_to_merge`, conductor epoch 2 (`demo-34`) |
| worker relançado (serve **14102**, nova `remoteSessionID`) | `7d45fd1 test: add sum.test.js…` (recriou o teste) | REJEITADO: touchSet de novo (`demo-40/41`) |
| `approve` simples (aceite) | `TouchSet violations … accepted`, epoch 4 | reconciler **bloqueou no merge**: `Review blocked: touchSet violation…; external functional review … fail-closed` (`failureKind: test_failure`) |
| após fix `MC_REVIEW_MODEL` + remoção (`57a7e48`, diff vs integration = só `A sum.js`) | `approve --retry` → `EXIT=0`, epoch 5 | worker relançado (serve **14103**, `243356e test: add sum.test.js…`) → **REJEITADO 3ª vez**, mesmo erro |

- Re-revisão PASS e integração local na destino: **NÃO alcançados** (plano final:
  `paused/on_error`, `implement-sum failed`, 3×`waiting_deps`; integration branch parada em
  `9ed1e6e`, = base; destino `demo-r3401131` = `9ed1e6e`, intocada). Causa-raiz dupla, evidenciada:
  1. **Reviewer sem pin** (`MC_REVIEW_MODEL` ausente → 401 fail-closed) — corrigida via env;
  2. **Conflito sistemático planner×touchSet**: o job `implement-sum` (touchSet `[sum.js]`) tem
     aceite que exige rodar `bun test sum.test.js`; todo worker recria `sum.test.js` no próprio
     branch → violação determinística (3 ciclos, commits `a588f72/7d45fd1/243356e`). O teste
     pertence ao job `test-sum`, mas o review de `implement-sum` exige cobertura verde —
     impasse de decomposição, não de implementação (o `sum` está correto e com smoke verde).
- `mc_report` (ferramenta MCP) não é invocável pela CLI pública; equivalência honesta:
  `task implement-sum` → `[completed]` porém `log implement-sum` → `No milestone reports yet`
  (workers reportaram via loop interno; `jobs.json.completedAt` existe). Contribuições acima são
  os commits reais — **relatado (4 tasks) vs ocorrido (1 job implementado corretamente, 0 merges)**.

## 4. Pausa/interrupção + `resume --intake` (conductor lease, heartbeat, handoff)

- `start` ficou como condutor (foreground >600s, timeout da ferramenta — processo registrado;
  `demo-20-start.log` íntegro com intake+plan).
- `approve --retry/approve` sempre retornou handoff confirmado, ex.:
  `conductor detached driver pid 1723448 (…, lease orchestrator-resume@…T06:17:01.351Z) —
  plan … [running] … workers live 0/0 (tmux); model … ceiling maxParallel=2 testCommand=bun test`.
- Lease real (`state/conductor.json`): epoch **1** (start 06:05:46) → **2** (approve 06:17:01,
  token `1723448:…:hkdodin2`) → **3** (`resume --intake` 06:17:22, pid 1724129,
  `1 job(s) in flight… sem duplicar workers`) → **4** (approve-accept 06:19:36) →
  **5** (retry3 06:22:34) → **6** (resume2 06:23:04, `lastHeartbeat` junto). `kill -0` do pid
  morto = falso (one-shot destaca; posse = lease+heartbeat, nunca só pid).
- `resume --intake ff9e…` (background nosso, depois morto com registro): `conductor live …
  epoch 3 … reativado sem duplicar workers`. `follow`/`progress`/`order`/`task`/`questions`
  executados do workdir da fixture com o mesmo `MC_XDG_DATA_DIR` (escopo por repo; do cwd do
  plugin retorna vazio — armadilha documentada).

## 5. Paralelismo 4+1 / escala 8

- **NÃO COMPROVADO.** Teto `maxParallel=2` respeitado; deps serializaram (máx. 1 worker vivo por
  vez; ports 14101/14102/14103 sequenciais, nunca simultâneos). `waiting_deps` comprovado como
  estado (3 jobs), mas despacho paralelo 4+1 exigiria nova intake com 4 tarefas independentes —
  não executado (loop touchSet consumiu a janela; cada worker real custa minutos).
  Escala 8: **inviável/não tentada** — marcada explicitamente como não comprovada, sem alegação.
  Limite conhecido: `port.lock` + faixa 14100–14199 suportam, mas o gargalo observado é
  lógico (touchSet/review), não de portas.

## 6. Hashes destino vs base (d18c11a5/0f22409)

- `d18c11a5` e `0f22409`: **objetos inexistentes** em ambos os repos
  (`fatal: Not a valid object name` em `demo-pub` e no plugin) — **não intercambiáveis porque
  não existem**; nada a comparar (`demo-30-hashes.log`, `EXIT=128` na sonda, sem efeitos).
- Reais: base `9ed1e6e76a…` = destino `demo-r3401131` = integration (nada mergeado);
  job branch final `243356ed73…` (5 commits à frente). Nada foi pushado (remotes intocados).

## 7. Tabela mock × real × não comprovado

| Item | Classificação |
|---|---|
| `opencode --version`, `bun --version`, `tmux ls`, `git` | Reais (Bin/Git/mux do ambiente) |
| `bun test` verde baseline / vermelho com defeito / smoke `bun -e` | Reais (Bun) |
| planner (`opencode run --standalone --model …`) | Real (OpenCode, cost 0, contributor) |
| workers serve (14101/14102/14103, senha/worker, `modelObserved` triple, tmux `mc-implement-sum-…`) | Reais (OpenCode) |
| rejeições touchSet, review fail-closed, `approve --retry` recusado (`EXIT=1`), handoffs/lease/heartbeat | Reais (fluxo do plugin, sem mock) |
| reviewer 401 sem pin / OK com pin | Real (diagnóstico + fix via `MC_REVIEW_MODEL`) |
| OMO indisponível (vanilla declarado) | Real (limitação) |
| `mc_report` por instância via CLI | Não disponível na via pública (`task`/`log` usados; `log` = sem reports) |
| re-revisão PASS, merge/integração, 4 paralelas+dep, escala 8 | **Não comprovados** (travados no touchSet sistemático; não alegados) |
| mocks | **Zero** — nenhum stub/MCP simulado nesta demo |

## 8. Verificação (o que rodei; o que pulei e por quê)

- Rodei (fresco, com exit): `opencode --version`, `bun --version`, `opencode models`,
  `opencode run --standalone --model …` (probe + reviewer), `bun test` (3×), `bun -e` smoke,
  `start/follow/progress/order/task/log/questions/approve/resume --intake` via CLI pública,
  `tmux ls` antes/depois (sessão pré-existente `mc-implement-total-…` intacta; sessão demo
  `mc-implement-sum-…` recriada pelo sistema, só lida).
- Pulei: `bun run build`/`bun test` do plugin (proibido tocar src/tests e irrelevante —
  demonstração usa o código de HEAD como está); suíte completa da fixture destino (não há
  destino fundido para testar). Verificação parcial declarada como parcial.

## 9. Limitações e riscos que o usuário precisa saber

1. O plano travou num impasse real planner×touchSet (detalhe §3); retomar exige redesenho
   (ex.: fundir `test-sum` em `implement-sum` ou permitir `sum.test.js` no touchSet) — fora do
   meu escopo read-only.
2. `MC_REVIEW_MODEL` **precisa** estar setado neste ambiente, senão todo review externo
   falha 401 fail-closed (default sem auth). Deixei setado só nos comandos a partir de 06:22Z.
3. `follow/progress` sem `MC_XDG_DATA_DIR` + cwd da fixture retornam vazio enganoso.
4. Sessão tmux `mc-implement-sum-…` e drivers foram deixados como o sistema os deixou
   (meus nohups mortos e registrados); worktrees/branches da demo vivem em
   `/tmp/opencode/r3401131/xdg` + `demo-pub` — limpeza futura é `git worktree remove` +
   apagar branches `mc/*` **na fixture**, nunca no plugin.
