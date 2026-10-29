# AUSENCIAS — logs e provas não incluídos (não reconstruídos)

- `demo-fixes/99-VEREDITO.md`: não existe (demo sem veredito agregado). Incluído o diretório como está.
- Argv exato de cada invocação `bun test`/`bun run build` da suíte: nem todos os logs preservam o comando; onde preservado, está no log; demais = comando padrão da lane (`bun test` full / `bun run build`), declarado como tal, sem reconstrução.
- Nenhum run na base `6db667e` (sem log) — baseline original não alegado (§29.1).
- `tests/v2-contract.test.ts` standalone log: não guardado em `/tmp/opencode/v2/` (reproduzível via `bun test tests/v2-contract.test.ts` → 26/0).
- Medição de metering/custo do modelo live: nunca registrada (limitação §29.3-8).
- E2E-E (`MANUAL_TEST_PLAN.md`): não executado (limitação §29.3-6).
- `.git/` e `node_modules/` excluídos do ZIP (código-fonte incluído integralmente; commits referenciados verificáveis na árvore de origem).
