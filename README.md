# Rss Dyagram

Leitor RSS/PWA com grupos, feeds sincronizados e suporte para páginas de Facebook.

## Desenvolvimento local

```sh
npm install
npm start
```

A app fica disponível em `http://localhost:8080/`.

## Netlify

O site publica a pasta `public` e usa a função `netlify/functions/api.js` para os endpoints `/api/*`.

## Widget Android

O projeto nativo está em `android-widget/`. O widget usa Jetpack Glance, lê o resumo
partilhado em `https://rss-dyagram.netlify.app/widget.json` e atualiza de hora a hora
apenas quando existe ligação à Internet. A última resposta fica guardada no dispositivo.

Para compilar no Android Studio, abre a pasta `android-widget`, espera pela sincronização
do Gradle e executa a configuração `app`. Depois de instalar a aplicação no Android:

1. Mantém premida uma zona vazia do ecrã principal.
2. Abre `Widgets` e procura `Rss Dyagram`.
3. Arrasta o widget para o ecrã e ajusta o tamanho.

O workflow `Android widget` também compila automaticamente um APK de teste no GitHub
sempre que esta pasta é alterada.
