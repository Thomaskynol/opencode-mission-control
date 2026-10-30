# Evidências das correções R01–R09 (2026-10-30)
- build.log: `bun run build` exit 0 (index.js 1.46 MB)
- full-test.log: `bun test` 1127 pass / 1 fail / 1128 (79 arquivos). Único fail: wire createPR, passa isolado 11/0 (isolamento pré-existente, falha igual com src pristino).
- Demo pública com injeção controlada: /tmp/opencode/demo-R/ (99 arquivos; fixture total.js errado + check verde irrelevante). Produto REJEITOU, pediu correção, reverificou; pausou em decisão humana legítima (touchSet) sem declarar Verified falso.
- Regressões TDD RED→GREEN: /tmp/opencode/r-verify/ (scripts ad-hoc) + tests/lib/gate-resume-approve.test.ts, gap1-integration-context.test.ts, acceptance-less-regression.test.ts.
- Revisão independente (cavecrew-reviewer): veredito aceitar, 0 achados após correções.

## Rodada 2026-10-30 — isolamento de testes + causa wire só-no-full (lane testes)
- O que existe: `tests/helpers/test-env.ts` (TEST_LIVE opt-in, nomes únicos por execução, critério de posse `isOwnedMcSession`/`parseTaggedWindows`, `isolateXdg`); `tests/lib/tmux.test.ts` com live gated + testes puros de posse; `tests/lib/wire-report.test.ts` com `loadPlan` mockado (nulo) + XDG isolado + asserts de não-chamada tmux; `tests/lib/integration.test.ts` sem path fixo (mkdtemp por teste) + XDG único + restore robusto de cwd; `scripts/manifest.sh` (HEAD/branch/estado + hashes de blobs commitados).
- O que falta / ausente (sem reconstruir): logs brutos anexos continuam só `build.log` + `full-test.log` desta pasta; sem `gh`/`opencode` live nesta rodada; sem mover `/tmp/opencode/*` para o repo.
- Causa wire só-no-full (provada, sem mascarar): `plan-state.test.ts` (+`config`/`port-allocator`) fazem `vi.mock(paths → {getDataDir: vi.fn()})`; o mock vaza entre arquivos no mesmo processo `bun test` e `getDataDir()` passa a retornar `undefined` → `join(undefined,'plan.json')` = `paths[0] must be string`. Mínimo: `bun test plan-state + wire-report` quebra (nesta dupla, com `Export getActiveRepoRoot not found`, mesma família de vazamento); full dá `paths[0]`. Fix: `wire-report` mocka `loadPlan→null` explicitamente + XDG isolado (não depende de FS global). Produção intacta (auto-fix preservado, só testes isolados).
- Manifesto: rodar `bash scripts/manifest.sh` (não commita, não faz push).
