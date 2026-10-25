# single-demo — start único autônomo via caminho público (live-single-demo)

Objetivo: demonstrar `start --repo --branch --request` único e autônomo com
modelo e workers reais, só via caminho público. Escopo: **live-single-demo,
SEM alterar `src/` do produto** (bug achado → só evidência, sem correção).

Base: `/home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control`
@ `feat/autonomous-orchestrator-v2` (`8b37e6c` — start único com slot interno
`opencode run --standalone`, retry+backoff, auto-advance, resume público).
Modelo: **opencode-go/muse-spark-1.3-contributor** (só autorizado). Sem push/PR,
sem perfil global, sem tocar servidor compartilhado (workers seriam tmux
privados; planner usa `--standalone`).

Evidências: `/tmp/opencode/single-evidence/` (arquivos numerados abaixo).
Fixture descartável: `/tmp/opencode/single-1` (sem remote, `git remote -v`
vazio). `src/` intacto (`git status` limpo exceto este doc).

## Resultado (veredito no topo)

**NÃO avança sozinho — bloqueado no slot do planner (falha fail-closed,
exit 1, zero efeito colateral).** Causa raiz isolada e reproduzida contra o
código do produto (só leitura): `extractPlannerText`
(`src/lib/auto-plan.ts`) não entende o envelope real de
`opencode run --standalone --model … --format json`, que é **JSONL**
(um objeto JSON por linha: eventos `step_start`, `text`, …). O modelo
respondeu strict-JSON válido dentro do evento `text`, mas o extrator tenta
`JSON.parse` no blob inteiro, falha, tenta `JSON.parse` de novo no `catch`,
e desiste com `"Planner model output contains no strict-JSON draft"` —
3 tentativas, 3 falhas idênticas, intake preservado `awaiting-plan`.
Intervenção extraordinária necessária (fora deste escopo): ensinar o extrator
a fatiar JSONL e desembrulhar os eventos `text`; depois repetir esta demo.
Nada foi corrigido aqui.

O fail-closed funcionou (nenhuma task/branch/worktree/worker criada), mas
pelo motivo errado: um draft válido foi rejeitado.

## Comandos (todos completos, caminhos absolutos, copiáveis)

```bash
# 0. Build limpo do produto (sem alterar src/) — exit 0
bun run build
# cwd = /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control

# 1. Fixture SEM commit inicial (prova de base pretendida)
rm -rf /tmp/opencode/single-1 && mkdir -p /tmp/opencode/single-1
git -C /tmp/opencode/single-1 init -b main   # exit 0, sem commit, sem remote

# 2. START ÚNICO (único comando do Caso A) — exit 1 (fail-closed)
cd /tmp/opencode/single-1 && OPENCODE_BIN=/tmp/opencode/single-evidence/bin-opencode-log.sh timeout 550 bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-1 --branch single/demo-1 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2
# → Error: Autonomous start failed (intake fa434465-d1a0-45a4-ac41-e68c285b5f93 kept for resume): Planner model output contains no strict-JSON draft — refusing to create tasks.

# 3. Diagnóstico (leitura/execução read-only do código do produto, sem src/ alterado)
bun /tmp/opencode/single-evidence/05-repro-extract.ts
# → EXTRACT_FAIL: Planner model output contains no strict-JSON draft — refusing to create tasks.
```

Instrumentação (não altera o produto; só observa): `OPENCODE_BIN` apontando
para `/tmp/opencode/single-evidence/bin-opencode-log.sh` (wrapper que registra
`argc` + 5 primeiros args com timestamp e faz `exec` do `opencode` real
intocado). Prova o slot interno: 3 invocações
`run --standalone --model opencode-go/muse-spark-1.3-contributor --format …`
(`09-planner-invocations.log`: `13:43:33Z`, `13:43:54Z`, `13:44:04Z`).

Diagnóstico do envelope (1 chamada manual ao MESMO slot, só para inspeção —
nenhum worker, nenhum JSON alimentando o produto):
```bash
cd /tmp/opencode/single-1 && timeout 280 /home/thomaskyn/.local/npm/bin/opencode run --standalone --model opencode-go/muse-spark-1.3-contributor --format json "$(cat /tmp/opencode/single-evidence/03-planner-prompt.txt)" > /tmp/opencode/single-evidence/04-generate.raw.json 2>/tmp/opencode/single-evidence/04-generate.stderr
# exit 0, 3153 bytes, stderr vazio; sessão [REDACTED-SESSION-ID]
```
`04-generate.raw.json` = 2 linhas JSONL (`step_start` + `text`); o
`part.text` do evento `text` É o draft strict-JSON válido (requirements
`is-even`/`capitalize`/`readme`; tasks `implement-is-even` +
`implement-capitalize` paralelas e `write-readme` com `dependsOn` ambas —
decomposição correta e distinta das demos anteriores, verificado em leitura).

## Sequência registrada (Caso A)

1. **Pedido NL** (único input): "Preciso de dois helpers pequenos em JS
   puros: isEven(numero) e capitalize(texto)… 2 frentes paralelas e docs só
   depois que ambas terminarem." Repo `/tmp/opencode/single-1`, branch
   destino `single/demo-1`, `--max-parallel 2`.
2. **Intake**: `fa434465-d1a0-45a4-ac41-e68c285b5f93` persistido
   `awaiting-plan` (mensagem de erro do passo 2; `01-start-nocommit.txt`).
3. **Tentativas ao modelo**: 3/3 via slot interno privado
   (`run --standalone`, nunca o serviço compartilhado), modelo
   `opencode-go/muse-spark-1.3-contributor`, backoff após cada falha.
   Todas rejeitadas pelo extrator (causa raiz acima), não pelo validador.
4. **Plano validado**: NENHUM (draft válido do modelo existia no envelope,
   mas nunca chegou ao `parsePlannerOutput` pela via interna).
5. **Workers/sessões/worktrees/branches**: NENHUM criado (verificado:
   `git branch -a` vazio, 1 worktree só a main, `tmux` sem servidor).
6. **Decisões do coordenador**: nenhuma (plano nunca criado).
7. **Verificação/correção/integração/testes pós-merge/relatório final**:
   NÃO EXECUTADOS (bloqueados no passo 3).
8. **Base sem commit**: NÃO CHEGOU a ser exercida — a ordem no
   `startAutonomousPlan` é modelo-primeiro (`runAutoIntakeWithRetry`) e
   base-depois (`ensureBaseReady`); como o planner falhou, o guard
   `has no commits` não foi atingido. Previsão (hipótese, não evidência):
   com planner OK, o próximo erro seria o de base com a preparação mínima.
   Não queimei mais chamadas ao modelo para confirmar.

## Caso B (complementação, NÃO executado)

Bloqueado pelo mesmo bug: sem plano ativo não há o que complementar
(`complement --intake` exige intake; o intake falho foi ainda sobrescrito —
ver limitação 2). Nenhum segundo domínio foi rodado; nada a provar aqui
além do registro do bloqueio.

## Retomada (NÃO executada)

Nenhum processo coordenador chegou a existir (o `start` falhou antes do
`startPlan`, que é quem arma o `setInterval` do reconciler e manteria o
processo vivo). Logo: nada para matar, nada para retomar; `resume --intake`
não foi exercido nesta demo (o mecanismo público existe no código —
`resumeAutonomousIntake` — mas sem plano persistido ele é no-op por desenho).

## Antigo 3/4 (esclarecimento pedido)

Refere-se ao Caso 2 de `docs/public-demo.md` (plano
`48c2ad5f-beaa-4cc0-a3a9-519b2ac04d40`, 4 jobs): **não integrou o
`docs-readme` ORIGINAL** — `Failed to create tmux session` (nome
`mc-docs-readme` ainda ocupado pelo Caso 1). Porquê: colisão de nome tmux
global no `launchJob`, sem sufixo automático. Requisito pendente? **NÃO**:
o recovery `docs-readme-retry` (mesmo task do modelo, nome sufixado) foi
mesclado; relatório final `55-final-report2.md`: `Integrated: 3, Unmet: 1
(docs-readme original), Unverified: 0` — o `Unmet` é trilha do incidente,
os 3 requirements (clamp/average/readme) foram atendidos. Evidência externa
em `/tmp/opencode/public-evidence/55-final-report2.md`.

## Limitações registradas

1. **Bug bloqueante (novo, desta demo)**: `extractPlannerText` não faz
   parse de JSONL (`opencode run --format json` emite eventos, 1/linha) —
   rejeita draft válido. Reproduzível: `05-repro-extract.ts` (import
   read-only de `src/lib/auto-plan.ts`) contra `04-generate.raw.json` →
   `EXTRACT_FAIL`. Só registrar aqui; correção + repetição ficam para depois.
2. **Intake é slot único** (`saveAutoIntake` sobrescreve `autoIntake` no
   `runtime-state.json`): meu `start <NL>` de diagnóstico (intake
   `d4e5e141-…`, `02-legacy-prompt.txt`) sobrescreveu o registro do intake
   falho `fa434465-…` (resta a evidência em `01-start-nocommit.txt`). Por
   desenho ("Single active intake"), mas destrói trilha em investigação.
3. **Ordem modelo-antes-da-base**: repo sem commit queima até 3 chamadas ao
   modelo antes de falhar em `ensureBaseReady` (não observado aqui porque o
   planner falhou antes; vale para após o fix 1).
4. **`resume --intake` sem plano é no-op informativo** (retorna "no active
   plan…"), não re-tenta o modelo — após falha de planner/base, o único
   caminho público é novo `start` (novo intake, novas chamadas ao modelo).
5. **Prompts do modelo citam path absoluto + branch destino** (observado no
   draft de `04-…`: "No repo /tmp/opencode/single-1, branch single/demo-1")
   — mesmo padrão que causou denies de permissão em tmux na demo anterior.
6. `mc_report_final` não está exposto no TUI humano (`help` não lista
   `report`) — relatório final desta demo seria só via plugin MCP.

## Checkpoint

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
git status --short
# → só docs/single-demo.md (untracked); src/ intacto; fixtures só em /tmp
```
Comandos acima têm exits reais (`00-build.log`: `EXIT=0`;
`01-start-nocommit.txt`: `EXIT=1`). Modelo em todo o ciclo observável:
`opencode-go/muse-spark-1.3-contributor`. Sessões tmux: nenhuma criada.
Sem push/PR/remote.

## Veredito honesto

- **Demonstrado**: caminho público único chamado 1× (`start --request`
  completo, absoluto); slot interno privado confirmado (`--standalone` +
  modelo pinado, 3 tentativas com retry); fail-closed sem efeito colateral;
  modelo real decompondo corretamente (2 paralelas + 1 dependente, domínio
  novo); causa raiz do bloqueio isolada contra o próprio código.
- **NÃO demonstrado (bloqueado)**: workers, coordenador, reconciler,
  merges, testes pós-merge, relatório final, Caso B, retomada.
- **Intervenção extraordinária**: fix em `extractPlannerText` (JSONL →
  eventos `text`) + repetir esta demo do zero. Aqui: só registrado.

---

## Adendo rerun (2026-10-25, fix 4065d91, SEM alterar `src/`)

Base: `feat/autonomous-orchestrator-v2` + `4065d91` (extrator JSONL).
Evidências: `/tmp/opencode/single-evidence-2/` (numeradas abaixo).
Fixture: `/tmp/opencode/single-2` (sem commit, sem remote).
Modelo: `opencode-go/muse-spark-1.3-contributor`. Sem push/PR, sem perfil
global, planner via `--standalone` (slot privado), sem tocar sessões do
usuário (tmux: `no server running` antes e depois).

### Resultado (veredito no topo)

**Extrator corrigido — 1 tentativa, draft válido aceito — mas novo bug
bloqueante no caminho público: `start --request "..."` via shell CLI
trunca o pedido para a 1ª palavra** (`index.ts:55` junta `argv` com
espaço após o shell já remover as aspas; `parseFlags` entrega só
`Preciso` ao planner). Intake `a4ece51c-…` persistiu `request: "Preciso"`.
O planner passou (erro mudou de extrator para base: `has no commits`),
mas com escopo errado — prosseguir queimaria workers sobre pedido
mutilado. **Registrado e parado aqui, sem base-prep, sem 2º start, sem
workers.** Escopo respeitado: `src/` intacto (`git status` só mostra este
doc).

### Comandos (todos completos, caminhos absolutos, copiáveis)

```bash
# 0. Build + testes (sem alterar src/) — ambos EXIT=0
bun run build   # 00-build.log: 222 modules, EXIT=0
bun test        # 00b-test.log: 1003 pass, 16 skip, 0 fail, EXIT=0
# cwd = /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control

# 1. Fixture SEM commit inicial
rm -rf /tmp/opencode/single-2 && mkdir -p /tmp/opencode/single-2
git -C /tmp/opencode/single-2 init -b main   # sem commit, sem remote

# 2. START ÚNICO do Caso A (único comando + só acompanhamento) — EXIT=1 (fail-closed na base)
cd /tmp/opencode/single-2 && OPENCODE_BIN=/tmp/opencode/single-evidence-2/bin-opencode-log.sh timeout 550 bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-2 --branch single/demo-2 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2
# → Error: Autonomous start failed (intake a4ece51c-801b-403c-bd62-9ae5d4661d45 kept for resume): Repo at "/tmp/opencode/single-2" has no commits — minimal preparation: ... (01-start-nocommit.txt, EXIT=1)

# 3. Prova do fix SEM nova chamada ao modelo (lê o blob JSONL da demo anterior)
bun /tmp/opencode/single-evidence-2/05-repro-extract.ts
# → EXTRACT_OK chars=2420 + VALID tasks=implement-is-even,implement-capitalize,write-readme (05-repro-extract.log)
```

Instrumentação: `OPENCODE_BIN` → `bin-opencode-log.sh` (só observa;
`09-planner-invocations.log`: **1 invocação**, `13:50:38Z`,
`run --standalone --model opencode-go/muse-spark-1.3-contributor --format`).

### Sequência registrada (Caso A)

1. **Pedido NL** (mesmo da demo anterior): repo `/tmp/opencode/single-2`,
   branch `single/demo-2`, `--max-parallel 2`.
2. **Intake**: `a4ece51c-801b-403c-bd62-9ae5d4661d45`, `awaiting-plan`
   (`02-runtime-state.json`). **`request` persistido = `"Preciso"` —
   truncado** (prova em `07-join-bug.txt`: `index.ts:55`
   `process.argv.slice(2).join(' ')` + `auto-commands.ts:289`
   `flags.get('request') ?? positional.join(' ')`).
3. **Tentativas ao modelo**: **1/1 via slot privado** (`--standalone`,
   modelo pinado), sem retry — o extrator aceitou o draft de 1ª
   (antes: 3/3 rejeitadas). Erro final é da base, não do planner.
4. **Plano validado**: draft aceito internamente, mas descartado com o
   fail-closed da base; nada persistido como plano (`state/` só tem
   `runtime-state.json`).
5. **Workers/sessões/worktrees/branches**: NENHUM
   (`06-state-proof.txt`: `branch -a` vazio, 1 worktree só a main,
   tmux sem servidor).
6. **Decisões do coordenador**: nenhuma (plano nunca criado).
7. **Verificação/correção/integração/testes pós-merge/relatório final**:
   NÃO EXECUTADOS (bloqueados pelo bug do `--request`; base-prep
   deliberadamente NÃO feita para não queimar workers em escopo truncado).
8. **Ordem modelo-antes-da-base confirmada**: hipótese da demo anterior
   virou evidência — planner OK → `ensureBaseReady` falhou como previsto.

### Caso B (distinto, NÃO executado)

Bloqueado pelo mesmo bug: qualquer `start --request` multi-palavra via
shell CLI chega truncado ao planner. Nenhum segundo domínio rodado.

### Retomada (NÃO executada)

Nenhum coordenador chegou a existir (`start` falhou antes do `startPlan`,
que arma o `setInterval`); nada para matar/retomar. `resume --intake`
não exercido (sem plano ativo é no-op por desenho). Estado da máquina
intocado (sem reboot, sem tocar sessões do usuário — não havia nenhuma).

### Novo bug (registrado, `src/` NÃO tocado)

**Truncamento do `--request` no CLI shell**: `index.ts:55` faz
`process.argv.slice(2).join(' ')` depois que o shell já consumiu as
aspas; `splitCliArgs` reparte de novo e `parseFlags` entrega a
`--request` só a 1ª palavra; o resto cai em `positional` e é ignorado
pela via autônoma (`requested` não-vazio → `positional` descartado).
Via TUI conversacional (texto cru com aspas) o bug não aparece; via
shell — o caminho que este doc anuncia como copiável — todo pedido
multi-palavra perde o escopo. Via legada (`start <texto>`) o pedido
preserva (positional-join), o que explica a demo anterior ter prompt
cheio em `02-legacy-prompt.txt`. Fix sugerido (não aplicado aqui):
preservar `process.argv` tokenizado em vez de juntar/repartir, ou
`rawRequest = [flags.get('request'), ...positional].join(' ')` quando
houver sobra posicional sem flag intercalada.

### Checkpoint

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
git status --short
# → só docs/single-demo.md (modificado, untracked desde a demo anterior); src/ intacto
```

Exits reais: `00-build.log` EXIT=0; `00b-test.log` EXIT=0 (1003 pass);
`01-start-nocommit.txt` EXIT=1; `05-repro-extract.log` EXTRACT_OK.
Consumo: 1 chamada planner (autônoma) + 0 chamadas novas na prova do
fix (reuso do blob antigo); workers: 0.

### Veredito honesto

- **Demonstrado**: fix `4065d91` funciona (JSONL→draft, 1 tentativa,
  erro agora é de base, não de extrator); fail-closed preservado em
  intake `awaiting-plan` sem efeito colateral; ordem
  modelo-antes-da-base confirmada com evidência.
- **NÃO demonstrado (bloqueado pelo bug novo)**: workers, coordenador,
  reconciler, merges, testes pós-merge, relatório final, Caso B, retomada.
- **Intervenção extraordinária**: fix no parse de `argv`/`--request`
  (preservar pedido multi-palavra via shell) + repetir do zero; depois,
  base-prep mínima e novo `start` público. Aqui: só registrado.
- **Não andou sozinho até o fim; parou por intervenção de registro**
  (parada deliberada, não pilotagem).

---

## Adendo rerun2 (2026-10-25, fixes 4065d91 + 97a25e8, SEM alterar `src/`)

Base: `feat/autonomous-orchestrator-v2` + `4065d91` (JSONL) + `97a25e8`
(argv) — HEAD `97a25e8`. Escopo: **live-single-rerun2, `src/` intacto**
(`git status` só mostra este doc).
Evidências: `/tmp/opencode/single-evidence-3/` (numeradas abaixo).
Fixture: `/tmp/opencode/single-3` (sem remote, `git remote -v` vazio).
Modelo: `opencode-go/muse-spark-1.3-contributor` (único autorizado).
Sem push/PR, sem perfil global, planner via `--standalone` (slot privado,
`OPENCODE_BIN` wrapper só observa), workers em tmux privados.
Sem `tmux` do usuário antes/depois (só `mc-*`).

### Resultado (veredito no topo)

**Avançou além das demos anteriores — planner OK, plano lançado, 2 workers
paralelos + 1 dependente — mas BLOQUEADO em permissão dos workers
(fail-wait, sem efeito destrutivo).** `argv` fix confirmado (request cheio
persistido, 3 intakes); `JSONL` fix confirmado no retry (1 tentativa,
draft aceito, erro virou base); ordem modelo-antes-da-base reconfirmada.
Após base-prep mínima (a que o próprio erro instrui), `start` público
lançou plano `89b8b806-…` (3 tasks) e coordenador/reconciler; workers
`mc-implement-*` pararam em prompt de permissão (`Access external
directory /tmp/opencode/single-3*`) porque o prompt do modelo cita path
absoluto fora do worktree — mesmo padrão da limitação 5 anterior.
Nada pilotado (sem approve/allow); retomada pública funcionou sem
duplicar workers; merges/testes/relatório final NÃO executados.

### Comandos (todos completos, caminhos absolutos, copiáveis)

```bash
# 0. Build + testes (sem alterar src/) — ambos EXIT=0
bun run build   # 00-build.log: EXIT=0
bun test        # 00b-test.log: 1008 pass, 16 skip, 0 fail, EXIT=0
# cwd = /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control

# 1. Fixture SEM commit inicial
rm -rf /tmp/opencode/single-3 && mkdir -p /tmp/opencode/single-3
git -C /tmp/opencode/single-3 init -b main   # sem commit, sem remote

# 2. START #1 no vazio (prova argv + flake do modelo) — EXIT=1 (extrator)
cd /tmp/opencode/single-3 && OPENCODE_BIN=/tmp/opencode/single-evidence-3/bin-opencode-log.sh timeout 550 bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-3 --branch single/demo-3 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2
# → Error: Autonomous start failed (intake 2ef80e24-… kept for resume): Planner model output contains no strict-JSON draft (01-start-nocommit.txt, 3 tentativas em 09-planner-invocations.log)

# 3. START #2 no vazio (prova JSONL + base) — EXIT=1 (fail-closed na base)
cd /tmp/opencode/single-3 && OPENCODE_BIN=/tmp/opencode/single-evidence-3/bin-opencode-log.sh timeout 550 bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-3 --branch single/demo-3 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2
# → Error: … (intake fb0e7b8f-…): Repo at "/tmp/opencode/single-3" has no commits — minimal preparation: … (01b-start-retry.txt, 1 tentativa, raw-0-stdout.jsonl 3652B EXTRACT_OK)

# 4. Base-prep mínima (a que o erro instrui; não pilota workers)
git -C /tmp/opencode/single-3 config user.email "demo@example.com"
git -C /tmp/opencode/single-3 config user.name "Demo"
git -C /tmp/opencode/single-3 commit --allow-empty -m "chore: initial"

# 5. START #3 com base (único que cria trabalho) — EXIT=0, coordenador vivo em bg
cd /tmp/opencode/single-3 && OPENCODE_BIN=/tmp/opencode/single-evidence-3/bin-opencode-log.sh nohup bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-3 --branch single/demo-3 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2 > /tmp/opencode/single-evidence-3/10-full-start.log 2>&1 &
# → Intake 8db173c5-… persisted (running). Plan launched: 3 task(s) [implement-is-even, implement-capitalize, write-readme].

# 6. Só acompanhamento (read-only; nenhum pilotar workers)
cd /tmp/opencode/single-3 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts follow
cd /tmp/opencode/single-3 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts task implement-is-even
cd /tmp/opencode/single-3 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts log implement-is-even
tmux capture-pane -p -t mc-implement-is-even / mc-implement-capitalize  # só leitura
git -C /tmp/opencode/single-3 branch -a; git -C /tmp/opencode/single-3 worktree list; tmux list-sessions

# 7. Retomada: matar coordenador descartável e retomar via via pública (sem novo JSON)
kill 438233  # coordenador do start #3 (ver 11-coord-pid.txt)
cd /tmp/opencode/single-3 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts resume --intake 8db173c5-dd6f-4666-8e89-4a5881e69dae
# → Resumed intake … without new JSON (no duplicated workers, no reintegration). (13-resume.log)

# 8. Caso B (distinto, resumido, mesma via pública, sem rebuild)
cd /tmp/opencode/single-3 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts complement --intake 8db173c5-dd6f-4666-8e89-4a5881e69dae "Caso B: alem dos helpers, garantir que README tenha secao de execucao dos testes com node --test."
# → Complement recorded … (same work continues, nothing rebuilt). (20-casoB-complement.txt)
```

Instrumentação: `OPENCODE_BIN` → `bin-opencode-log.sh` com tee de
stdout/stderr por invocação em `planner-raw/` (só observa).
Diagnóstico extra (1 chamada manual ao MESMO slot, só inspeção, nenhum
worker, nenhum JSON alimentando o produto):
`opencode run --standalone --model … --format json "$(cat 03-planner-prompt.txt)"`
→ `04-generate.raw.json` (3057B, 2 linhas JSONL, `EXTRACT_OK` 2326 chars,
tasks `helper-iseven,helper-capitalize,docs-readme`).

### Sequência registrada (Caso A)

1. **Pedido NL** (mesmo das demos): repo `/tmp/opencode/single-3`, branch
   `single/demo-3`, `--max-parallel 2`.
2. **Intakes** (slot único sobrescreve — ver limitação):
   `2ef80e24-…` (3 tentativas, extractor fail, sem raw salvo);
   `fb0e7b8f-…` (1 tentativa, planner OK 3652B, `awaiting-plan`, base fail);
   `8db173c5-…` (**running**, request cheio preservado — prova `97a25e8`,
   `07-request-full.txt`, `18-runtime.json`).
3. **Tentativas ao modelo** (slot privado `--standalone`, modelo pinado):
   3 fails + 1 OK (base) + 1 OK (plan) + 1 manual diagnóstico = 6 no total;
   `09-planner-invocations.log` + `planner-raw/raw-*-stdout.jsonl`
   (exit 0, stderr vazio). Primeira trinca sem raw (wrapper ainda não
   fazia tee — limitação honesta); retry prova que o mesmo prompt passa
   de 1ª.
4. **Plano validado**: `89b8b806-…` running, 3 tasks
   (`implement-is-even`, `implement-capitalize` paralelas,
   `write-readme` com `dependsOn` ambas — decomposição correta, domínio
   novo, `17-plan.json`).
5. **Workers/sessões/worktrees/branches**: 2 workers `running`
   (`mc-implement-is-even`, `mc-implement-capitalize`, tmux privados,
   `16-jobs.json`); 1 `waiting_deps` (`write-readme`, despacho correto);
   4 worktrees (main em `single/demo-3` + 2 jobs + integração
   `mc/integration-89b8b806-…`); branches `mc/plan/…` + `single/demo-3`
   criado localmente, sem push (`22-final-state-proof.txt`).
6. **Decisões do coordenador**: 7 em `runtime-state.json` (requisitos,
   paralelismo, `model answered in 1 attempt(s)`, `base ready …`,
   `plan … launched`, conducting, `resumed via public path`);
   `follow` = `2 running, 0 completed…` (`12/14/21-follow-*.txt`).
7. **Verificação/correção**: workers BLOQUEADOS em permissão
   (`15-worker-*-pane.txt`: `△ Permission required — Access external
   directory /tmp/opencode/single-3[*]`), aguardando humano; nada
   aprovado (não pilotar). Monitor sem reports (`reports/` vazio).
8. **Integração/testes pós-merge/relatório final**: NÃO EXECUTADOS
   (bloqueados no passo 7; `git log --all` só tem `chore: initial`;
   `reports/` vazio; sem `final-report`).
9. **Base sem commit**: exercida 2× (start #1 falhou no planner antes
   da base; start #2 planner OK → `ensureBaseReady` falhou como previsto;
   ordem modelo-antes-da-base reconfirmada).

### Caso B (distinto, resumido)

`complement --intake 8db173c5-…` com follow-up sobre seção de execução
dos testes no README (`20-casoB-complement.txt`, EXIT=0). Mesmo trabalho
continua, nada rebuildado; entra no scheduler sem resume manual.
Nenhum segundo domínio com workers próprios rodado (evitaria queimar
modelo em workers que parariam na mesma permissão).

### Retomada (executada)

Coordenador descartável do start #3 (`438233`) morto (`kill`,
`ps` confirma morto, workers tmux vivos); `resume --intake 8db173c5-…`
em bg (`439799` vivo) retornou `no duplicated workers, no reintegration`
+ `Decisions kept: 7` (`13-resume.log`). Plano seguiu `running`
(`2 running, 1 waiting_deps`), sem reintegrar merged (nada merged).
Sem reboot, sem tocar sessões do usuário (só `mc-*`).

### Limitações registradas

1. **Novo bloqueante (desta demo)**: prompt do worker cita path absoluto
   (`No repo /tmp/opencode/single-3, branch …`) e worker tenta
   `Read/Write /tmp/opencode/single-3/...` fora do seu worktree →
   permissão `Access external directory` trava em `running`
   (fail-wait). Mesmo padrão da limitação 5 anterior. Fix sugerido
   (não aplicado): prompt do worker referenciar paths relativos ao
   worktree, nunca repo absoluto.
2. **Flake do modelo**: start #1 (3/3 extractor fail) vs retry/manual
   (1/1 OK) com mesmo prompt; sem raw das 3 primeiras (wrapper ainda
   sem tee) não dá para distinguir envelope novo vs instabilidade.
   A partir do retry, todo planner stdout/stderr foi salvo em
   `planner-raw/`.
3. **Intake slot único** (`saveAutoIntake` sobrescreve): só o intake
   ativo sobrevive em `runtime-state.json`; trilha dos 2 primeiros
   intakes resta em `01-*.txt` + `02-intake-ids.txt` (mesmo que demo
   anterior).
4. **Ordem modelo-antes-da-base**: repo vazio queima até 3 chamadas ao
   modelo antes de `ensureBaseReady` (aqui: 3 fails + 1 OK antes do
   primeiro base fail).
5. **`resume --intake` sem plano é no-op** (por desenho); com plano
   ativo, retoma sem novo JSON e sem duplicar (demonstrado).
6. Consumo: 5 planner autônomas (3 fail + 1 base + 1 plan) + 1 manual
   diagnóstico; workers: 2 lançados (serve/tmux, chamadas via serve
   não contadas no wrapper). Exits: `00-build` 0, `00b-test` 0
   (1008 pass), `01` 1, `01b` 1, `10` 0, `20` 0.

### Checkpoint

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
git status --short
# → só docs/single-demo.md (untracked, desde demos anteriores); src/ intacto
```

### Veredito honesto

- **Demonstrado**: `97a25e8` preserva request multi-palavra (3/3 intakes
  cheios); `4065d91` aceita JSONL (retry + plan + manual `EXTRACT_OK`);
  `start` único público lança plano e 2 workers paralelos + dependente
  com teto respeitado; kill + `resume --intake` sem duplicar;
  `complement` público sem rebuild; fail-wait em permissão sem dano
  (nada merged, nada pushado, `reports/` vazio).
- **NÃO demonstrado (bloqueado no worker)**: verificação, correção,
  merges, testes pós-merge, relatório final.
- **Intervenção extraordinária**: fix no prompt do worker (paths
  relativos ao worktree, sem repo absoluto) + repetir do zero; depois
  aprovar permissão ou rodar com política que permita worktree-only.
  Aqui: só registrado, nada pilotado.

---

## Adendo rerun3 (2026-10-25, fixes 4065d91 + 97a25e8 + cec1a78, SEM alterar `src/`)

Base: `feat/autonomous-orchestrator-v2` + `4065d91` (JSONL) + `97a25e8`
(argv) + `cec1a78` (worktree-local) — HEAD `cec1a78`. Escopo:
**live-single-final, `src/` intacto** (`git status` só mostra este doc).
Evidências: `/tmp/opencode/single-evidence-4/` (numeradas abaixo).
Fixture: `/tmp/opencode/single-4` (sem remote, `git remote -v` vazio).
Modelo: `opencode-go/muse-spark-1.3-contributor` (único autorizado).
Sem push/PR, sem perfil global, planner via `--standalone` (slot privado,
`OPENCODE_BIN` wrapper só observa), workers em tmux privados.
Sem `tmux` do usuário antes/depois (só `mc-*`).

### Resultado (veredito no topo)

**Avanço máximo até aqui — planner OK, plano lançado, 2 workers
concluíram e testes passam — mas BLOQUEADO antes de merges/testes/
relatório (fail-wait sem dano).** `argv` OK (requests cheios);
`JSONL` OK (retry recupera); `cec1a78` OK (prompts 100% worktree-local,
zero `Access external directory`, workers commitaram `f20023c`/`8bdd707`
e `node --test` passa). Porém o pipeline parou em `2 running`:
workers terminaram mas o reconciler nunca marcou `completed`, `readme`
ficou em `waiting_deps`, nada merged, `reports/` vazio, sem
`final-report`. Causa raiz nova (só leitura, sem fix aqui):
via autônoma CLI (`start`/`resume --intake`) cria
`new Orchestrator(new JobMonitor(), config)`, assina eventos e arma o
reconciler, mas **nunca chama `monitor.start()`** — o `poll()` de
`JobMonitor` nunca roda, `complete` nunca dispara, idle-threshold nunca
é avaliado. Somado a isso, workers relatam `mc_report indisponível`
(não consta no catálogo Code Mode nem MCP), então sem callback a única
via seria o idle-tmux — que nunca é checada. Nada pilotado
(sem approve/allow, sem `mc_report` manual); kill + `resume --intake`
funcionou sem duplicar; `complement` público sem rebuild.

### Comandos (todos completos, caminhos absolutos, copiáveis)

```bash
# 0. Build + testes (sem alterar src/) — ambos EXIT=0
bun run build   # 00-build.log: EXIT=0, 222 modules
bun test        # 00b-test.log: EXIT=0, 1033 pass, 16 skip, 0 fail
# cwd = /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control

# 1. Fixture SEM commit inicial
rm -rf /tmp/opencode/single-4 && mkdir -p /tmp/opencode/single-4
git -C /tmp/opencode/single-4 init -b main   # sem commit, sem remote

# 2. START #1 no vazio (prova argv + retry + base) — EXIT=1 (fail-closed na base)
cd /tmp/opencode/single-4 && OPENCODE_BIN=/tmp/opencode/single-evidence-4/bin-opencode-log.sh timeout 550 bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-4 --branch single/demo-4 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2
# → Error: Autonomous start failed (intake 53db1b08-… kept for resume): Repo at "/tmp/opencode/single-4" has no commits — minimal preparation: … (01-start-nocommit.txt, EXIT=1, 3 tentativas planner em 09-planner-invocations.log)

# 3. Base-prep mínima (a que o erro instrui; não pilota workers)
git -C /tmp/opencode/single-4 config user.email "demo@example.com"
git -C /tmp/opencode/single-4 config user.name "Demo"
git -C /tmp/opencode/single-4 commit --allow-empty -m "chore: initial"

# 4. START #2 com base (único que cria trabalho) — EXIT=0, coordenador vivo em bg
cd /tmp/opencode/single-4 && OPENCODE_BIN=/tmp/opencode/single-evidence-4/bin-opencode-log.sh nohup bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts start --repo /tmp/opencode/single-4 --branch single/demo-4 --request "Preciso de dois helpers pequenos em JS puro: isEven(numero) e capitalize(texto), cada um com teste proprio, mais um README curto documentando ambos. Quero 2 frentes paralelas e docs so depois que ambas terminarem." --max-parallel 2 > /tmp/opencode/single-evidence-4/10-full-start.log 2>&1 &
# → Intake 74e22607-… persisted (running). Plan launched: 3 task(s) [is-even, capitalize, readme].

# 5. Só acompanhamento (read-only; nenhum pilotar workers)
cd /tmp/opencode/single-4 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts follow
cd /tmp/opencode/single-4 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts task is-even
cd /tmp/opencode/single-4 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts log is-even
tmux capture-pane -p -t mc-is-even / mc-capitalize  # só leitura
git -C /tmp/opencode/single-4 branch -a; git -C /tmp/opencode/single-4 worktree list; tmux list-sessions
node --test <worktree>/tests/isEven.test.js  # verificação read-only do output do worker (não pilota sessão)

# 6. Caso B (distinto, resumido, mesma via pública, sem rebuild)
cd /tmp/opencode/single-4 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts complement --intake 74e22607-c938-4187-8e1a-7e25f0b8f8d8 "Caso B: alem dos helpers, garantir que README tenha secao de execucao dos testes com node --test."
# → Complement recorded … (same work continues, nothing rebuilt). (21-casoB-complement.txt)

# 7. Retomada: matar coordenador descartável e retomar via via pública (sem novo JSON)
kill 472135  # coordenador do start #3 (11-coord-pid.txt; ps confirma morto, workers tmux vivos)
cd /tmp/opencode/single-4 && bun /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control/src/orchestrator-cli/index.ts resume --intake 74e22607-c938-4187-8e1a-7e25f0b8f8d8
# → Resumed intake … without new JSON (no duplicated workers, no reintegration). (23-resume.log)
```

Instrumentação: `OPENCODE_BIN` → `bin-opencode-log.sh` (só observa;
`09-planner-invocations.log`: 3 tentativas start #1 + 1 tentativa
start #2, todas `run --standalone --model
opencode-go/muse-spark-1.3-contributor --format`, exit 0, stderr vazio;
`planner-raw/raw-*-stdout.jsonl` com tee por invocação).

### Sequência registrada (Caso A)

1. **Pedido NL** (mesmo das demos): repo `/tmp/opencode/single-4`,
   branch `single/demo-4`, `--max-parallel 2`.
2. **Intakes** (slot único sobrescreve — ver limitação):
   `53db1b08-…` (`awaiting-plan`, request cheio — prova `97a25e8`,
   `02-runtime-awaiting.json`); `74e22607-…` (**running**, request
   cheio + follow-up Caso B, `07-request-full.txt`, `18-runtime.json`).
3. **Tentativas ao modelo** (slot privado `--standalone`, modelo pinado):
   start #1 = 3 tentativas (1 `auth FAIL` por falso-positivo
   `deploy` em "não fazer push/deploy" + 1 `extract FAIL` com
   `jej…` corrompido + 1 OK 2143B → base fail; `02c-fullcheck.txt`,
   `planner-raw/raw-0/2/4`); start #2 = 1/1 OK 3219B
   (`04-planner2-summary.txt`, tasks `is-even`/`capitalize`/`readme`).
   Total: 4 autônomas (3+1), 0 manuais, workers: 2 lançados.
4. **Plano validado**: `fb128f07-…` running, 3 tasks
   (`is-even`, `capitalize` paralelas, `readme` com `dependsOn`
   ambas — decomposição correta, domínio novo, `17-plan.json`;
   prompts 100% worktree-local com footer, `HAS_ABS: False`,
   `17-plan-prompts.txt` — prova `cec1a78`).
5. **Workers/sessões/worktrees/branches**: 2 workers **concluíram
   trabalho real** (tmux privados `mc-is-even`/`mc-capitalize`,
   `16-jobs.json` ainda `running` por falta de `complete`);
   `readme` em `waiting_deps` (despacho correto, teto respeitado);
   4 worktrees (main em `single/demo-4` + 2 jobs + integração
   `mc/integration-fb128f07-…`); branches `mc/plan/fb128f07/*` +
   `single/demo-4` criado localmente, sem push (`31-final-state-proof.txt`).
6. **Decisões do coordenador**: 8 em `runtime-state.json`
   (requisitos, paralelismo, `model answered in 1 attempt(s)`,
   `base ready …`, `plan … launched`, conducting, `resumed via
   public path`, `complement`; `18b-decisions.txt`);
   `follow` = `2 running, 0 completed…` do início ao fim
   (`19/24/25/26/27-follow-*.txt`).
7. **Verificação/correção**: workers SEM permissão-block
   (zero `Access external directory` — antes 2/2 travados);
   `18-worker-*-pane.txt`: `Done … committed as f20023c/8bdd707`,
   `node … exit 0`; verificação independente read-only:
   `30-verify-iseven.txt` (3 pass, EXIT=0),
   `30-verify-capitalize.txt` (1 pass, EXIT=0); `task`/`log`
   sem milestone (`mc_report` ausente — `20-*.txt`).
8. **Integração/testes pós-merge/relatório final**: NÃO EXECUTADOS
   (bloqueados no passo 7 — reconciler nunca marcou `completed`;
   `git log --all` só tem `chore: initial` + 2 commits de job;
   `reports/` vazio; sem `final-report`).
9. **Base sem commit**: exercida 1× (start #1: planner OK após
   retry → `ensureBaseReady` falhou como previsto; ordem
   modelo-antes-da-base reconfirmada).

### Caso B (distinto, resumido)

`complement --intake 74e22607-…` com follow-up sobre seção de
execução dos testes no README (`21-casoB-complement.txt`, EXIT=0).
Request persistido ganha `Follow-up: Caso B: … node --test.`
(`07-request-full.txt`). Mesmo trabalho continua, nada rebuildado;
entra no scheduler sem resume manual. Nenhum segundo domínio com
workers próprios rodado (evitaria queimar modelo onde o gargalo é
o monitor, não o planner).

### Retomada (executada)

Coordenador descartável do start #2 (`472135`) morto (`kill`,
`kill -9` confirma `No such process`, workers tmux vivos);
`resume --intake 74e22607-…` em bg (`475078` vivo) retornou
`no duplicated workers, no reintegration` + `Decisions kept: 8`
(`23-resume.log`). Plano seguiu `running`
(`2 running, 1 waiting_deps`), sem reintegrar merged (nada merged).
Sem reboot, sem tocar sessões do usuário (só `mc-*`).

### Limitações registradas

1. **Novo bloqueante (desta demo)**: via autônoma CLI nunca chama
   `monitor.start()` (`auto-commands.ts:322/382` cria
   `new Orchestrator(new JobMonitor(), config)`, `orchestrator.ts`
   só assina `monitor.on('complete'/'failed')` e arma o reconciler;
   nenhum `monitor.start()` em `src/lib/orchestrator.ts` nem
   `src/orchestrator-cli/`). Logo `poll()` nunca roda, `complete`
   nunca dispara, idle-threshold nunca avaliado — jobs ficam
   `running` após workers terminarem. Somado a `mc_report
   indisponível` no env dos workers (eles mesmos logam a ausência),
   não há via de conclusão. Fix sugerido (não aplicado):
   `startAutonomousPlan`/`resumePlan` chamarem `monitor.start()`
   (e `stop()` no fim/pausa) + expor `mc_report` no Code Mode dos
   workers. Aqui: só registrado, nada pilotado.
2. **Falso-positivo `PUBLISH_HINT`**: `assertAuthorizedActions`
   barra `deploy` mesmo em negação ("não fazer push/deploy" em
   `raw-0` → `auth FAIL`); retry recuperou de 1ª (o modelo seguinte
   evitou a palavra). Sugestão (não aplicada): denylist só fora
   de negação ou permitir "não/nunca/sem + push/deploy".
   Evidência em `02c-fullcheck.txt`.
3. **Flake do modelo**: start #1 teve `extract FAIL` (`jej…`
   corrompido em `raw-2`) entre dois OKs; retry com backoff
   absorveu. Todo planner stdout/stderr salvo em `planner-raw/`.
4. **Intake slot único** (`saveAutoIntake` sobrescreve): só o
   intake ativo sobrevive em `runtime-state.json`; trilha do
   `53db1b08-…` resta em `01-*.txt` + `02-*.txt` (mesmo que demos
   anteriores).
5. **Ordem modelo-antes-da-base**: repo vazio queima até 3 chamadas
   ao modelo antes de `ensureBaseReady` (aqui: 3 + 1 antes do
   primeiro base fail).
6. Consumo: 4 planner autônomas (3 start #1 + 1 start #2) + 0
   manuais; workers: 2 lançados (chamadas serve não contadas no
   wrapper). Exits: `00-build` 0, `00b-test` 0 (1033 pass),
   `01` 1, `10` 0, `21` 0, `23` 0; verifs `30-*` EXIT=0.

### Checkpoint

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
git status --short
# → só docs/single-demo.md (modificado); src/ intacto
```

### Veredito honesto

- **Demonstrado**: `97a25e8` preserva request multi-palavra (2/2
  intakes cheios); `4065d91` aceita JSONL (retry absorve
  auth-fail + extract-flake, erro vira base e depois plano);
  `cec1a78` elimina o permission-block (prompts `HAS_ABS: False`
  com footer, workers commitam e `node --test` passa — antes 2/2
  travados); `start` único público lança plano e 2 workers
  paralelos + dependente com teto respeitado; kill +
  `resume --intake` sem duplicar; `complement` público sem
  rebuild; fail-wait sem dano (nada merged, nada pushado,
  `reports/` vazio).
- **NÃO demonstrado (bloqueado no monitor)**: `readme`, merges,
  testes pós-merge, relatório final — workers terminaram mas o
  pipeline não marcou `completed` (via autônoma sem
  `monitor.start()` + `mc_report` ausente no worker).
- **Intervenção extraordinária**: iniciar/parar `JobMonitor` na
  via autônoma CLI + prover `mc_report` aos workers, depois
  repetir do zero. Aqui: só registrado, nada pilotado.


