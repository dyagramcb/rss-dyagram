# Automação semanal de estreias

## Horário

- Frequência: semanal.
- Dia: domingo.
- Hora: 09:00, fuso Europe/Lisbon.
- Período pesquisado: semana civil anterior, de segunda-feira a domingo.

Calcular as datas em `Europe/Lisbon`: obter a segunda-feira da semana da execução, subtrair sete dias para o início e um dia para o fim. Confirmar por calendário/código que o início é segunda-feira e o fim domingo; não assumir que o dia 1 do mês é segunda-feira. Por exemplo, uma execução em 11 de setembro de 2026 cobre 31 de agosto a 6 de setembro, não 1 a 7 de setembro.

## Objetivo

Pesquisar estreias confirmadas para Portugal, atualizar `public/estreias.xml`, publicar em `main`, aguardar o auto-deploy da Netlify e atualizar a cache central. A execução só está concluída quando o novo `guid` estiver acessível no RSS público.

## Instruções editoriais

- Cobrir filmes em salas portuguesas e filmes, séries, temporadas, documentários ou especiais nas principais plataformas de streaming disponíveis em Portugal.
- Preferir fontes oficiais e editoriais credíveis; cruzar datas quando possível.
- Não inventar informação. Omitir títulos cuja data, género ou sinopse não estejam suficientemente confirmados.
- Manter um único item RSS para a semana pesquisada.
- Escrever uma introdução curta e as secções `Cinema` e `Streaming`.
- Criar um bloco separado por estreia, usando `<h3><strong>Título</strong></h3>`.
- Incluir parágrafos separados para tipo, género, local/plataforma, data em Portugal, sinopse em português com 2 a 4 frases e fontes com links.
- A sinopse deve explicar a premissa narrativa ou documental.
- Terminar no último bloco de estreia, sem notas de método.

## Fluxo técnico

O fluxo abaixo descreve a execução num clone com terminal. A tarefa ChatGPT Work usa o plugin GitHub ligado: lê o SHA atual de `public/estreias.xml` e atualiza apenas esse ficheiro em `main`, com proteção contra alterações concorrentes. Valida o XML antes de publicar e executa as verificações do projeto quando o ambiente disponibilizar o código e as dependências. A confirmação pública e a atualização da cache são obrigatórias nos dois modos.

1. Criar um clone limpo e temporário de `https://github.com/dyagramcb/rss-dyagram.git`.
2. Confirmar que o branch é `main` e está atualizado.
3. Atualizar `public/estreias.xml` com um `guid` no formato `estreias-AAAA-MM-DD-AAAA-MM-DD`.
4. Executar `xmllint --noout public/estreias.xml`, `npm ci`, `npm run build` e `git diff --check`.
5. Fazer commit apenas quando existirem alterações reais.
6. Enviar para `origin/main`, com até três tentativas em erros transitórios de rede.
7. Confirmar que `origin/main` contém o commit.
8. Aguardar o auto-deploy e consultar o RSS público com cache-buster até encontrar o novo `guid`.
9. Não usar deploy manual enquanto o auto-deploy do GitHub funcionar.
10. Forçar a cache central:

```sh
curl -sS -X POST 'https://rss-dyagram.netlify.app/api/refresh?url=https%3A%2F%2Frss-dyagram.netlify.app%2Festreias.xml&force=1'
```

11. Verificar novamente o RSS público e só então reportar sucesso.

## Estado ao transferir

- A automação original existe no Codex desktop com o identificador `publicar-estreias-semanais`.
- Em 11 de setembro de 2026, o modelo local foi atualizado de `gpt-5.4` para `gpt-5.6-terra`, mantendo esforço médio, estado ativo e domingo às 09:00. O modelo anterior já tinha sido retirado; esta correção de configuração não comprova uma nova execução ou publicação.
- O projeto associado foi alinhado com o diretório de execução já utilizado, sem recorrer ao clone divergente. A pesquisa continua a usar o clone temporário indicado no fluxo técnico.
- O clone local antigo ficou divergente no passado; por isso o fluxo deve usar sempre um clone limpo do GitHub.
- A automação conseguiu publicar os commits `4fede64` e `17e0d94`, mas a recorrência local não acompanha automaticamente uma mudança para o browser. Este documento preserva a configuração para recriação no ambiente que passar a executar a tarefa.

## Migração cloud validada em 11 de setembro de 2026

- Ambiente de desenvolvimento `rss-dyagram` no Codex cloud: configuração e manutenção testadas, com build e teste funcional aprovados.
- Tarefa agendada `Publicar estreias semanais (cloud)` no ChatGPT Work: ativa, com domingo como único dia e hora 09:00, Europe/Lisbon.
- O prompt guardado inclui o cálculo explícito da semana, pesquisa web, género, sinopse, parágrafos, atualização exclusiva do RSS pelo GitHub, auto-deploy e POST de atualização da cache.
- O primeiro teste foi interrompido ao indicar datas incorretas. A execução retomada com o intervalo correto publicou o commit `d4cc5418ff48039b5228d7712992ff1d3d030dbc`.
- Foi confirmado independentemente o `guid` `estreias-2026-08-31-2026-09-06` no RSS público e na cache de `/api/news`, com um item, `status: fulfilled`, `stale: false` e sem erro. A cache foi atualizada às `2026-09-11T21:08:05.180Z`.
- `xmllint --noout public/estreias.xml`, `npm run build`, `npm test` e `git diff --check` passaram na verificação local do commit publicado.
- Só após estas confirmações a automação desktop original ficou `PAUSED`. Não foi apagada. Não reativar a original enquanto a cloud estiver ativa, para evitar publicações duplicadas.

O teste manual confirma o fluxo de publicação cloud, não garante que todas as execuções futuras terão sucesso. Consultar o resultado de cada execução; erros de pesquisa, permissões ou publicação devem ser reportados pela tarefa, sem afirmar sucesso apenas com um commit.

Referência de compatibilidade: [Tarefas agendadas e atualização de modelos](https://learn.chatgpt.com/docs/automations).
