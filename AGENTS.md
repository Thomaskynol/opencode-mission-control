# AGENTS.md — OpenCode Mission Control

Instruções para agentes que trabalham **neste repositório**, o fork do
`opencode-mission-control`. Preserve o nome OpenCode; não o substitua por outro
produto ao descrever ou implementar a integração.

Instruções explícitas do usuário e regras de prioridade superior prevalecem
sobre este arquivo. Uma solicitação específica de refatoração ou mudança ampla
define seu próprio escopo; as recomendações de proporcionalidade não devem ser
usadas para recusar trabalho que o usuário já autorizou.

## Objetivo e contexto

O produto pretende coordenar instâncias completas do OpenCode, com sua
configuração, agentes, skills e plugins. O fluxo desejado recebe um pedido e
contexto, organiza tarefas e dependências, acompanha workers, revisa e corrige
entregas, integra mudanças localmente na branch de destino e produz um relatório
confiável. Deve permitir trabalhar com 4–8 workers quando o ambiente e a
missão comportarem esse paralelismo. Qualidade tem prioridade sobre ocupação.

Isso descreve **o objetivo**, não uma garantia de que todas as capacidades já
estejam implementadas ou comprovadas. Antes de afirmar o estado atual, confira
o código, os testes, as versões instaladas e as evidências pertinentes. O fork e
o OpenCode local podem ter mudado desde a última revisão.

O pacote revisado na rodada `3401131` continha um plugin e uma CLI em
TypeScript/Bun. Consulte os arquivos atuais (mapa conferido contra
`ls src/lib`, `ls src/orchestrator-cli` e `ls docs` na base `a56a73a` —
todos os paths abaixo existem nessa base):

- `src/index.ts`, `src/tools/` e `src/hooks/`: entrada do plugin, ferramentas e
  hooks do OpenCode.
- `src/lib/orchestrator.ts`, `src/lib/coordinator.ts`, `src/lib/monitor.ts` e
  `src/lib/instance-manager.ts`: coordenação, monitoramento e instâncias. Confirme os
  chamadores reais; a existência de uma classe não prova seu uso no fluxo.
- `src/lib/auto-plan.ts`, `src/lib/reviewer.ts`, `src/lib/merge-train.ts`,
  `src/lib/integration.ts` e `src/lib/reports.ts`: planejamento, revisão,
  integração e relatórios. (`src/lib/opencode-reviewer.ts` também existe:
  revisor OpenCode complementar; confira qual o caminho público usa.)
- `src/lib/plan-state.ts`, `src/lib/job-state.ts`, `src/lib/durable-state.ts`,
  `src/lib/file-lock.ts`, `src/lib/sdk-client.ts`, `src/lib/tmux.ts` e
  `src/lib/worktree.ts`: estado e recursos de execução.
- `src/orchestrator-cli/`: interface de linha de comando.
- `tests/`, `README.md`, `docs/USER-GUIDE.md`, `docs/matrix-final.md`,
  `docs/continuidade-revisao-R01-R09.md` e `MANUAL_TEST_PLAN.md`: testes,
  operação e histórico. Confira a versão e a data das afirmações: documentos
  antigos, demos e contagens de testes não provam o comportamento do HEAD.

## Como iniciar uma tarefa

1. Leia o pedido, as instruções aplicáveis, o código e os testes relevantes.
   Confira `git status`, branch, HEAD e worktrees antes de alterar arquivos.
   Preserve mudanças rastreadas e não rastreadas do usuário.
2. Se uma sessão for nova, recupere o contexto dos documentos do repositório e
   dos arquivos fornecidos. Verifique em modo de leitura se há missões, workers
   ou condutores em andamento antes de iniciar uma execução concorrente.
3. Para trabalho não trivial, identifique comportamento esperado, caminho
   público, restrições, riscos e evidência necessária. Mantenha um plano de
   continuidade nos arquivos existentes quando isso ajudar a retomar o trabalho;
   atualize-o conforme os resultados. Não interrompa a tarefa apenas para
   apresentar o plano, salvo se uma decisão realmente depender do usuário.
4. Investigue a causa de um defeito antes de corrigi-lo. Compare a evidência
   com o estado atual; um relatório de outra revisão é uma hipótese e uma fonte
   de reprodução, não prova automática sobre um HEAD diferente.
5. Faça incrementos coerentes e completos. Preserve os contratos existentes,
   salvo quando o pedido ou um defeito comprovado exigir mudança; nesses casos,
   registre a mudança e verifique a compatibilidade pertinente.

## Skills e ferramentas de trabalho

- Descubra e leia as instruções das skills **Superpowers** relevantes disponíveis
  na instalação. Aplique as adequadas ao trabalho: planejamento para mudanças
  complexas, investigação sistemática para bugs, desenvolvimento orientado por
  testes quando útil e verificação antes de declarar conclusão.
- Use **Planning with Files**, quando disponível e apropriado, para trabalho
  longo ou com várias dependências: mantenha objetivo, decisões, progresso e
  evidências em arquivos recuperáveis, sem criar planos duplicados a cada turno.
- Siga o mecanismo real de descoberta e uso de skills do ambiente; não invente
  comandos ou afirme que uma skill foi usada apenas por citá-la. Se uma skill
  necessária não estiver disponível, informe a ausência e use um procedimento
  equivalente quando possível, sem fingir que ela foi carregada.
- Para revisão de mudanças centrais ou concorrentes, use uma revisão com
  contexto separado quando disponível e autorizada. O revisor deve examinar
  requisitos, diff e evidências e procurar falhas; “sem achados” sozinho não
  substitui os testes. O mesmo modelo em papéis diferentes ainda pode errar.

## Qualidade de implementação

- Prefira nomes claros, responsabilidades focadas, dependências explícitas e
  fluxo simples. Mantenha código de ferramentas em `src/tools/` e lógica
  compartilhada em `src/lib/` quando essa divisão continuar adequada.
- Use tipos TypeScript e validação de dados em fronteiras. Evite `as any`,
  `@ts-ignore`, abstrações especulativas, duplicação que atrapalha manutenção e
  tratamento de erro silencioso. Uma exceção justificada deve ser localizada e
  ter seu risco claro; não esconda falhas para fazer a suíte passar.
- Não confunda dados solicitados, observados, inferidos e desconhecidos.
  Propague falhas relevantes; falha de persistência, revisão ou integração não
  deve gerar mensagem de sucesso. Documente incertezas sem inventar resultados.
- Trate mudanças no OpenCode, no SDK e em plugins como dependentes da versão
  real. Confira o executável e a API efetivamente usados. Não suponha que um
  contrato provado em 2.1.4 seja igual ao de 2.2.5 ou ao de outra versão.
- Mantenha documentação e comandos afetados coerentes com o comportamento
  verificado. Atualize informações operacionais que ficaram desatualizadas,
  distinguindo fatos atuais de histórico e intenção de produto.

## Regras para evitar falsos positivos

**Teste verde é evidência apenas dos cenários e condições que ele verificou.**
Número de testes, ausência de erro, nome de função ou relatório de um worker
não demonstram por si só que um requisito foi atendido.

Para cada comportamento central alterado:

1. Defina antes da implementação o comportamento esperado, o caminho público e
   os resultados que devem ser aceitos ou rejeitados. Identifique o nível de
   teste necessário: componente, integração, processo real ou uso completo.
2. Verifique que os testes executados realmente alcançam a implementação e
   conferem o comportamento. Em fixtures isoladas, quando fizer sentido,
   demonstre que um defeito plausível é rejeitado e que um caso correto passa.
   Para bugs, mostre a regressão antes/depois quando for viável.
3. Cubra limites, entradas e falhas relevantes à mudança. Use ao menos um caso
   diferente de uma fixture anterior quando houver risco de ajustar a solução
   apenas ao exemplo. Não modifique testes para mascarar falhas nem troque uma
   checagem de comportamento por correspondência de texto conveniente.
4. Teste o caminho que o usuário realmente usa e a integração entre componentes
   quando o risco exigir. Helpers, mocks, scripts manuais e chamadas internas
   têm valor, mas não comprovam, sozinhos, a CLI, o plugin ou workers reais.
5. Vincule evidência ao repositório, branch, candidato e comando efetivamente
   avaliados. Conteúdo igual antes/depois não prova que ele permaneceu imutável
   durante o teste. Não descarte fonte versionada ou entrada relevante apenas
   porque está em `dist/`, `build/` ou outra pasta de artefatos.
6. Preserve o exit code real, inclusive em scripts e pipelines. Não esconda
   falhas com `| tail`, `; echo`, retries ou `exit 0`. Ao registrar logs,
   capture o status do comando original e não apenas o da última operação.

Para trabalho complexo, mantenha uma matriz curta por requisito:
`requisito | estado | caminho/comando | resultado/evidência | limitação`.
Estados: **implementado e validado**, **implementado com validação
insuficiente**, **bloqueado** ou **não implementado**. Uma afirmação só pode
usar o nível que a evidência alcança. Não use `Verified` para conclusão sem
revisão e evidência suficientes; lacunas e perguntas abertas devem aparecer.

## Pontos de atenção deste produto

As revisões anteriores encontraram falhas recorrentes. Trate-as como riscos a
verificar no código atual, não como uma lista permanente de bugs abertos:

- **Revisão funcional:** uma soma errada passou com teste apenas de lista
  vazia e gerou `merged`/`Verified`. A presença de `assert`, chamada, valores
  ou uso de um parâmetro não prova que a implementação satisfaz o requisito.
  A revisão deve considerar critérios, código e evidências, inclusive casos
  que a suíte não cobre. Se o contrato exigir revisor OpenCode, prove seu uso
  no caminho público; uma interface ou hook reservado não basta.
- **Coordenador e retomada:** PID vivo e estado persistido não provam que há um
  condutor responsável e progredindo. Verifique posse exclusiva, handoff,
  reivindicação atômica, falhas entre etapas, recuperação e ausência de
  despachos duplicados. Evite encerrar tarefa saudável apenas por ser longa;
  tempos de espera e detecção de progresso devem ser apropriados e observáveis.
- **Isolamento e posse:** identifique qual execução criou cada processo, sessão,
  porta, worktree e arquivo. Uma falha antes de criar o recurso não autoriza
  removê-lo. Nomes parecidos ou um prefixo, por si, não comprovam posse.
- **Modelo e perfil:** mantenha separados modelo solicitado e observado,
  incluindo provider e variant quando aplicável. Ausência ou divergência não é
  confirmação. Valide também agente, skills, plugins e modos pertinentes pelo
  caminho usado, sem supor que estar listado em configuração significa estar
  carregado ou ativo.
- **Fluxo e relatório:** confira registro do worker antes do envio do prompt,
  recebimento de eventos, perguntas, pausa/resume, revisão, correção, merge e
  destino local. Não trate estado `idle`, resumo de agente ou teste global
  irrelevante como prova de conclusão funcional. Registre contribuições e
  pendências reais, sem promover dados ausentes a sucesso.

Quando alterar um desses contratos, use testes direcionados e inclua os casos
de falha, retomada ou concorrência pertinentes. Não invente uma garantia total
de qualidade a partir de heurísticas ou de uma revisão por modelo.

## Build, testes e ambiente

Confira `package.json` e o ambiente atual antes de executar. No snapshot
revisado, os comandos eram:

```bash
bun run build
bun test
bun src/orchestrator-cli/index.ts help
opencode --version
```

(Observado neste lane em 2026-11-03: `opencode v2.2.5`, `bun 1.3.14` —
reconfira com `opencode --version` antes de afirmar o estado atual.)

Escolha verificações proporcionais ao risco e registre comando, resultado e
escopo. Execute testes direcionados durante a implementação e build/suíte
pertinentes no estado final; mudanças somente de documentação não exigem
repetições sem motivo. Uma falha só é pré-existente ou ambiental se houver
evidência adequada, como comparação reproduzível com uma base identificada.

Para comportamento dependente de OpenCode, tmux, Git, monitor ou processos,
use demonstrações reais isoladas quando necessário e autorizado. Mocks devem
ser identificados. Use repositórios descartáveis, estado e portas exclusivos;
verifique que não há colisões. Os testes existentes têm recursos como
`MC_XDG_DATA_DIR` e `TEST_LIVE=1`: confira sua aplicação real antes de confiar
neles. Não declare que toda a suíte está isolada apenas pela existência de um
helper. Registre intervenções, trabalhadores realmente simultâneos, versão e
modelo observados. Se quatro ou oito workers não puderem ser exercitados,
registre o limite sem extrapolar resultados de um ou dois.

`MANUAL_TEST_PLAN.md` pode orientar cenários, mas leia suas operações antes de
executá-las. Não execute sequências de limpeza ampla, resets ou remoções sobre
sessões, branches, worktrees ou estados existentes. Limpe somente recursos
descartáveis cuja criação e posse pela execução estejam confirmadas. Para
testes em navegador, use um perfil e processos isolados; preserve o navegador e
as sessões pessoais do usuário.

O modelo já selecionado e autorizado pode ser usado nos testes necessários;
não peça confirmação repetida para esse uso. Não troque de modelo nem ative um
novo serviço pago sem autorização. Use as permissões e o perfil do usuário
conforme configurados, sem alterar silenciosamente o ambiente global.

## Operação do fork (verificado na base a56a73a)

- **Plano manual (`MANUAL_TEST_PLAN.md`):** o fluxo operacional E2E vive
  nesse arquivo. Para validação rápida após mudanças, rode primeiro a seção
  **Quick Smoke Test** (14 passos); use a sequência **Nuclear Cleanup** antes
  e depois de testes manuais para não deixar tmux sessions, worktrees,
  branches e arquivos de estado. Regras do plano: prefixo `tmc-` nos nomes de
  teste, nenhum fluxo de push remoto durante testes (`mc_pr` é menção
  estrutural apenas) e resets por SHA explícito.
- **CI (`.github/workflows/`):** `ci.yml` roda `bun run build` + `bun test`
  em PRs e pushes em `main`; `conventional-commits.yml` valida o título do PR;
  `codeql.yml` faz análise estática de TypeScript (PRs, pushes em `main` e
  semanal). **Publish removido neste fork:** não existe
  `.github/workflows/publish.yml`; pushes em `main` rodam só CI, nunca
  publicam no npm.
- **Branch & merge:** convenção do fork — mudanças via PR (template em
  `.github/pull_request_template.md`), merges só **squash** ou **rebase**,
  sem commit de merge. Não faça push, PR, deploy ou publicação sem instrução
  explícita do usuário.
- **Release:** saída npm é só `dist/` (`package.json -> files`). Sem caminho
  automatizado de release neste fork (apenas `bunx semantic-release` manual
  com token explícito, se um dia for necessário). Nenhum token de publish
  configurado; não adicione um sem instrução explícita. Use Conventional
  Commits (`feat:`, `fix:`, `perf:`, `chore:`).
- **Renovate (`renovate.json`):** atualizações de dependências via app
  GitHub Renovate — agrupa non-major de npm, PRs separados para majors,
  auto-merge de minor/patch. Prefixos `chore(deps):` e `ci(deps):`.

## Git, publicação e preservação

- A branch de destino de cada missão deve ser explícita e comprovada antes da
  integração. Preserve alterações e estados do usuário durante toda a execução.
- Commits e merges locais devem seguir a autorização da tarefa e as instruções
  vigentes. Não invente identidade Git. Não faça push, PR, deploy, publicação
  ou liberação de pacote sem instrução explícita do usuário.
- Não use `git reset --hard`, `git clean`, restaurações destrutivas ou encerramento
  indiscriminado para “limpar” o ambiente. Inspecione antes de qualquer operação
  que afete recursos existentes.
- Proteja credenciais, tokens, senhas e dados de projetos. Use dados sintéticos
  em testes; evite incluí-los em logs, commits, exemplos ou pacotes de revisão.
- Quando gerar manifesto ou pacote para revisão, identifique HEAD, estado e
  arquivos efetivamente incluídos. Confira os hashes contra o snapshot entregue;
  não trate hash de um índice antigo como prova dos bytes finais.

## Entrega e continuidade

Responda em português de forma clara. Informe o que mudou e por quê; quais
comandos e cenários foram executados; resultados, nível e limites da evidência;
decisões e intervenções; problemas restantes; e como executar ou conferir o
resultado quando relevante. Diferencie falha, não executado e desconhecido.

Para trabalho extenso, mantenha o relatório completo em `.md` no projeto ou em
local informado e forneça o caminho absoluto. Se for necessário um pacote para
revisão externa, informe conteúdo e SHA-256 sem incluir segredos. Não crie
pacotes ou relatórios enormes como substituto para corrigir e validar o produto.

Priorize o pedido atual. Uma mudança pequena pode ser resolvida diretamente;
uma alteração crítica exige evidência proporcional. Consulte o usuário quando
uma decisão essencial, credencial, autorização ou informação realmente faltar.
