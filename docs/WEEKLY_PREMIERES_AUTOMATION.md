# Automação semanal de estreias

## Horário

- Frequência: semanal.
- Dia: domingo.
- Hora: 09:00, fuso Europe/Lisbon.
- Período pesquisado: semana civil anterior, de segunda-feira a domingo.

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
- O clone local antigo ficou divergente no passado; por isso o fluxo deve usar sempre um clone limpo do GitHub.
- A automação conseguiu publicar os commits `4fede64` e `17e0d94`, mas a recorrência local não acompanha automaticamente uma mudança para o browser. Este documento preserva a configuração para recriação no ambiente que passar a executar a tarefa.

