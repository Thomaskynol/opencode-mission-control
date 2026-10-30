# MANIFESTO — snapshot produto (review-packet-2, R09)

Data: 2026-10-30. Lane fixer (R06/R07/R09). Sem commit (HEAD segue `3b49a95`).

- HEAD completo: `3b49a95d812c20d8a3dbb8e050f83b6179fab5bc`
- HEAD curto: `3b49a95`
- Branch: `feat/autonomous-orchestrator-v2`
- Base upstream: `6db667e4532d7e4808520a1b5ad5b82da927155d` (cf. `docs/review-packet-2/ESTADO.md`)
- Estado da árvore no momento do manifesto (uncommitted — lane em andamento):
  - `M src/index.ts` (R06)
  - `M tests/lib/monitor.test.ts` (R07)
  - `M tests/lib/monitor-v2.test.ts` (R07)
  - `?? tests/v2-host-context.test.ts` (R06)
  - `?? docs/continuidade-revisao-R01-R09.md` (pré-existente da sessão de mapeamento, intocado por esta lane)
  - `?? docs/review-packet-2/MANIFESTO.md` (este arquivo)

## Correspondência c2759a1→3b49a95 (commits, sem working tree)

`git diff --stat c2759a1..HEAD` (HEAD commitado, antes desta lane):

- `c2759a1a27cad6417966c9830e47ec8b88aa7049` → `3b49a95d812c20d8a3dbb8e050f83b6179fab5bc`
- Só docs, 4 arquivos, +175 linhas, 0 em `src/`/`tests/`:
  - `docs/matrix-final.md` (+121: §30 dest-live F08 PASS + warning follow-up `running → creating_pr`)
  - `docs/review-packet-2/AUSENCIAS.md` (+9, novo)
  - `docs/review-packet-2/ESTADO.md` (+20, novo — declara HEAD `c2759a1`)
  - `docs/review-packet-2/REVISAO-ENTRADA.md` (+25, novo)
- Commits no intervalo: `f30e6f5` (adendo §29) → `3b49a95` (matrix §30).

## Tamanho do snapshot (sem .git)

- `src` (produto): 788K
- `tests` (suíte): 1012K
- `docs` (evidência/relato): 332K
- Árvore útil (`--exclude=.git --exclude=node_modules --exclude=dist`): 3.1M
- Contagem de arquivos de produto (`src`+`tests`+`docs`): 165 arquivos
- ZIP final: pendente (aguardar sinal da lane core; sem `.git` no pacote por desenho).

## SHA256 por arquivo de produto (working tree, com R06/R07 uncommitted)

Arquivo de lista integral: `/tmp/opencode/manifesto-sha256.txt`
(`sha256sum` da lista: `0924d5436b959a06f11512353fa8daf2a77fe0e54c71432a5b3a7b265827ec1c` —
regenerar com `find src tests docs -type f | sort | xargs sha256sum`).

Primeiras entradas (amostra; lista completa no arquivo acima):

- `8d760b49f89ae93dff62a9904fea1077c29ba70f8cf29647a9ad71936bc822a8  docs/continuidade-revisao-R01-R09.md`
- `03b281fe066449af04e58702bbe986cb5d8d498486c6f25440a72127b76117ff  docs/DELIVERY-REPORT.md`
- `e7610a1c6618b07b4aced9e93618da0aca654fc126bb659b1a5c355d3b80c7c8  docs/fixes-static.md`
- `b256003a674fc622e8ff1604e21fab378c4227884f75eb5f1763f5185d7e49db  docs/guards-proof.md`
- `f06cecfb8c270d8380d22b523622179ddab1ae1e807fe6ed3c8aa65d031b1166  docs/live-proof.md`

Nota: os hashes acima são do working tree COM as mudanças uncommitted desta
lane (R06 `src/index.ts`, R07 `tests/lib/monitor*.test.ts`, novo
`tests/v2-host-context.test.ts`). Para o snapshot commitado `3b49a95` puro,
usar `git archive 3b49a95 src tests docs` — o ZIP final será gerado do mesmo
snapshot commitado após o sinal da lane core (código+testes+docs+evidências,
sem `.git`).

## Verificação desta lane (fresca, exits capturados)

- `bun run build` → exit 0 (`Bundled 222 modules`, `index.js 1.44 MB`, `/tmp/opencode/r06-build.log`)
- `bun test tests/v2-contract.test.ts` → exit 0 (26 pass, 0 fail)
- `bun test tests/v2-host-context.test.ts` → exit 0 (7 pass, 0 fail)
- `bun test tests/lib/monitor.test.ts tests/lib/monitor-v2.test.ts` → exit 0 (34 pass, 0 fail)
- `bun test` full → exit 1 — 1125 pass / 2 fail / 1127 testes / 78 arquivos (`/tmp/opencode/r07-full.log`):
  ambos os fails passam isolados (wire 11/0 em `/tmp/opencode/r07-wire-iso.log`,
  orchestration 1/0 em `/tmp/opencode/r07-orch-iso.log`) — padrão de
  isolamento/ordenação, sem fail fora do conjunto conhecido; 0 fails em
  `tests/lib/tmux*.test.ts` no full (6 flakes do baseline eliminados pela
  conversão p/ spyOn).
- Não commitado; sem push/PR; sem perfil global; sem segredos.

## Atualização acceptanceLess (lane fixer, TDD RED→GREEN, sem commit)

- RED (fallback ausente, `git stash` dos 6 `src/` da core): exit 1 —
  registro sem `scope:task`/flag (`accless-red.log`, `accless-red2.log`).
- GREEN: `tests/lib/acceptance-less-regression.test.ts` 1/0
  (`accless-green2.log`); vizinhos R01 16/0 em 4 arquivos
  (`accless-neighbors.log`); `bun run build` exit 0 (223 modules, 1.46 MB,
  `accless-build.log`).
- SHA256 refeita: 167 arquivos (`src`+`tests`+`docs`), lista em
  `/tmp/opencode/manifesto-sha256-accless.txt`
  (`sha256sum` da lista: `53f1173f01cf1517f9213d8b3f654cca218939036b34d1d6a1d99f3f574421ba`).
- Observação à core: smoke global refaz `scope:'integration'` sobre o
  `'task'` da revisão (ver §33 da matrix); flag e relatório corretos.

## Atualização R01 (lane fixer, sem commit; HEAD segue `3b49a95`)

TDD RED→GREEN (skill `sp-test-driven-development`):
- RED (gate antigo restaurado via `git stash` dos 6 arquivos `src/` da lane core,
  testes novos intactos): `gate-resume-approve` 6 pass / 1 fail
  (`Expected to not contain "merged", Received "sum-total:merged"`),
  `gap1` 0 pass / 1 fail
  (`Received "helper-a:merged,helper-b:merged"`) —
  o gate estrutural funde a implementação errada; falha no ponto exigido.
- GREEN (stash pop, gate funcional): `gate-resume-approve` 7/0
  (`/tmp/opencode/r01-green-defect1.log`), `gap1` 1/0
  (`/tmp/opencode/r01-green-gap1b.log`). Corpos sem enfraquecimento:
  rejeição por cobertura (`do not cover requirement`), não por touchSet/diff.
- `bun run build` → exit 0 (`Bundled 223 modules`, `index.js 1.46 MB`,
  `/tmp/opencode/r01-final-build.log`).
- `bun test` full → exit 1 — 1125 pass / 2 fail / 1127 testes / 78 arquivos
  (`/tmp/opencode/r01-final-full.log`):
  1. `wire-report createPR` — passa isolado 11/0
     (`/tmp/opencode/r01-iso-wire.log`): isolamento/ordenação, mesmo padrão
     pré-existente.
  2. `orchestration integration suite` (outer) — 4 testes internos falham
     TAMBÉM no run isolado single-file (`/tmp/opencode/r01-iso-orch.log`):
     jobs presos em `running` até o timeout porque o gate funcional rejeita
     merges cujos prompts não têm critérios `- [ ]`
     (ex.: `prompt: 'Update README details'`) — âncora fallback (jobName)
     nunca coberta pelo `npm test` (`echo 'Tests pass'`) desses fixtures.
     Determinístico, NÃO ambiental; cai na decisão da lane core sobre
     planos manuais sem intake/aceitação (cf. matrix §24 limitação 2:
     "planos manuais sem intake mantêm só test-gate") — fora do meu escopo
     (não toco `src/` da core); registrado aqui por nome, sem alegar verde.
- SHA256 refeita com os 2 testes R01: 166 arquivos (`src`+`tests`+`docs`),
  lista em `/tmp/opencode/manifesto-sha256-r01.txt`
  (`sha256sum` da lista: `2524ce0a07ac80e06b6c3b7119f5a51570e4673722639adb146f66aa2dc60df1`).

Skipped: ZIP final + commit (aguardam reconciliação da core lane).
Risk: `orchestration.test.ts` vermelho determinístico no estado atual —
o commit/ZIP final deve sair com o veredito da core (exceção p/ manual vs
ajuste dos fixtures p/ R01) ou declarar o fail como pendência conhecida.

## Selagem final (2026-10-30, lane docs — só acréscimo)

Os SHAs finais (código+testes+docs do snapshot commitado) serão selados no
commit/ZIP pela reconciliação do orquestrador. Nenhum hash é inventado aqui:
as listas intermediárias (`/tmp/opencode/manifesto-sha256*.txt`) cobrem o
working tree de cada lane e serão substituídas pela lista do snapshot
commitado no fechamento. Sem `.git` no ZIP, por desenho.
