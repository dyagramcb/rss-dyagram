# Rss Dyagram: instruções para o Codex

## Contexto obrigatório

- Este repositório contém o Rss Dyagram, um leitor RSS/PWA publicado em `https://rss-dyagram.netlify.app/`.
- Antes de alterar código, lê `docs/CODEX_HANDOFF.md` e, quando o trabalho envolver a pesquisa semanal, lê também `docs/WEEKLY_PREMIERES_AUTOMATION.md`.
- O repositório canónico é `https://github.com/dyagramcb/rss-dyagram.git`; o branch de produção é `main`.
- A Netlify publica automaticamente `main`, usando `public` como diretório de publicação e `netlify/functions` para as funções.
- Nunca coloques passwords, tokens, chaves ou cookies no repositório, em prompts, logs, commits ou respostas. Usa apenas os segredos do ambiente cloud.

## Produto

- Mantém a interface em português europeu, compacta, responsiva e sem deslocação horizontal no telemóvel.
- No computador, a barra lateral dos feeds permanece fixa; só a lista de notícias deve fazer scroll vertical.
- Os grupos aparecem recolhidos por defeito. Selecionar um grupo filtra os artigos para as fontes desse grupo sem esconder os títulos dos outros grupos.
- As contagens de não lidos são por feed e devem refletir os artigos realmente ainda não lidos.
- O leitor permite selecionar e copiar texto, traduzir manualmente para português, voltar por deslize lateral e guardar para ler mais tarde.
- Não voltar a mostrar cartões de gostos, partilhas ou comentários, valores `n/d`, ferramentas removidas, publicidade extraída do artigo ou apelos premium.
- O widget Android mostra até 50 notícias numa lista vertical deslocável e o botão de atualização deve sincronizar as fontes antes de substituir o conteúdo.

## Arquitetura e alterações

- `server.js` contém o servidor local e a maior parte da lógica partilhada de feeds, cache, extração, tradução e definições.
- `netlify/functions/api.js` adapta a lógica para os endpoints da Netlify.
- `netlify/functions/sync-feeds.js` executa sincronização em segundo plano.
- `public/app.js`, `public/styles.css` e `public/index.html` implementam a aplicação web.
- `public/sw.js` e `public/manifest.webmanifest` implementam a PWA.
- `android-widget/` contém a aplicação/widget Android em Kotlin com Jetpack Glance.
- `public/estreias.xml` contém um único item com o resumo semanal de cinema e streaming.
- Conserva os padrões existentes e mantém as alterações pequenas. Não introduzas frameworks de frontend sem necessidade.

## Validação

- Instala dependências com `npm ci`.
- Executa sempre `npm run build` depois de alterar JavaScript.
- Executa `npm test` para verificar o arranque, definições, cache e widget num diretório temporário isolado, sem credenciais nem pedidos a produção.
- Para preparar o ambiente cloud, usa `bash scripts/codex-setup.sh`.
- Para `public/estreias.xml`, executa também `xmllint --noout public/estreias.xml` quando `xmllint` estiver disponível.
- Verifica `git diff --check` antes do commit.
- Para alterações visuais, testa pelo menos desktop e telemóvel e confirma que não existe overflow horizontal.
- Para alterações de produção, confirma o commit em `origin/main`, espera pelo auto-deploy e verifica a funcionalidade em `https://rss-dyagram.netlify.app/` com um parâmetro de cache novo.

## Publicação

- Prefere o auto-deploy do GitHub para poupar créditos Netlify.
- Não faças deploy manual se o auto-deploy estiver operacional.
- Depois de atualizar `public/estreias.xml`, força a cache com `POST /api/refresh?url=https%3A%2F%2Frss-dyagram.netlify.app%2Festreias.xml&force=1`.
- Não apagues feeds, grupos ou dados partilhados sem um pedido explícito do utilizador.
