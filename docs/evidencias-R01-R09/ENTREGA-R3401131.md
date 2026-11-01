# Entrega R3401131 — verificação e demonstração (2026-11-01)

- Branch: `feat/autonomous-orchestrator-v2`
- HEAD base: `34011312edb16939916b615a251994dea113e9be`
- Modelo autorizado: `opencode-go/muse-spark-1.3-contributor` (sem troca, sem serviço pago)
- Sem push/PR/deploy. Sem segredos. tmux alheio preservado.
- Evidências frescas: `/tmp/opencode/r3401131/build-final2.log` (BUILD_EXIT 0), `/tmp/opencode/r3401131/full-final2.log` (TEST_EXIT 0, 1273 pass / 15 skip / 0 fail, 98+ arquivos), demo em `docs/evidencias-R01-R09/demo-R3401131-final-report.md` + `/tmp/opencode/r3401131/demo-*.log`.

## 1. Matriz por requisito

| Requisito | Estado | Caminho executado | Evidência | Limitação |
|---|---|---|---|---|
| A. Revisão funcional real (soma-errada+teste-vazio→FAIL; correta→PASS; domínio não-soma→FAIL; fix→re-review PASS; sem `xs.length`-only) | Implementado e validado (unit); validado parcial no público | `reviewJob`/`assessFunctionalCoverage` + `reviewFunctionallyViaOpenCode` no `reviewJobWithFixLoop` público | `tests/lib/reviewer-functional-r3401131.test.ts` 8 pass (RED antes: gate passava); `bun test` full 1273/0; demo: defeito `xs.length` rejeitado pelo Bun real (`Expected 6 Received 3`, DEFECT_EXIT 1) e 3 rejeições touchSet/review fail-closed reais | Heurística local ainda estática; backstop é revisor OpenCode — sem `MC_REVIEW_MODEL` falha fechado (exige pin no deploy); re-revisão PASS + merge não alcançados na demo (travou em touchSet sistemático) |
| B. Identidade do código testado (A→B→A restore → FAIL no commit errado; builds legítimos passam) | Implementado e validado (unit); validado parcial no público | `protectInputsDuringRun`+`decideIdentityVerdict` envolvendo `gatherScopeEvidence` scope1/2 | `tests/lib/candidate-identity.test.ts` 7 pass (RED: before/after dizia clean); untracked dist/coverage passam, tracked dist falha; full 1273/0 | Poll 5ms pode perder restore sub-tick/mesmo-mtime — `shortcut:` documentado; upgrade overlayfs/fs-tracing; integração produto via wrapper (não sandbox kernel) |
| C. Condutor/liderança (posse exclusiva, fencing, heartbeat/progresso, claim atômico, handoff confirmado) | Implementado e validado (unit+multiprocesso); validado parcial no público | `plan-state.ts` epoch/token/CAS + `recordHeartbeat/recordProgress`/`isStale`; `resume --intake`/handoff verificam token/epoch+frescor | `tests/lib/conductor-lease-r3401131.test.ts` 4 pass (takeover, stale 10h, double-claim, longa saudável com budgets custom); demo: epochs 1→6, heartbeats, resume sem duplicar workers | Defaults 30min/2h podem precisar tuning; stale só marca suspect (interrupção exige ação); queda-durante-running com pane viva ainda depende de heartbeat do worker |
| D. Modelo/perfil/relatório + hashes destino | Implementado e validado | `requireTrackedModelRef` fail-closed, serve requested vs observed, TUI blockade pinned:false, `missingContributionJobs`+`describeOmoLimitation`, hash manifest | `tests/lib/model-r3401131.test.ts` + `report-contributions.test.ts` 16+ pass; demo: planner/worker triple real com variant, reviewer 401→OK com pin, OMO vanilla declarado, `d18c11a5/0f22409` inexistentes nos dois repos (não intercambiáveis) | Planner sem prova de volta (argv only); `mc_report` indisponível na CLI pública (`task/log` usados); relatório OMO só surge após assembler plugar helper (feito em tools/report.ts) |
| Demo pública: pedido→plano→workers reais→rejeição→correção→revisão→integração→pausa/resume→relatório | Implementado, validação parcial | CLI `start/approve/resume --intake/follow`, fixture `/tmp/opencode/r3401131/demo-pub`, serve 14101-14103 | Demo report: rejeição+correção+handoff reais; merge/4-paralelas+dep/8 não comprovados (impasse planner×touchSet, causa documentada) | merge, re-review PASS, 4+1, 8 = não comprovados |
| Regressão | Validado | `bun run build` + `bun test` frescos | BUILD_EXIT 0 (225 módulos, 1.56 MB); TEST_EXIT 0, 1273 pass / 15 skip / 0 fail (flaky `orchestration.test.ts` 2-fail isolado visto em run intermediário, verde no final) | — |
| Revisão independente | Validado parcial | `cavecrew-reviewer` contexto separado | 0🔴 6🟡 2❓ → 6 amarelos tratados (pin fail-closed, lease saudável, anti-colisão hashes, placeholder 0-merges, integração leve, shortcut) | Revisor sem acesso a diff/logs externos (perguntas respondidas neste relatório); wiring produto vs sintético residual |

## 2. Causas → correções → testes → resultados

- A: ramo NL 2b aceitava qualquer assert+impl não-vacuo (`xs.length` usa param). Fix: literais vinculados + distinguishing call + `isCardinalityOnlyImpl`; `findFunctionDef` ampliado; `opencode-reviewer.ts` fail-closed sem pin. RED→GREEN em `reviewer-functional-r3401131`.
- B: endpoints (HEAD/status/conteúdo) iguais após restore. Fix: snapshot SHA-256 + chmod 444 + poll 5ms + `decideIdentityVerdict`; allowlist untracked dist/build. RED→GREEN em `candidate-identity`.
- C: `claimConductorLease` last-writer-wins, verify só kill(pid,0), sem heartbeat. Fix: epoch/token/CAS, `isStale`, heartbeat/progress, verify com frescor, handoff verifica token/epoch. RED→GREEN em `conductor-lease-r3401131` (2 procs reais).
- D: planner sem variant, Verified limpo com placeholder, TUI como observado. Fix: `requireTrackedModelRef`, `missingContributionJobs`→Gaps, `describeOmoLimitation`, manifest hashes. RED→GREEN em `model-r3401131`/`report-contributions`.
- Integração: `orchestrator.ts` chama revisor externo com `requireExternalSufficiency`, envolve scopes com proteção, carrega token/epoch + heartbeat, anexa linha OMO. Full 1273/0.

## 3. Demonstração (resumo fiel)

Real: `opencode v2.2.5`, `bun 1.3.14`, planner + 3 workers serve reais (14101→14103, senha/worker, triple observada), defeito forçado rejeitado pelo Bun, 3 rejeições touchSet/review, epochs 1→6 com resume sem duplicar, reviewer 401→OK após `MC_REVIEW_MODEL`, OMO vanilla (JSONC quebra `JSON.parse`).
Não comprovados: re-review PASS, merge/integração, 4 paralelas+dep, escala 8 (impasse planner×touchSet: job `implement-sum` touchSet `[sum.js]` vs aceite exigindo `bun test sum.test.js`; todo worker recria o teste → violação determinística).
Intervenções: matar 2 drivers nohup próprios (registrado); tmux alheio só lido. Zero mocks.

## 4. Decisões, falhas, pendências

- Decisões: PWF plan novo; explorers antes; 4 fixers com ownership disjunto + 1 integrador dono de `orchestrator.ts`; TDD RED→GREEN; fail-closed em tudo (revisor/modelo/identidade); demo read-only src.
- Falhas: flaky `orchestration.test.ts` 2-fail intermediário (isolado 1 pass; final 0 fail); `wire createPR` histórico não reaberto; touchSet sistemático travou merge.
- Pendências: redesenho touchSet (fundir `test-sum` ou permitir `sum.test.js`); `MC_REVIEW_MODEL` obrigatório no deploy; tuning stale 30min/2h; overlayfs se A→B→A sub-tick virar ameaça; 4+1 e 8 com intake própria; OMO JSONC `JSON.parse` → detectar JSONC ou declarar vanilla.

## 5. Processo de verificação (versão enxuta registrada)

Critérios antes do código → teste falha antes e passa depois (fixture nova além do relatório) → caminho público real (mock vs Bun/Git real vs OpenCode real vs não comprovado) → revisão contexto separado → matriz Estado/Evidência/Limitação; sem chamar concluído sem evidência. Detalhe em `docs/continuidade-revisao-R01-R09.md` §13 e `AGENTS.md` (regras locais do repo).

## 6. Arquivos

- Código: `src/lib/reviewer.ts`, `src/lib/opencode-reviewer.ts` (novo), `src/lib/candidate-identity.ts` (novo), `src/lib/plan-state.ts`, `src/lib/orchestrator.ts`, `src/lib/merge-train.ts`, `src/lib/reports.ts`, `src/lib/model-tracker.ts`, `src/lib/sdk-client.ts`, `src/tools/report.ts`, `src/orchestrator-cli/auto-commands.ts`
- Testes: `tests/lib/reviewer-functional-r3401131.test.ts`, `tests/lib/candidate-identity.test.ts`, `tests/lib/conductor-lease-r3401131.test.ts`, `tests/lib/model-r3401131.test.ts`, `tests/lib/report-contributions.test.ts`
- Demo: `docs/evidencias-R01-R09/demo-R3401131-final-report.md`, `/tmp/opencode/r3401131/demo-*.log`
- Comandos: `bun run build` (exit 0), `bun test` (exit 0, 1273 pass / 15 skip / 0 fail)
