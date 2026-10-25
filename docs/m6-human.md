# M6 — human conversational interface

Scope nomeado: `m6-human`. Writer única: `src/orchestrator-cli/*`,
`src/tools/job-pause.ts`, `src/tools/job-resume.ts`,
`src/tools/answer.ts`, `src/lib/reports.ts`, `src/tools/overview.ts`
(+ `tests/lib/human-controls.test.ts`, este doc). Não toca
`coordinator.ts`, `instance-manager.ts`, `sdk-client.ts`, `reviewer.ts`,
`merge-train.ts`, `integration.ts`, `git.ts`, `durable-state.ts`,
`file-lock.ts`, `job-state.ts`, `plan-state.ts` exceto leitura.

## TUI separada (`src/orchestrator-cli/`)

Processo conversacional próprio (`bun src/orchestrator-cli/index.ts <comando>`),
separado das sessões workers. Fala com o coordinator só via API local:
leituras de estado (`job-state`, `reports`, sidecar `durable-state`),
funções puras (`buildWorkerPrompt`, `decideNextJobs`) e endpoints de sessão
escopados a uma execução (`session.interrupt/background/wait`, prompt para a
mesma sessão). Nunca pilota worker: `session` devolve instruções de attach
somente-leitura, `log` devolve só a última linha de milestone (sem log bruto).

Comandos: `send <pedido grande>` · `follow` (resumo curto, sem log bruto) ·
`add <nome> <texto>` (complementar: continua a MESMA sessão) ·
`task <nome>` (consultar tarefa) · `order` (prévia de dispatch; prioridade
mora na lane de plano) · `pause/resume/cancel/answer/questions` abaixo.

## Pausa / retoma / cancela

- `mc_job_pause(name, detach?)` — `session.interrupt` (+ `background` se
  `detach`). O loop para, o código fica: status continua `running`
  (JobSchema não tem `paused`) + milestone `paused`. Tmux jobs não têm
  loop de sessão — parar esses é `mc_kill` (também preserva trabalho).
- `mc_job_resume(name, message?, wait?)` — continua a MESMA sessão
  (`interrupt?resume=true`), com texto complementar opcional; retorna sem
  bloquear salvo `wait: true` (`session.wait`).
- `cancel` — `mc_kill`: **para o processo, preserva o código/worktree**.
  Distinção explícita: parar processo ≠ descartar código; descarte só via
  `mc_cleanup` explícito. `kill` só atinge processos da execução
  (`list-panes #{pane_pid}` no alvo tmux do job) — nunca por nome genérico.

## Perguntas essenciais duráveis

Formulários respondíveis (`forms.ts`): memória (via rápida) + sidecar
`runtime-state.json` (sobrevive a kill -9; reconciliado no boot — entradas
de jobs mortos são descartadas, nunca re-entregues). Responder remove dos
dois stores: pergunta nunca é feita duas vezes.

**Resposta do agente (2.1.4, verificado live):** perguntas do agente
chegam como formulários de sessão (`form.created`,
`GET /session/:id/form`, `POST .../form/:formID/reply {answer}`) e
permissões como requisições escopadas à sessão
(`GET /session/:id/permission`,
`POST .../permission/:requestID/reply {decision, message}`).
Não existe endpoint `question.*`. `answerQuestion` tenta o reply do
formulário primeiro (mapeando texto/rótulo/posição para a chave do campo)
e só usa prompt de texto quando o formulário sumiu; ausência do operador
não trava frentes independentes: sem resposta em 120s o relay
auto-responde `use your best judgment`
(`QUESTION_AUTO_RESPONSE_MS` / `QUESTION_DEFAULT_RESPONSE`) e os demais
jobs seguem; `mc_answer`/`overview` sempre mostram quais jobs perguntaram.

## Relatórios

Curtos por marco (`writeMilestoneReport`), avisos imediatos de
bloqueio/falha (`writeAlertReport` → seção Alerts do overview + TUI).
`formatReportLine` é one-liner truncado em 140 chars; o sufixo `(N%)`
aparece SÓ quando o worker reportou `progress` — porcentagem nunca é
inventada (`Progress: unknown (never invented)`).

## Guards

Sem push/PR/deploy sem auth humana (lane M1, `requireHumanAuth`); sem
perfil global; sem segredos em prompts/logs (`redactSecrets`); portas e
dirs próprios por execução (alocador de portas, worktrees isoladas).
