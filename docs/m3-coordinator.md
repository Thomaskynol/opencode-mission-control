# M3 — coordinator (single judge)

Scope nomeado: `m3-coordinator`. Writer única: `src/lib/coordinator.ts`
(+ `tests/lib/coordinator.test.ts`, este doc). Não toca M1/M2 exceto leitura.

## Loop

`coordinateOnce(deps)` = **observe → decide → dispatch → gate → enqueue**:

1. **observe** — snapshot injetado (jobs/plan via durable-state, monitor,
   running count) + triplo `V2ModelRef` pinado + `baseRef` git.
2. **decide** — `decideNextJobs` (só `queued`/`waiting_deps` com deps em
   `merged`, ordem `mergeOrder`/prioridade, teto `clampMaxParallel` 4–8).
3. **dispatch** — via `InstanceManager`; o mesmo triplo passa intacto
   (sem fallback silencioso — modelo inservível pausa com pergunta).
4. **gate** — revisor futuro; reprovado não entra na fila.
5. **enqueue** — integração, só após o gate.

## Estados explícitos (`classifyOutcome`)

`process-idle` (pane vivo, modelo trabalhando) ≠ `response-terminated`
(turno acabou, pane vivo) ≠ `concluded-no-tests` (pane morto, sem
evidência) ≠ `verified` (testes passaram) ≠ `integrated` (merge feito).

## Guards

`assertDepthAllowed` (anti-recursão `MC_INSTANCE_DEPTH`),
`evaluateFanoutGuard` (fanout ≤ orçamento), `assertNoPush`
(só commits/branches locais), `redactSecrets` (sem segredos em logs).

## Prompts

`buildWorkerPrompt` leva pedido, restrições, decisões, base git e
critérios — sem histórico indiscriminado. Correção do mesmo trabalho
continua a sessão; tarefa distinta abre sessão nova
(`shouldContinueSession`).
