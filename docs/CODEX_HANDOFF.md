# Dossiê de continuidade do Rss Dyagram

Atualizado em 11 de setembro de 2026. Este documento é uma síntese sanitizada do desenvolvimento feito no Codex desktop. Não contém passwords, tokens, chaves, cookies ou outros segredos.

## Identificação

- Aplicação: Rss Dyagram
- Descrição: leitor RSS/PWA com grupos, sincronização de fontes, suporte a páginas Facebook, leitura de artigos e widget Android.
- GitHub: `https://github.com/dyagramcb/rss-dyagram`
- Produção: `https://rss-dyagram.netlify.app/`
- Branch de produção: `main`
- Hospedagem: Netlify, com auto-deploy a partir do GitHub.
- Commit observado ao preparar este dossiê: `17e0d94` (`Update weekly premieres feed`).

## Como continuar no Codex cloud

1. Abrir `https://chatgpt.com/codex` com a mesma conta ChatGPT.
2. Ligar o GitHub e autorizar o repositório `dyagramcb/rss-dyagram`.
3. Criar um ambiente cloud para o repositório e selecionar o branch `main`.
4. Definir o comando de configuração como `npm ci`.
5. Ativar acesso de rede apenas aos domínios necessários para a tarefa.
6. Adicionar no gestor de segredos do ambiente apenas as credenciais realmente necessárias. Nunca colar segredos num chat.
7. Começar uma tarefa com: `Lê AGENTS.md e docs/CODEX_HANDOFF.md, confirma o estado de main e continua o desenvolvimento do Rss Dyagram.`

O `AGENTS.md` da raiz é lido automaticamente pelo Codex antes de trabalhar e contém as regras permanentes do projeto.

## Segredos e variáveis

O código não contém valores secretos. As variáveis reconhecidas são:

- `PORT`: porta do servidor local; por defeito é `8080`.
- `RSS_DYAGRAM_SITE_URL`: URL pública da aplicação.
- `RSS_DYAGRAM_PREMIERES_FEED`: URL alternativa para o RSS semanal.
- `RSS_DYAGRAM_BLOBS_SITE_ID`: identificador do site para acesso explícito a Netlify Blobs.
- `RSS_DYAGRAM_BLOBS_TOKEN`: token para acesso explícito a Netlify Blobs.
- `NETLIFY_SITE_ID` ou `SITE_ID`: alternativas usadas pelo cliente de Blobs.
- `NETLIFY_AUTH_TOKEN`: alternativa para autenticação Netlify em execução local.

Em produção, as Netlify Functions obtêm acesso ao armazenamento do site através do contexto da Netlify. No Codex cloud, adiciona apenas os segredos necessários através das definições do ambiente.

### Aviso de segurança

Um token pessoal GitHub foi anteriormente escrito numa conversa de desenvolvimento. Esse token deve ser considerado comprometido, revogado no GitHub e substituído. Não reutilizar nem transportar esse valor. Para o Codex cloud, prefere a ligação GitHub integrada em vez de um PAT copiado para prompts.

## Arquitetura

### Web e servidor

- `server.js`: servidor HTTP local, descoberta e leitura de feeds, páginas Facebook, cache, imagens, extração integral de artigos, limpeza de HTML, tradução e definições partilhadas.
- `public/index.html`: estrutura da aplicação.
- `public/app.js`: estado, grupos, feeds, navegação, leitor, ações e sincronização no cliente.
- `public/styles.css`: layout responsivo e apresentação compacta.
- `public/sw.js`: service worker e estratégia de cache da PWA.
- `public/manifest.webmanifest`: instalação PWA.

### Netlify

- `netlify/functions/api.js`: função principal que expõe `/api/*` e `/widget.json`.
- `netlify/functions/sync-feeds.js`: sincronização em segundo plano.
- `netlify.toml`: publica `public`, configura as funções, o manifesto e os redirects.
- Netlify Blobs, store `rss-dyagram`: guarda definições partilhadas, feeds, grupos e dados necessários à sincronização entre dispositivos.

### Widget Android

- Código em `android-widget/`.
- Kotlin, Gradle e Jetpack Glance.
- Lê `https://rss-dyagram.netlify.app/widget.json`.
- Guarda a última resposta localmente.
- Atualiza periodicamente quando existe rede e permite atualização manual.
- Mostra até 50 notícias numa lista com scroll, incluindo fonte, grupo, data e resumo.
- O workflow `.github/workflows/android-widget.yml` compila o APK de teste quando o widget muda.

## Comportamento consolidado

- Interface fluida a toda a largura, sem conteúdo a flutuar nem scroll horizontal em telemóvel.
- Tipografia e ícones compactos, incluindo topo, menu lateral e rodapé do leitor.
- Barra lateral fixa em desktop durante o scroll vertical das notícias.
- Grupos recolhidos por defeito e expansíveis para mostrar todas as fontes e contagens por ler.
- Todos os grupos com feeds continuam visíveis, mesmo quando outro grupo está selecionado.
- Selecionar um grupo mostra apenas artigos pertencentes às fontes desse grupo.
- É possível criar, renomear e organizar grupos; adicionar, mover e apagar feeds.
- O seletor de grupo também está disponível ao adicionar feeds em telemóvel.
- URLs de sites podem ser usadas para descobrir RSS/Atom; páginas Facebook usam o mecanismo de adaptação existente.
- A atualização tenta todas as fontes, reutiliza cache para reduzir custo e faz trabalho lento em segundo plano.
- Datas desconhecidas não são apresentadas como `agora`.
- Estado de leitura e contagens de não lidos são isolados por feed e normalizam URLs equivalentes.
- Imagens são extraídas e servidas através do mecanismo de imagem/cache existente.
- O leitor tenta obter o corpo integral do artigo e remove scripts de publicidade, menus de partilha, apelos premium e fragmentos HTML mal codificados.
- A tradução é opcional e acionada manualmente; não traduz automaticamente os artigos.
- O leitor permite selecionar e copiar texto, deslizar lateralmente para voltar e guardar artigos para leitura posterior.
- Os cartões de gostos, partilhas e comentários foram removidos, mesmo quando existiam valores numéricos.
- A antiga fonte automática `Capital Portuguesa da Cultura` foi retirada.

## Cache e sincronização

- Cache geral de API: 5 minutos.
- Cache normal de feeds: 30 minutos.
- Cache de páginas Facebook: 3 horas.
- A aplicação usa cache central para abrir rapidamente e atualiza em segundo plano.
- O refresh manual deve forçar a verificação de todas as fontes sem descartar de imediato uma cache válida se a origem falhar.
- Facebook é uma integração frágil porque não existe uma API pública anónima estável para todas as páginas; alterações no HTML ou bloqueios podem exigir ajustes.
- O objetivo de desenho é minimizar invocações Netlify: um refresh central, cache partilhada e auto-deploy pelo GitHub.

## RSS semanal de estreias

- Ficheiro: `public/estreias.xml`.
- Grupo de sistema: `Cinema e séries`.
- O RSS contém exatamente um item, substituído semanalmente.
- O item deve cobrir a semana civil anterior em Portugal, com secções `Cinema` e `Streaming`.
- Cada título deve ter tipo, género, local/plataforma, data portuguesa, sinopse de 2 a 4 frases e fontes ligadas.
- Não incluir títulos sem confirmação suficiente nem acrescentar notas de método no fim.
- Especificação completa em `docs/WEEKLY_PREMIERES_AUTOMATION.md`.

## Histórico funcional resumido

1. Foi criado o leitor RSS/PWA e a publicação Netlify.
2. Adicionou-se persistência partilhada em Netlify Blobs e sincronização de feeds e grupos.
3. Foram implementadas páginas Facebook, descoberta automática de RSS e preservação dos nomes das fontes.
4. Foram adicionadas gestão de grupos, mover e apagar feeds, contagens de não lidos e filtros por grupo.
5. O design foi progressivamente compactado e adaptado ao telemóvel, eliminando overflow horizontal e controlos dispensáveis.
6. A sincronização passou a usar cache central, rotação de fontes com erro, atualização em segundo plano e tolerância a RSS inválido.
7. O leitor passou a extrair mais conteúdo, limpar publicidade/menus, corrigir entidades HTML, traduzir por opção e permitir seleção de texto.
8. Foi criado o RSS semanal de cinema e streaming, com sinopses, géneros e publicação automática.
9. Foi criado o widget Android, depois expandido para 50 notícias com scroll e refresh incremental.

O histórico Git completo preserva a sequência exata das alterações e as mensagens de commit.

## Validação e execução

```sh
npm ci
npm run build
npm start
```

A aplicação local fica em `http://localhost:8080/`.

Para o RSS semanal:

```sh
xmllint --noout public/estreias.xml
```

Para o widget Android, abrir `android-widget/` no Android Studio ou executar o build Gradle com Java 17.

## Publicação e verificação

1. Trabalhar a partir do `origin/main` atual.
2. Executar as validações adequadas.
3. Fazer commit e push para `main` apenas quando a alteração estiver pronta para produção.
4. Aguardar o auto-deploy da Netlify.
5. Verificar `https://rss-dyagram.netlify.app/?v=<identificador-novo>`.
6. Se o RSS semanal mudou, verificar o novo `guid` em `https://rss-dyagram.netlify.app/estreias.xml` e forçar a cache pela API.

## Pontos a confirmar em futuras tarefas

- Antes de assumir que uma correção não está online, comparar `HEAD`, `origin/main` e o deploy atual da Netlify.
- Confirmar se o service worker está a servir uma versão antiga; usar cache-buster e, quando necessário, atualizar a versão da cache.
- Não usar o antigo clone local divergente como fonte de verdade. O GitHub é canónico.
- Proteger a compatibilidade entre servidor local e Netlify Functions, porque ambos reutilizam `server.js`.
- Verificar sempre desktop e telemóvel quando se altera CSS ou navegação.

