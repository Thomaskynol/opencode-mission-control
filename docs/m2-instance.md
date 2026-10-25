# M2 — controle de instância real com equivalência de perfil

Scope nomeado: `m2-instance`. Writer única desta lane: `src/lib/instance-manager.ts`,
extensão aditiva de `src/lib/sdk-client.ts`, testes `tests/lib/instance-manager.test.ts`
+ `tests/lib/sdk-client-v2.test.ts`, este doc.

## Por que fetch próprio em vez do SDK instalado

O `@opencode-ai/sdk@1.1.53` do repo mira paths sem prefixo (`POST /session`),
que o `serve` 2.1.4 não serve (405/HTML). O 2.1.4 real expõe tudo sob `/api`
(verificado contra `/openapi.json` do binário 2.1.4). A seção v2 de
`src/lib/sdk-client.ts` fala esse surface verificado via fetch, sem mudar
nada do código legado (usado por orchestrator/merge-train/job-comms/monitor).

## Contratos reais usados (openapi 2.1.4, prefixo `/api`)

- `POST /session` body `{id?, parentID?, title?, agent?, model:{id, providerID, variant?},
  location:{directory}, permissions?}` → `{data: Session.Info}`
- `GET /session/{id}` → `{data: Session.Info}` com `id, projectID, agent?,
  model?, permissions?, location:{directory}`
- `GET /session/active`, `POST .../prompt {text}`, `POST .../generate {prompt}`,
  `POST .../interrupt[?resume]`, `POST .../background`, `POST .../move {directory}`,
  `POST .../compact {}`, `GET .../message[?limit]`, `GET .../message/{id}`,
  `POST .../fork {before?}`, `POST /experimental/session/{id}/wait`,
  `GET /experimental/session/{id}/log` (SSE, retornado como texto cru)

Respostas sem envelope (`interrupt` → `{"interrupted":bool}`; `wait/background/move`
→ 204 vazio) são repassadas cruas, não desembrulhadas.

## Equivalência de perfil (`src/lib/instance-manager.ts`)

`assertProfileEquivalence(expected, actual)` compara triplo exato
`providerID/id/variant` + `agent` + `location.directory` (ignora `/` final) +
`projectID` e `permissions` (só quando o perfil os fixa; `variant` só quando
pinado — o servidor preenche `"default"` quando ausente). Qualquer deriva →
`launch()` retorna `{status:'paused', mismatches, question}` **antes de qualquer
trabalho**, nunca continua degradado.

## Sem fallback silencioso

`resolveModelFallback()` sempre retorna `{action:'pause', question}` com modelo
pedido + alternativas; `swappedModel` é sempre `undefined`. A troca só acontece
por resposta explícita do operador.

## Anti-recursão

`MC_INSTANCE_DEPTH` (default max 1): `launch()` lança se `depth >= max` —
worker nunca inicia outra execução completa do produto.

## Perfil real

O manager não reimplementa config/plugins/skills/agentes nem toca config
global: apenas fixa o perfil recebido no `session.create` e o reverifica no
`session.get`. OMO continua opcional e fora deste módulo.

## Evidência real (serve 2.1.4 local, porta 17891)

- `session.create` com `{agent:'build', model:{anthropic/claude-sonnet-4-20250514},
  location:{directory}, permissions}` → `session.get` mostra o mesmo
  triplo/agent/location/projectID → `launch()` = `{equivalent:true, status:'active'}`.
- Perfil com `projectID` divergente → `{equivalent:false, status:'paused'}`
  com `question` ao operador.
- `pause()` = `interrupt`; `resume()` = `wait` (idle).
