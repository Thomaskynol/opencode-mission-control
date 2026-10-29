# REVISAO-ENTRADA — review-packet-2 (refs para perguntas prováveis)

Matriz consolidada: `docs/matrix-final.md` §29 (F01–F12 com implementação `arquivo:linha/função` + evidência + nível).
Estado da árvore: `docs/review-packet-2/ESTADO.md`.

## Onde responder cada pergunta provável

- "A suíte passa?" → §29.1 (sequência 1076/0 → 1094/0 → 1113/7); logs: `/tmp/opencode/full-final.log`, `full2.log`, `v2/full-test.log` (+ isolados `v2/*-isolated.log`).
- "Por que 7 fails?" → §29.1 + §§22.2/25–28: 6× `tests/lib/tmux*.test.ts` (precisam tmux real) + 1× `wire-report createPR` (ambiental); **nenhum fail fora do conjunto conhecido** em nenhum full da rodada.
- "mock.module vs spyOn?" → §29.1: `focused.log` (poluição) vs `*-alone.log` (verdes); 0 `mock.module` nos 6 testes novos (só `spyOn`+`mock.restore()`).
- "O que cada commit fix fez?" → §29.4 + mensagens: `c788c1c` (launcher), `d10bb3a` (gap1+gap2), `a48000f` (gate+ceiling+pausa+one-shot), `d6d0d73` (baseBranch), `c2759a1` (V2 docs).
- "F08 destino explícita foi validada live?" → **NÃO** (§29.2 F08 + limitação 3): só teste; live pós-fix pendente.
- "F05 'não autorizo' foi exercido?" → **NÃO** live (§29.2 F05 + limitação 2): só teste PT+EN.
- "O que falta?" → §29.3 (8 limitações honestas).
- "Baseline na 6db667e?" → **Não rodado nesta rodada** (§29.1, declarado); não alegar.
- "E2E-E / metering / crash-durante-running?" → Pendentes (§29.3 itens 6–8).
- Demos live: `/tmp/opencode/demo-fixes/` (sem veredito agregado — ausência listada), `/tmp/opencode/demo-fixes2/99-VEREDITO.md` (BLOQUEADO no gate → motivou `d10bb3a`+`a48000f`), `/tmp/opencode/final-live/99-VEREDITO.md` (4 achados → motivaram `a48000f`+`d6d0d73`), `/tmp/opencode/revalidate/99-VEREDITO.md` (pós-fix: item 1 PASS, item 4 PASS, B2 parcial-completed).

## Matriz resumida por ID (nível)

- F01 gate: Validado live (item 1) · F02 repo: Validado live (terceira pasta) · F03 complement: Parcial
- F04 ceiling: Validado teste+live · F05 PT: Verificado teste, live pendente · F06 triple: Validado planner+serve
- F07 resume: B1 validado, B2-paused parcial · F08 destino: código+teste, **live PENDENTE**
- F09 relatório: Validado live (anterior) · F10 V2: carga+registro+exec representativa, 17 tools pendentes
- F11 context: Validado teste · F12 lease: Verificado teste
