# targeted-proof — autonomia + revisão funcional (pontual, sem src/)

Base: `/home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control` @ `feat/autonomous-orchestrator-v2` (base `6db667e`). Sem tocar `src/`, sem push, sem perfil global.
Modelo: **muse-spark-1.3-contributor (opencode-go)** autorizado; consumo desconhecido (sem metering). `bun 1.3.14`, `opencode v2.1.4`.
Lanes: só fixtures/docs. Fixtures descartáveis em `/tmp/opencode/targeted-autonomy`, `/tmp/opencode/targeted-review`, evidências em `/tmp/opencode/targeted-proof-evidence`. 2 workers bastam (Caso A prevê 2 paralelas; Caso B 1 job); sem pilotar worker por fora (só `orchestrator-cli` + funções puras do produto + `bun test`/`git`).

Declaração DAG prévio: `docs/live-proof.md` §1 partiu de `mc_plan` com jobs+deps já especificados (DAG pronto). Este proof NÃO usa DAG pronto: parte SOMENTE da frase NL abaixo; decomposição feita pelo coordenador (modelo, esta sessão).

## Caso A — autonomia a partir de linguagem natural

Pedido exato (único input, sem tarefas/deps/prompts prontos):
> "Preciso de um util pequeno em JS puro: slugify(texto) e wordCount(texto), cada uma com teste próprio, mais um README curto documentando ambas. Quero 2 frentes paralelas e docs só depois que ambas terminarem."
Repo/branch destino: fixture descartável `/tmp/opencode/targeted-autonomy/app` (`git init -b main`, sem remote, `0f83b82 chore: init fixture`).

Via conversacional normal:
- `bun src/orchestrator-cli/index.ts "send <pedido>"` → exit 0 — embrulha com guards do coordenador (`buildWorkerPrompt`), NÃO decompõe (ver `caseA-send.txt`).
- `bun src/orchestrator-cli/index.ts "order"` → exit 0 — `No active plan.` (nenhum plano/DAG prévio; ver `caseA-order.txt`).

Decomposição pelo COORDENADOR (modelo, esta sessão — harness não criou nada):
- `targeted-slug` (independente, touch `src/slug.js, tests/slug.test.ts`, prompt: slugify+teste lower/acentos) — criado pelo coordenador.
- `targeted-words` (independente, touch `src/words.js, tests/words.test.ts`, prompt: wordCount+teste espaços/vazio) — criado pelo coordenador.
- `targeted-docs` (dependsOn `[targeted-slug, targeted-words]`, touch `README.md`, prompt: documentar ambas após merged) — dep criada pelo coordenador.
Decisão do coordenador e porquê: 2 frentes paralelas porque slug/words não se tocam (arquivos disjuntos, sem ordem); docs depois de ambas `merged` porque README precisa descrever comportamento real, não promessa. Budget 2 workers suficiente (elegíveis iniciais = 2; docs em `waiting_deps`).

Evidência decisão (mesmas funções do produto; `runCoordinatorPass` usa `decideNextJobs`):
- `bun /tmp/opencode/targeted-proof-evidence/caseA-decide.ts` → exit 0 (`caseA-decide.log`):
  - `ELIGIBLE-INITIAL:["targeted-slug","targeted-words"]`, `DOCS-BLOCKED:"waiting_deps"`
  - `ELIGIBLE-AFTER-MERGE:["targeted-docs"]`
  - `PROMPT-HAS-SLUG:true` (`buildWorkerPrompt` com request/constraints/decisions/base/acceptance, sem history dump)
- Nenhum `mc_plan` com DAG foi chamado neste caso (proposital: provar origem NL pura).

## Caso B — revisão funcional (FAIL→PASS)

Job: `targeted-words` em `/tmp/opencode/targeted-review/app` (sem remote). TouchSet `["src/words.js","tests/words.test.ts"]`; changed `["src/words.js","tests/words.test.ts"]` (dentro do escopo).
Requisitos: `REQ-BASIC` anchor `counts hello world`; `REQ-EMPTY` anchor `empty counts 0`. Revisor do produto `src/lib/reviewer.ts:reviewJob` (sem codificar resposta no coordenador; anchor só conta em `output`).

Falha induzida ROTULADA (entrega 1, `779bd66`): `text.split(" ").length` + só teste básico. `bun test` verde 1 pass (ver `caseB-test1.log`, exit 0).
- `bun /tmp/opencode/targeted-proof-evidence/caseB-review1.ts` → exit 0, veredito `fail/blocking:true` (ver `caseB-verdict1.txt`):
  - `green tests do not cover requirement "REQ-EMPTY": none of [empty counts 0] in test output`
Decisão do coordenador e porquê: lacuna funcional (vazio/espaços), não escopo; pediu correção pertinente — tratar `""`/whitespace como 0 + teste `empty counts 0` (não aceitou `retry` sem fix nem enfraqueceu teste sem registro).

Correção (entrega 2, `1254110 fix: wordCount empty/whitespace + test`): `if (!text.trim()) return 0; trim().split(/\s+/)` + teste extra cobre `""`, `"   "`, `"hello   world"`. `bun test` verde 2 pass (ver `caseB-test2.log`, exit 0). Diff em `caseB-diff2.txt`/`git show HEAD`.
- `bun /tmp/opencode/targeted-proof-evidence/caseB-review2.ts` → exit 0, veredito `pass/blocking:false, reasons:[]` (ver `caseB-verdict2.txt`, `reviewedCommit 1254110`).

## Matriz pontual

| ID | Critério | Resultado | Evidência |
| --- | --- | --- | --- |
| AUT-1 | Só NL vira tarefas+deps+prompts pelo coordenador (sem DAG prévio) | Pass | pedido exato + `caseA-send.txt` (só embrulha) + `caseA-order.txt` (`No active plan`) + `caseA-decide.log` |
| AUT-2 | Coordenador decide ordem/paralelismo e conduz (2 workers) | Pass | `ELIGIBLE-INITIAL` 2 paralelas, docs `waiting_deps` → `ELIGIBLE-AFTER-MERGE` docs |
| REV-F1 | Entrega in-scope + verde mas incompleta falha no gate | Pass | `caseB-test1.log` 1 pass + `caseB-verdict1.txt` FAIL REQ-EMPTY |
| REV-F2 | Correção pedida + reverificação passa | Pass | `1254110` diff + `caseB-test2.log` 2 pass + `caseB-verdict2.txt` PASS |

## Checkpoint (comandos+exits, copiáveis)

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
bun src/orchestrator-cli/index.ts "send Preciso de um util pequeno em JS puro: slugify(texto) e wordCount(texto), cada uma com teste próprio, mais um README curto documentando ambas. Quero 2 frentes paralelas e docs só depois que ambas terminarem." # exit 0
bun src/orchestrator-cli/index.ts "order" # exit 0 (No active plan)
bun /tmp/opencode/targeted-proof-evidence/caseA-decide.ts # exit 0
bun test --cwd /tmp/opencode/targeted-review/app # entrega1: exit 0, 1 pass; entrega2: exit 0, 2 pass
bun /tmp/opencode/targeted-proof-evidence/caseB-review1.ts # exit 0, VERDICT:fail
bun /tmp/opencode/targeted-proof-evidence/caseB-review2.ts # exit 0, VERDICT:pass
bun test tests/lib/coordinator.test.ts tests/lib/reviewer.test.ts # exit 0, 43 pass 0 fail (41 na lane targeted; +2 guards `isGitPushArgs`)
bun run build # exit 0, Bundled 221 modules
git status --short # vazio (só este doc untracked + fixtures em /tmp)
```

Sessões: nenhuma tmux/worktree do produto criada (proposital, sem pilotar por fora); só processos `bun` efêmeros nesta sessão. Sem push/PR/remote (fixtures sem remote; `git remote -v` vazio).
Veredito honesto: autonomia (decomposição+decisão pelo coordenador via caminho conversacional+funções do produto) e revisão funcional (FAIL→PASS pelo `reviewJob` do produto) **demonstrados** no recorte pontual; ciclo full com workers LLM vivos continua coberto por `docs/live-proof.md`, não repetido aqui para não gastar consumo.

Evidências: `/tmp/opencode/targeted-proof-evidence/` (`caseA-send.txt`, `caseA-order.txt`, `caseA-decide.ts/.log`, `caseB-test1/2.log`, `caseB-jobHead1/2.txt`, `caseB-diff2.txt`, `caseB-review1/2.ts`, `caseB-verdict1/2.txt`, `junit1.xml`).
