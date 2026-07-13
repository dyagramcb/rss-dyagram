const { getStore } = require("@netlify/blobs");
const api = require("../../server");

api.setSettingsStoreFactory(() => getStore("rss-dyagram"));

const {
  buildWidgetPayload,
  discoverFeed,
  fetchArticle,
  fetchCachedFeed,
  fetchFeed,
  fetchImage,
  readCachedNews,
  readSharedSettings,
  refreshCachedFeeds,
  translateToPortuguese,
  writeSharedSettings
} = api;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  const pathname = apiPath(event);
  const params = queryParams(event);

  if (pathname === "/api/settings") {
    if (event.httpMethod === "GET") {
      try {
        return json(200, await readSharedSettings());
      } catch (error) {
        return json(500, { error: error.message || "Não foi possível ler a configuração." });
      }
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Usa POST para gravar a configuração." });
    }

    try {
      return json(200, await writeSharedSettings(JSON.parse(eventBody(event) || "{}")));
    } catch (error) {
      return json(400, { error: error.message || "Não foi possível gravar a configuração." });
    }
  }

  if (pathname === "/api/rss") {
    try {
      const feedUrl = assertHttpUrl(params.get("url"), "Indica um URL RSS válido.");
      const feed = await fetchCachedFeed(feedUrl, {
        force: params.get("force") === "1"
      });
      return response(200, feed.body, feed.contentType, cacheHeaders(300));
    } catch (error) {
      return json(502, { error: error.message || "Não foi possível ler o RSS." });
    }
  }

  if (pathname === "/api/news") {
    try {
      return json(200, await readCachedNews({
        url: params.get("url") || "",
        group: params.get("group") || ""
      }), cacheHeaders(60));
    } catch (error) {
      return json(500, { error: error.message || "Não foi possível ler a cache de notícias." });
    }
  }

  if (["/api/widget", "/api/widget.json"].includes(pathname)) {
    try {
      return json(200, await buildWidgetPayload(), widgetCacheHeaders());
    } catch (error) {
      return json(500, { error: error.message || "Não foi possível preparar o widget." });
    }
  }

  if (pathname === "/api/refresh") {
    try {
      return json(200, await refreshCachedFeeds({
        url: params.get("url") || "",
        group: params.get("group") || "",
        force: params.get("force") === "1"
      }));
    } catch (error) {
      return json(500, { error: error.message || "Não foi possível atualizar a cache." });
    }
  }

  if (pathname === "/api/discover") {
    try {
      const siteUrl = assertHttpUrl(params.get("url"), "Indica um URL válido.");
      const feed = await discoverFeed(siteUrl);
      return json(200, {
        url: feed.url,
        title: feed.title,
        discovered: feed.discovered
      });
    } catch (error) {
      return json(502, { error: error.message || "Não foi possível encontrar RSS neste site." });
    }
  }

  if (pathname === "/api/article") {
    try {
      const articleUrl = assertHttpUrl(params.get("url"), "Indica um URL de notícia válido.");
      return json(200, await fetchArticle(articleUrl));
    } catch (error) {
      return json(502, { error: error.message || "Não foi possível ler a notícia." });
    }
  }

  if (pathname === "/api/translate") {
    if (event.httpMethod === "GET") {
      try {
        return json(200, await translateToPortuguese({
          title: params.get("title") || "",
          text: params.get("text") || ""
        }));
      } catch (error) {
        return json(502, { error: error.message || "Não foi possível traduzir." });
      }
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Usa POST para traduzir." });
    }

    try {
      const payload = JSON.parse(eventBody(event) || "{}");
      return json(200, await translateToPortuguese({
        title: payload.title,
        text: payload.text
      }));
    } catch (error) {
      return json(502, { error: error.message || "Não foi possível traduzir." });
    }
  }

  if (pathname === "/api/image") {
    try {
      const imageUrl = assertHttpUrl(params.get("url"), "Indica um URL de imagem válido.");
      const image = await fetchImage(imageUrl);
      return binary(200, image.body, image.contentType);
    } catch (error) {
      return json(502, { error: error.message || "Não foi possível carregar a imagem." });
    }
  }

  return json(404, { error: "Endpoint não encontrado." });
};

function apiPath(event) {
  const rawPath = new URL(event.rawUrl || `https://local${event.path}`).pathname;
  const functionPath = rawPath.replace(/^\/\.netlify\/functions\/api/, "");

  if (functionPath.startsWith("/api/")) {
    return functionPath;
  }

  return `/api${functionPath.startsWith("/") ? "" : "/"}${functionPath}`;
}

function queryParams(event) {
  if (event.rawUrl) {
    return new URL(event.rawUrl).searchParams;
  }

  const params = new URLSearchParams();
  Object.entries(event.queryStringParameters || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
      return;
    }

    if (value !== undefined && value !== null) {
      params.set(key, value);
    }
  });
  return params;
}

function eventBody(event) {
  if (!event.body) {
    return "";
  }

  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

function assertHttpUrl(value, message) {
  try {
    const parsed = new URL(value || "");
    if (["http:", "https:"].includes(parsed.protocol)) {
      return parsed.toString();
    }
  } catch {
    // Return the validation message below.
  }

  throw new Error(message);
}

function json(statusCode, payload, headers = {}) {
  return response(statusCode, JSON.stringify(payload), "application/json; charset=utf-8", headers);
}

function binary(statusCode, body, contentType) {
  return {
    statusCode,
    isBase64Encoded: true,
    headers: {
      "Cache-Control": "public, max-age=900",
      "Content-Type": contentType || "application/octet-stream"
    },
    body: Buffer.from(body).toString("base64")
  };
}

function response(statusCode, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      ...headers
    },
    body
  };
}

function cacheHeaders(maxAge) {
  return {
    "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
    "Netlify-CDN-Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=3600, durable`
  };
}

function widgetCacheHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=7200",
    "Netlify-CDN-Cache-Control": "public, max-age=3600, stale-while-revalidate=86400, durable"
  };
}
