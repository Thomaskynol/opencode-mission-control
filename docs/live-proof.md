# live-full — prova live de ciclo completo (workers LLM reais)

Data: 2026-10-25 ~00:00–00:50 -03 (logs em UTC). Lane: somente leitura em `src/`;
escrita apenas em `/tmp/opencode/live-*` (fixtures/harness) e neste doc.
Sem clone/push/reset do produto; sem perfil global; portas privadas 14250–14299
(config do projeto fixture; tmux próprio, sem sessões compartilhadas).

Modelo autorizado: **muse-spark-1.3-contributor (opencode-go)** — usado o tempo todo
(default do ambiente; banners TUI: "Muse Spark 1.3 Contributor OpenCode Go").
Consumo: desconhecido (sem metering). `bun 1.3.14`, `opencode v2.1.4`, `tmux 3.8`.

## 1. Caso principal — 2 frentes + 1 dependente (VALIDADO)

Pedido (linguagem natural, pequeno): utils `slugify` + `wordCount` com testes, e README.
Decomposição pelo produto (`mc_plan`, modo `supervisor`, id `47916cd4`):

- `live-slug` (independente) + `live-words` (independente) lançados **simultâneos**
  (`🚀 Launched 2 job(s)`), `live-docs` em `waiting_deps`.
- Workers: 2 (depois 3, com o probe) processos reais `opencode --prompt` em
  tmux `mc-live-slug` / `mc-live-words`, branches `mc/plan/47916cd4/*`,
  worktrees sob `~/.local/share/opencode-mission-control/live-full-app/`.

Acompanhamento/exame: `mc_plan_status`, `mc_capture` (banners de modelo),
`git diff <base>..<branch>`, `bun test` nas worktrees (slug 6 pass, words 4 pass).

**Rejeição + correção (decisão do coordenador/reviewer real):**
falha induzida ROTULADA — prompt de `live-slug` mandava criar `notes-rascunho.md`
fora do escopo. O reconciliador do produto reprovou de verdade:
`❌ Job "live-slug" modified files outside its touchSet: Violations: notes-rascunho.md`
→ plano `paused`/`on_error` (`checkpointContext.failureKind=touchset`).
Correção pela via do produto: `mc_plan_approve(checkpoint=on_error, relaunch=live-slug)`
→ agente de correção no mesmo worktree reverteu (`ef77fcb fix: revert out-of-scope…`)
→ revalidação passou → `ready_to_merge`.
Gate independente com a função `reviewJob` do produto sobre artefatos reais:
pré-correção `FAIL` (touchSet), finais `PASS` (`ef77fcb`, `3447f97`).

**Integração gated:** checkpoint `pre_merge` revisado → merges pelo merge-train com
`testCommand: bun test` por merge (relatos `tests passed | 9 pass`), `live-docs`
disparado pelo coordenador após deps `merged`, README revisado (`PASS`, só `README.md`
vs integration), merge final 3/3 → plano `paused` em `pre_pr`
(PR exige autorização humana explícita — **nenhum push**; fixture sem remote).
Verificação integrada: worktree `mc/integration-47916cd4` com `slug/words/README`,
`bun test` **9 pass / 0 fail**. Main do fixture intacta (`321cc40`).

## 2. Reutilização — repo existente /tmp (VALIDADO)

`/tmp/opencode/e2e-a-app` (master `eb16598`, com sujeira pré-existente alheia
`M notes-search.ts`, intocada): suíte prévia **4 pass / 0 fail (antes)**.
Job `live-reuse` (LLM real, TUI) adicionou só `src/notes-stats.ts` + teste
(commit `105003b`): worktree com **7 pass / 0 fail** (4 prévios + 3 novos).
`mc_cleanup` removeu tudo sem merge: repo idêntico, suíte **4 pass / 0 fail (depois)**.

## 3. Controles via interface normal

- **Pausa/retomada** (`mc_job_pause/resume`, `mc_answer`): NÃO COMPROVADO.
  São serve-mode por desenho (`pauseTarget` exige port/sessionID) e o launch serve
  do produto está incompatível com o CLI v2.1.4 (legado `session.create` → `{}`).
  Evidência: `ERROR: Failed to start serve session: Failed to create session: {}`.
  Pergunta essencial via `question tool` + `session.get` triplo: idem, não comprovados
  (modelo TUI evidenciado por banner em vez de triplo).
- **Cancelamento preservando código** (VALIDADO): `mc_kill` em `live-probe`
  (sessão tmux fora, worktree+branch+commit `73b034c` preservados,
  `bun test` 5 pass na árvore preservada).
- **Queda + retomada do coordenador** (VALIDADO): `kill -9` no driver com 3 workers
  no ar → workers/tmux sobrevivem → `resumePlan()` em processo novo:
  mesmos job IDs, zero duplicatas (branches/worktrees/sessões), nada reintegrado
  (0/3 merged antes e depois), plano seguiu e concluiu o ciclo.
- **Fluxo autônomo**: após cada aprovação o pipeline seguiu sem `/continue`
  (dispatch/merge/notificações do coordenador em `driver.log`).

## 4. Intervenções extraordinárias (registradas, causa + efeito)

1. `opencode -m … --prompt` do launcher TUI rejeitado pelo CLI v2.1.4
   (`Unrecognized flag: -m`): 1ª leva de workers nasceu morta. Sem pin via
   `model-tracker` (launcher sai sem `-m`, default autorizado) — sem tocar `src/`.
2. `monitor.start()` só existe no init do plugin (`src/index.ts:198`); driver passou
   a espelhá-lo (jobs ficavam `running` p/ sempre sem poll).
3. Livelock approve→re-pause no supervisor (`approvedForMerge` nasce vazio na
   instância do approve; só `clearCheckpoint()` o popula e ninguém a invoca):
   op atômica `merge-approve` no processo do coordenador populou o set na
   instância viva + limpou o checkpoint; merges 100% no merge-train.
4. Limpeza de jobs presos `running` (1ª leva, tmux morto): `running→stopped` via
   `updateJob` do produto (mesma transição do passo 5 do `mc_kill`) e `mc_cleanup`.
5. `mc_diff` padrão `origin/main` inexistente no fixture → exame via
   `git diff <base>..<branch>` direto. `mc_answer` cross-process sem sidecar
   persistido pelo monitor — não usado (pergunta não chegou a ocorrer).

## 5. Perfil efetivo dos workers (observado, sem invocar nada artificial)

Agente `Orchestrator` (default_agent global), modelo `Muse Spark 1.3 Contributor`
via `OpenCode Go` (banners TUI), sem `mc_*` (plugin do produto não instalado no
global) — agentes instruídos a pular `mc_report` ausente; conclusão detectada por
saída do pane/idle (5 min).

## Vereditos

Validado: plano com deps, 2 workers simultâneos (pico 3), rejeição touchSet real,
correção via relaunch, reviewer `PASS` nas 3 entregas finais, merge-train com
testes, integração 9/9 verde, `pre_pr` sem push, cancel preservando código,
crash+resume sem duplicar/reintegrar, reutilização com prévios verdes antes/depois,
teardown limpo pelo produto (main `321cc40`, sem branches/worktrees/sessões/jobs).
Não comprovado (limitação do produto nesta versão, com evidência):
pausa/retomada, pergunta essencial + `mc_answer`, `session.get` triplo
(serve-launch incompatível com CLI v2.1.4).

Evidências: `/tmp/opencode/live-full/` (`driver*.log/out`, `evidence/` com
`plan/jobs-pre-crash+final.json`, `junit-*.log`, `cap*.txt`, `snap-*.json`,
`review*.ts`, `inbox/` com ops aprovadas, `inbox-fix-note.txt`).
Comandos+exits+sessões no corpo acima; saídas integrais nos logs citados.

## Adendo live-gaps — as 3 lacunas, fechadas (2026-10-25 ~01:50–02:20 -03)

Causa-raiz das 3 lacunas: SDK legado sem prefixo (`/session`,
`/global/event`, `/permission/:id/reply` → 405) não é servido pela
2.1.4; só o prefixo `/api` existe. Correção em `src/` (ver
`docs/fixes-static.md` §8): launch serve, job-comms, fork, relay,
monitor SSE e answer agora falam V2 e miram `remoteSessionID`.

Prova (`bun /tmp/opencode/live-gaps/run.ts` → `ALL LIVE GAPS OK`,
exit 0; serve `opencode v2.1.4` descartável porta **14492**, dir
`/tmp/opencode/live-gaps-app`, workers reais
**muse-spark-1.3-contributor (opencode-go)**; senha efêmera
`só-config-descartável`, sem push, sem perfil global; estado do repo
intocado; `live-gaps/state|reports` descartáveis removidos no teardown;
serves 14491/14492 mortos): evidências em
`/tmp/opencode/live-gaps/evidence/` (`run.log` integral).

- **G3 `session.get` triplo (VALIDADO):** `v2CreateSession` com
  `{agent: build, model: {opencode-go/muse-spark-1.3-contributor},
  location: {/tmp/opencode/live-gaps-app}}` → `v2GetSession` devolve
  `model.{providerID,id,variant=default}` + `agent: build` +
  `location.directory` + `projectID` (`g3-session-get.json`).
- **G1 pausa→retomada (VALIDADO):** tarefa longa via `v2Prompt` →
  `interrupt` = `{"interrupted":true}` (loop em execução parado,
  `g1-interrupt-pause.json`) → `pauseJob`/`resumeJob` do produto
  (mesma sessão, sem duplicar) → `wait` 204 → mensagens com `idle`
  (`g1-messages-after-resume.json`).
- **G2 pergunta→resposta (VALIDADO):** agente perguntou de verdade via
  question tool → `form.created` (~5s) → `answerQuestion` do produto
  respondeu pelo reply do form (`(form reply)`, 0 fallbacks de prompt;
  `g2-form-detail.json` → `g2-form-after-reply.json` com
  `state.answered answer.{q0: White}`) → sessão-irmã sem forms
  (roteamento certo) → agente desbloqueou até `idle`
  (`g2-agent-unblocked.txt`).

Veredito atualizado: pausa/retomada, pergunta essencial +
resposta via form, e `session.get` triplo passam a **validados**;
a limitação restante conhecida é escalonamento de permissão
`ask-user` sem push ao operador (visível no TUI do serve/log de
política, worker segue via auto-resposta) — documentado, não bloqueia
o ciclo.
