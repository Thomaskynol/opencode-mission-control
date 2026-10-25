# public-demo — NL → entrega sem DAG/prompts prévios (via entrada pública)

Objetivo: demonstrar que um pedido em linguagem natural vira entrega real
(2 frentes paralelas + 1 dependente) sem que o operador forneça jobs, DAG ou
prompts — a decomposição vem do MODELO via slot `generate`/`--plan-file`, os
workers são iniciados pelo produto e o coordenador decide/integra.
Escopo desta demo: **somente fixtures/docs** — nenhum `src/` alterado, sem
push, sem perfil global.

Base: `/home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control`
@ `feat/autonomous-orchestrator-v2`. Modelo: **muse-spark-1.3-contributor
(opencode-go)** em todo o ciclo (banners TUI capturados); consumo desconhecido
(sem metering). `bun 1.3.14`, `opencode v2.1.4`, `tmux 3.8`.

Evidências: `/tmp/opencode/public-evidence/` (arquivos numerados abaixo).
Fixtures descartáveis: `/tmp/opencode/public-1/app` (Caso 1),
`/tmp/opencode/public-2/numbers` (Caso 2) — sem remote (`git remote -v` vazio).

Relação com provas anteriores (não repetidas aqui): paralelismo + revisão
touchSet + correção via relaunch + merge-train + crash/resume cobertos por
`docs/live-proof.md`; pausa/retomada serve + pergunta/resposta via form +
`session.get` triplo cobertos pelo adendo live-gaps de `docs/live-proof.md`;
autonomia pontual + revisão FAIL→PASS por `docs/targeted-proof.md`.

## Convenção de comandos (entrada pública, todos copiáveis)

Todos os comandos abaixo são completos — rode a partir da raiz do repo do
produto, exceto onde indicado `cwd = fixture`. Todos copiáveis a partir da raiz; nunca na forma abreviada
(o produto imprime caminho
absoluto no `Resume with:`, equivalente ao relativo abaixo).

- `<INTAKE>` = ID impresso em `Intake <id> persisted` (capture do output do
  `start`; ex. Caso 1: `2b2851c5-e537-4f4b-aaf7-9e3b683c04b1`, Caso 2:
  `fa7c436d-4897-4bda-912b-be297a95a2e2`).
- `<PLAN>` = ID impresso em `Plan "..." started. ID: <id>` pelo driver
  (ex. Caso 1: `c332e580-f330-4931-a41d-b4016a8cfd66`, Caso 2:
  `48c2ad5f-beaa-4cc0-a3a9-519b2ac04d40`).

```bash
# 0. Iniciar o produto (build limpo; sem alterar src/)
bun run build                                   # exit 0
bun src/orchestrator-cli/index.ts help          # exit 0 — lista start|complement|auto-plan|close|follow|...

# 1. Enviar pedido NL + repo + branch destino (cwd = raiz do produto)
bun src/orchestrator-cli/index.ts start "<PEDIDO NL>" --repo /tmp/opencode/public-1/app --branch public/demo-1 --max-parallel 2
# exit 0 — persiste intake (awaiting-plan) e imprime o planner prompt + Resume with:

# 2. Gerar o plano com o MODELO (resposta real, sem stub) e validar no produto
# 2a. Salvar o planner prompt em arquivo (do output do passo 1) e chamar o modelo:
timeout 300 opencode run --model opencode-go/muse-spark-1.3-contributor --format json \
  -m opencode-go/muse-spark-1.3-contributor "$(cat /tmp/opencode/public-evidence/02-planner-prompt.txt)" \
  > /tmp/opencode/public-evidence/05-generate.raw.json
# 2b. Extrair a parte "text" (JSON estrito) para o plan-file (ver 06-model-plan.json)
# 2c. Validar no produto (fail-closed: JSON inválido/dep desconhecida/ciclo/
#     destino fora do repo/ação não autorizada abortam sem criar nada):
bun src/orchestrator-cli/index.ts auto-plan --intake <INTAKE> --plan-file /tmp/opencode/public-evidence/06-model-plan.json
# exit 0 — "Plan validated ... 3 task(s)"; cria a branch destino localmente (ensureBaseReady)

# 3. Acompanhar (cwd = fixture, ex. /tmp/opencode/public-1/app)
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts follow     # exit 0
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts progress  # exit 0 (alias)
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts task <job> # exit 0
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts log <job>  # exit 0 — última milestone
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts session <job> # exit 0 — ponteiro attach read-only
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts questions # exit 0 — forms pendentes
bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts order     # exit 0 — preview de despacho

# 4. Responder: texto livre vs approve/deny (outros seguem rodando)
bun src/orchestrator-cli/index.ts answer <job> <texto livre>  # conteúdo vai como texto; em permissão vira decisão
bun src/orchestrator-cli/index.ts answer <job> approve       # permissão: once
bun src/orchestrator-cli/index.ts answer <job> deny          # permissão: reject
# Regra (testada em tests/orchestrator-cli/auto-commands.test.ts): texto livre
# numa pergunta de conteúdo NUNCA vira approve/deny; numa pergunta de permissão
# o texto vai como mensagem explícita da decisão (decision once + message).

# 5. Pausar / retomar / complementar / cancelar (código sempre preservado)
bun src/orchestrator-cli/index.ts pause <job> [--detach]      # serve: exit 0 (interrompe loop, código intacto)
                                                                  # tmux: exit 1 com orientação (usar mc_kill; ver 23-pause-tmux.txt)
bun src/orchestrator-cli/index.ts resume <job> [texto] [--wait] # serve: mesmo sessão continua
bun src/orchestrator-cli/index.ts add <job> <texto>          # complementar: MESMA sessão continua
bun src/orchestrator-cli/index.ts complement --intake <INTAKE> <texto>  # estende o pedido, nada é reconstruído
bun src/orchestrator-cli/index.ts cancel <job>               # para o processo, preserva o código
bun src/orchestrator-cli/index.ts close                      # só solta a visão; coordenador+reconciler continuam
```

## Caso 1 — helpers de texto (VALIDADO)

Pedido exato (único input NL; evidência 1, `01-start.txt`):

> "Preciso de dois helpers pequenos em JS puro: isPalindrome(texto) e
> truncate(texto, limite), cada um com teste proprio, mais um README curto
> documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas
> terminarem."

Repo/branch: fixture descartável `/tmp/opencode/public-1/app`, criado **sem
commit inicial** para provar `ensureBaseReady` (`git init -b main`, sem remote).

- **Evidência 1 — pedido:** `01-start.txt` (intake
  `2b2851c5-…`, planner prompt impresso; `02-planner-prompt.txt`).
- **Base sem commit (fail-closed honesto):** `auto-plan` com plan-file probe
  → exit 1 `has no commits — minimal preparation: git commit --allow-empty…`
  (`03-autoplan-nocommit.txt`). Preparação mínima executada
  (`04-init-commit.txt`, `fc7b288`, sem remote).
- **Evidência 2 — requisitos/plano do MODELO (resposta real, não stub):**
  primeira resposta do modelo (`05-generate.raw.json`, sessão
  `[REDACTED-SESSION-ID]…`) foi **rejeitada pelo guard do produto**
  (`assertAuthorizedActions`: o eco de "deploy" no prompt;
  `07-autoplan2.txt`→exit 1). Segunda resposta, com nota de conformidade
  (`02b-planner-prompt-v2.txt`, sessão `[REDACTED-SESSION-ID]…`), validada:
  3 requirements (`req-palindrome`, `req-truncate`, `req-readme`), 3 tasks —
  `implement-palindrome` + `implement-truncate` paralelas, `docs-readme`
  com `dependsOn` ambas (`09-model-plan.json`, `10-autoplan2.txt`, exit 0,
  branch destino `public/demo-1` criada localmente).
- **Evidência 3 — workers reais iniciados pelo produto:** driver
  `/tmp/opencode/public-evidence/run-case1.ts` (só importa o produto; jobs
  copiados **verbatim** do plan-file validado — mapa em
  `11-dispatch-map.json`) via `mc_plan` autopilot → plano `c332e580-…`
  (`13-plan-started.txt`); `🚀 Launched 2 job(s)`; sessions tmux
  `mc-implement-palindrome` / `mc-implement-truncate`; worktrees + branches
  `mc/plan/…` sob `~/.local/share/opencode-mission-control/app/`
  (`11-driver.log`, polls em `14-last-status.txt`/`15-last-status.txt`).
  Banners "Muse Spark 1.3 Contributor OpenCode Go" em
  `17-worker-banner-*.txt`.
- **Evidência 4 — decisões do coordenador:** `decideNextJobs` (função do
  produto) antes do dispatch: elegíveis iniciais
  `["implement-palindrome","implement-truncate"]`, docs em `waiting_deps`
  (`12-decision-initial.json`); após os 2 merges o coordenador lançou
  `docs-readme` sozinho (`🚀 Launched 1 job(s): docs-readme`, `11-driver.log`).
- **Evidência 5 — verificação/correção + integração:**
  - Correções durante o ciclo: (a) guard rejeitou plano do modelo e o ciclo
    pediu nova resposta (fail-closed); (b) prompts do modelo referenciavam o
    caminho absoluto do repo principal → workers pediram permissão de diretório
    externo no TUI (sidecar sem pendências: limitação conhecida p/ tmux);
    operador respondeu **deny** nos 3 workers + complemento mesma-sessão
    redirecionando ao worktree atual (`19-operator-interventions.txt`).
  - Workers entregaram e commitaram local (`e665ff2`, `b5f2f78`, `974dbaa`);
    testes independentes `node --test` verdes nas worktrees
    (`20-*.txt`, 1 pass cada).
  - Merge-train: 3/3 merged na integration
    `mc/integration-c332e580-…` (`21-integration-log.txt`); merge-train com
    `testCommand: none` (teto do modelo) → `tests skipped` nos relatos —
    verificação funcional feita pós-merge.
  - **Teste pós-merge (atende ao pedido sem exigir a divisão exata):**
    `node --test tests/isPalindrome.test.js tests/truncate.test.js` na
    integration → **2 pass / 0 fail, exit 0** (`21-postmerge-tests.log`) +
    spot-check funcional (`arara→true`, `hello→false`, `''→true`,
    `truncate('hello world',5)→'hello...'`, `truncate('hi',5)→'hi'`).
    Main do fixture intacta (`fc7b288`).
  - Plano pausado em `pre_pr` (sem push: fixture sem remote — barreira
    efetiva, não promessa).
- **Evidência 6 — relatório final do produto:** `mc_report_final` →
  `reports/final-c332e580-….md` (copiado em `22-final-report.md`):
  `Integrated: 3, Unmet: 0, Unverified: 0`; testes/pedidos registrados em
  notas (workers sem `mc_report` no ambiente — relatado honestamente).

Comandos de Человеческий controle exercidos com saída real: `follow`,
`progress`, `task`, `log`, `session`, `questions`, `order`
(`16-*.txt`, `23-misc-cli.txt`); `complement` (`23-complement.txt`, exit 0);
`close` (`23-close.txt`, exit 0); `pause` em job tmux → exit 1 com orientação
a `mc_kill` (`23-pause-tmux.txt`; pausa/retomada serve já validada no adendo
live-gaps, não repetida).

## Caso 2 — helpers numéricos (VALIDADO, resumido)

Pedido exato diferente (prova não-codificação ao exemplo 1):

> "Preciso de dois helpers numericos em JS puro: clamp(n, min, max) e
> average(lista), cada um com teste proprio, mais um README curto documentando
> ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem."

Repo/branch: `/tmp/opencode/public-2/numbers` (projeto `numbers` — namespace
separado; **com** commit inicial desde o início, outro caminho de
`ensureBaseReady`), branch `public/demo-2`, sem remote.

- **Evidência 1–2:** intake `fa7c436d-…` (`30-start2.txt`); plano do MODELO em
  primeira tentativa já conforme (nota de conformidade incluída no prompt, sem
  mudar regras): requirements `clamp`/`average`/`readme`, tasks
  `clamp-helper` + `average-helper` paralelas e `docs-readme` dependente —
  nomes/paths diferentes do Caso 1 (`33-model-plan2.json`, sessão do modelo em
  `32-generate2.raw.json`); `auto-plan` exit 0 (`34-autoplan2.txt`).
- **Evidência 3–4:** mesmo driver (cópia com paths do caso,
  `run-case2b.ts`, mapa `41-dispatch-map.json`) → plano `48c2ad5f-…`,
  2 workers tmux + docs em `waiting_deps` (`41-driver2.log`,
  `42-decision-initial.json`). Desta vez **zero intervenção do operador**
  (instrução worktree-relativa funcionou; sem prompts de permissão);
  commits `fdaca95` (clamp) e `2d3b39f` (average).
- **Evidência 5 (com correção real em dois pontos):**
  - *Incidente A — colisão de nome tmux:* `docs-readme` falhou ao lançar
    (`Failed to create tmux session`, sessão `mc-docs-readme` ainda ocupada
    pelo Caso 1; `46-failure-record.json`). Recuperação pelo produto:
    branch residual vazia removida (verificação de ancestralidade antes,
    `46-recovery.log`) + `Orchestrator.addJob` (mesma via do loop adaptativo)
    com o task do modelo verbatim sob nome sufixado `docs-readme-retry`
    (`46-recovery-map.json`) → lançado e executado.
  - *Incidente B — merge vazio não detectado:* o worker do average committou
    na branch destino `public/demo-2` (o prompt do modelo a nomeava) em vez
    da branch da tarefa; o merge-train integrou a branch designada **vazia**
    como `skipped` e marcou `merged`. A inspeção da evidência (árvore da
    integration sem `average.*`) revelou a divergência. Correção: gate
    independente `reviewJob` do produto sobre a entrega real (`2d3b39f`,
    touchSet respeitado, testes verdes no commit exato) → **PASS**
    (`51-average-review-verdict.json`); operador completou o merge
    (`52-manual-merge.log`); README do retry partiu da integration completa
    (startPoint = integration para jobs com deps).
  - *Incidente C — reconciliador parado:* após `addJob`, o retry commitou mas
    nada mesclava — causa: `startReconciler` (intervalo de 5 s) só roda em
    `startPlan`; o driver de recuperação precisa de `resumePlan()` explícito
    (padrão do driver live). Após o ajuste, merge em segundos.
  - Teste pós-merge na integration (clamp+average+README):
    `node --test` → **2 pass / 0 fail, exit 0** (`54-postmerge2.log`) +
    spot-check (`clamp(5,1,10)→5`, `clamp(-2,0,100)→0`,
    `average([1,2,3,4])→2.5`). Main do fixture intacta; destino
    `public/demo-2` recebeu a entrega completa via merge local
    (`56-destination-merge.log`, testes verdes).
- **Evidência 6:** `mc_report_final` do plano `48c2ad5f-…`
  (`55-final-report2.md`): `Integrated: 3, Unmet: 1 (docs-readme original),
  Unverified: 0` — o registro falho preservado como trilha do incidente.

## Checkpoint

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
git status --short
# → só docs/public-demo.md (untracked); src/ intacto; fixtures só em /tmp
```

## Veredito honesto

- **Demonstrado (Caso 1 completo):** NL cru → requisitos/plano gerados pelo
  modelo de verdade (com uma rejeição fail-closed real no caminho) → workers
  reais do produto em paralelo → decisão do coordenador (2 elegíveis, docs
  depois) → verificação (testes verdes + merges gated) → integração 3/3 →
  testes pós-merge verdes → relatório final do produto → `pre_pr` sem push.
- **Demonstrado (Caso 2):** segundo pedido, domínio distinto, plano do modelo
  com outra decomposição, mesmo rigor, com dois incidentes reais
  (colisão tmux + merge vazio) detectados por evidência e recuperados pelo
  produto — inclusive um gap genuíno do gate (empty assigned branch
  integrada como `skipped`) compensado por `reviewJob` independente.
- **Limitações registradas (não bloqueiam a entrega, ficam documentadas):**
  1. `auto-plan` (CLI) valida e persiste, mas **não dispara** workers — o
     despacho continua no coordinator loop (`mc_plan`/driver com os tasks
     verbatim do plan-file; ponte explícita em `11/41-dispatch-map.json`).
     Driver de recuperação precisa de `resumePlan()` explícito
     (`startReconciler` só roda em `startPlan`) — sem isso, merges não
     disparam após `addJob`.
  2. Prompts do modelo que nomeiam a branch destino podem levar o worker a
     commitar nela em vez da branch da tarefa (Caso 2: entrega real em
     `public/demo-2`, branch designada vazia integrada como `skipped`).
     Compensações: inspeção da árvore integrada + gate `reviewJob`
     independente + merge manual registrado; considerar instruir o modelo a
     nunca referenciar branches por nome.
  3. Merge-train com `testCommand: none` (teto vindo do modelo) relata
     `tests skipped` — a garantia funcional veio dos testes pós-merge.
  4. Permissões do TUI em jobs tmux não aparecem no sidecar (`questions` vazio;
     cf. live-proof §3) — a resposta do operador foi no TUI do worker
     (deny + complemento mesma-sessão), registrada em
     `19-operator-interventions.txt`.
  5. Workers não tinham `mc_report` no ambiente (plugin fora do global) —
     conclusão detectada por saída/pane-idle; relatório final reflete isso
     honestamente (`Unverified: 0` com notas, sem inventar cobertura).
- **Não feito (fora do escopo desta demo):** push/PR (proposital, sem
  remote), repetição de pausa/retomada serve, pergunta/resposta via form e
  crash/recovery (já validados em `live-proof.md` e adendo live-gaps).

Sessões: tmux `mc-*` dos dois casos (a limpar no teardown); serves: nenhum
(modo TUI); sem push/PR/remote. Modelo o tempo todo
muse-spark-1.3-contributor (opencode-go).

---

## Apêndice final-verify2 (2026-10-25, só acréscimo — nada acima reescrito)

- **Demo mínima single-4** (documentada em `docs/single-demo.md` rerun3,
  `/tmp/opencode/single-evidence-4/`, 50 arquivos): `start` único público →
  planner OK (retry absorve auth-fail + extract-flake) → plano `fb128f07-…`
  (3 tasks) → 2 workers concluíram e commitaram (`f20023c`/`8bdd707`,
  `node --test` 3+1 pass, verificação read-only) → **parou em `2 running`**:
  a via autônoma CLI nunca chamava `monitor.start()`, `complete` nunca
  disparou, `reports/` vazio. Kill + `resume --intake` sem duplicar e
  `complement` Caso B funcionaram pela via pública. Leftover: tmux
  `mc-capitalize`/`mc-is-even` (workers da demo, encerrada) seguem no ar.
- **Fix commitado (não validado live)**: `ensureMonitorRunning` /
  `driveMonitorOnce` / `writeAutoFinalReport` na via autônoma CLI —
  implementado, sem regressão (full suite 1027/6 idêntica ao baseline em
  stash; tmux isolado 23/0), sem teste dedicado, re-demo pós-fix pendente.
- **Checks desta lane**: `bun run build` exit 0 (222 modules, 1.37 MB);
  `bun test` exit 1 — 1027 pass, 6 fail tmux pré-existentes **com prova de
  stash** (logs `final-verify2-*.log`). Sem push/PR, sem perfil global.
  Comandos públicos completos e copiáveis: ver `DELIVERY-REPORT.md` §12.
---

## Apêndice prove-autocomplete (2026-10-25, fix validado live — só acréscimo)

Base: `/home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control`
@ `feat/autonomous-orchestrator-v2` @ `404cd6e` (fix `4eb2ffb` já commitado).
Modelo único autorizado: **opencode-go/muse-spark-1.3-contributor** em todo o
ciclo (planner `--standalone` + workers `opencode --prompt`; banners TUI +
`09-planner-invocations.log`: 4 invocações `run --standalone --model
opencode-go/muse-spark-1.3-contributor --format`). `bun 1.3.14`,
`opencode v2.1.4`, `tmux 3.8`. Sem push/PR/remote, sem perfil global.

Evidências: `/tmp/opencode/prove-autocomplete-evidence/` (60+ arquivos).
Fixture descartável: `/tmp/opencode/prove-auto-app` (`git init -b main`,
`a3f9f12 chore: initial`, `git remote -v` vazio). Projeto isolado
`prove-auto-app` (sem interferir em `single-4`, cujos `mc-is-even`/
`mc-capitalize` seguem no ar).

### Comandos (todos completos, copiáveis, a partir da raiz do produto)

```bash
bun run build  # exit 0 (222 modules, 1.37 MB; 00-build.log, 50-build-final.log)

# start único público, 1 job pequeno (coordenador fica vivo em bg; só leitura depois)
cd /tmp/opencode/prove-auto-app && timeout 550 bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/prove-auto-app --branch prove/auto-1 --request "Crie um helper isOdd em JS puro com teste proprio." --max-parallel 1
# → Intake e8a1a3ff-… persisted (running). Plan launched: 1 task(s) [create-isodd-helper]. (12-full-start3.log)

# só acompanhamento (read-only)
cd /tmp/opencode/prove-auto-app && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts follow  # exit 0 (40-follow-final.txt)
cd /tmp/opencode/prove-auto-app && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts task create-isodd-helper  # exit 0 (41-task.txt)
cd /tmp/opencode/prove-auto-app && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts log create-isodd-helper  # exit 0, "No milestone reports yet" (42-log.txt)
tmux capture-pane -p -t mc-create-isodd-helper  # só leitura (16/37-*.txt)
git -C /tmp/opencode/prove-auto-app branch -a; git -C /tmp/opencode/prove-auto-app worktree list; tmux list-sessions  # só leitura (35/36/34-*.txt)

# verificação pós-merge (read-only, no worktree de integração)
node <integrationWorktree>/src/isOdd.test.js  # exit 0, OK

# retomada pública sem duplicar (coordenador descartável morto antes)
kill <coord-pid>  # workers tmux vivos (44/45/46-*.txt)
cd /tmp/opencode/prove-auto-app && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts resume --intake e8a1a3ff-7321-476b-8a18-82bf6e51adff
# → Resumed intake … without new JSON (no duplicated workers, no reintegration). (48-resume.log)
```

### Sequência (Caso único, 1 job)

1. **Starts falhos honestos (fail-closed do guard):** 2× `start --request
   "Crie um único arquivo hello.txt …"` → exit 1 `Unauthorized action in
   task "create-hello-txt"` (10/11-*.log, 3+3 tentativas planner em
   `09-planner-invocations.log`). Causa: modelo ecoou `Não execute push,
   publish ou deploy` no task prompt (`05-generate.raw.json`), e
   `PUBLISH_HINT` barra `deploy` mesmo em negação (falso-positivo já
   documentado em `single-demo.md` §limitação 2). Intake preservado
   `awaiting-plan`, nada criado. Não queimou workers.
2. **Start OK:** `Crie um helper isOdd…` → 1/1 planner OK
   (`14:46:38Z`), plano `472e71ec-…` running, 1 task `create-isodd-helper`
   (`touchSet: src/isOdd.js, src/isOdd.test.js`), branch destino
   `prove/auto-1` criada localmente, sem push.
3. **Worker real:** tmux `mc-create-isodd-helper` executou, commitou
   `cb11f6d feat: add isOdd helper with test` (`node src/isOdd.test.js → OK`;
   pane `37-worker-pane-final.txt` registra `mc_report` ausente, sem push).
4. **Monitor (fix provado):** `follow` ficou `1 running` ~4.5 min (pane idle
   `ctrl+p commands`), depois `0 running, 1 completed` + `jobs.json`
   `completed` (`31-jobs-completed.json`) — `ensureMonitorRunning` +
   `driveMonitorOnce` no reconciler cobriram o evento perdido (sem
   `mc_report`, via idle-threshold). Sem o fix, ficaria `running` (rerun3).
5. **Integração:** `completed → ready_to_merge → merging → merged`
   (`30-plan-paused-prepr.json`: `mergedAt 2026-10-25T14:52:26.681Z`,
   merge `913f305`); integração contém `src/isOdd.js` + `src/isOdd.test.js`,
   `node …/src/isOdd.test.js → OK exit 0`.
6. **Final:** all-merged em autopilot sem `humanAuth` → `paused pre_pr`
   fail-closed (sem push) + `writeAutoFinalReport` best-effort:
   `reports/final-472e71ec-….md` (`33-final-report.md`: `Merged:
   create-isodd-helper`, `Verified` vazio por construção, sem `push`).
7. **Resume:** kill do coordenador (`44-kill.txt` exit 0, tmux vivos,
   plano `paused pre_pr` intacto) + `resume --intake e8a1a3ff-…` →
   `no duplicated workers, no reintegration` (`48-resume.log`), ainda
   `1 merged`, sem novo tmux/worktree/merge; final report intacto.
   Nota honesta: `48-resume.log` traz `[MC] Invalid plan transition:
   running → creating_pr` (retomada de `pre_pr` tenta `creating_pr` direto
   de `running`, fora de `VALID_PLAN_TRANSITIONS`; warn-only, sem duplicar;
   pré-existente, fora deste escopo).

Sessões: `mc-create-isodd-helper` (desta demo) + `mc-is-even`/
`mc-capitalize` (leftover `single-4`, intocados). Worktrees: main
`a3f9f12` + integração `913f305` + job `cb11f6d` (`36-worktrees.txt`).
Branches: `main`, `prove/auto-1`, `mc/integration-472e71ec-…`,
`mc/plan/472e71ec/create-isodd-helper` (`35-branches.txt`).

### Checks (frescos, exits capturados sem pipe mascarar)

- `bun run build` exit 0 (`50-build-final.log`).
- `bun test tests/lib/monitor-autocomplete.test.ts` exit 0 — **17 pass,
  0 fail** (novo; 17 testes: `ensureMonitorRunning` via
  start/resume/`_doReconcile` + idempotência + duck-typed/throw-tolerante;
  `driveMonitorOnce` por passo + safety-net `completed`/`failed`;
  `pollNow`/`isActive` + `running→completed` via report e via pane-exit
  0/1; `writeAutoFinalReport` em `completed`, `pre_pr` e fail-closed sem
  push + best-effort; `resume` sem relançar sem reintegrar).
  TDD vermelho→verde: sem o fix (`git apply -R fix-autocomplete.patch`)
  dá **4 pass / 13 fail**; com o fix dá **17/0**
  (`fix-autocomplete.patch` em `/tmp/opencode/`).
- `bun test` full exit 1 — **1043 pass / 7 fail** (`53-full-test2.log`) vs
  baseline sem fix e sem o novo arquivo **1026 pass / 7 fail**
  (`54-baseline-full.log`): mesmos 6 tmux + 1-2 integration flake,
  **+17 pass novos, zero regressão**. `bun test
  tests/lib/tmux.test.ts tests/lib/tmux-isPaneRunning.test.ts` isolado
  exit 0 — **23 pass / 0 fail** (`52-tmux-isolated.log`).
- Modelo em todo o ciclo: `muse-spark-1.3-contributor (opencode-go)`.

### Limitações (não bloqueiam; ficam registradas)

1. Guard `PUBLISH_HINT` barra `deploy` mesmo em negação (`Não execute
   push…` do modelo) — 2 starts `hello.txt` falharam fail-closed antes do
   `isOdd` passar de 1ª. Retry absorve quando o modelo evita a palavra;
   fix do guard fora deste escopo.
2. `mc_report` ausente nos workers (pane registra `mc_report indisponível`)
   — conclusão veio por idle-threshold (~5 min), não por callback; `log`
   fica `No milestone reports yet`, `Per-Instance Contributions` vazio no
   final report (honesto, sem inventar).
3. `resume` de `pre_pr` loga `Invalid plan transition: running →
   creating_pr` (warn-only, sem efeito; pré-existente).
4. Intake slot único (`saveAutoIntake` sobrescreve); trilha dos intakes
   falhos `36fdc41b-…`/`ea545321-…` resta em `10/11-*.log`.
