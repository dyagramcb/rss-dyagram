const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let getBlobStore = null;
let settingsStoreFactory = null;

try {
  ({ getStore: getBlobStore } = require("@netlify/blobs"));
} catch {
  // The local server falls back to the filesystem when Netlify Blobs is unavailable.
}

const port = Number(process.env.PORT || 8080);
const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const settingsPath = path.join(dataDir, "rss-dyagram-settings.json");
const feedCacheDir = path.join(dataDir, "feed-cache");
const cache = new Map();
const cacheTtlMs = 5 * 60 * 1000;
const feedTimeoutMs = 8 * 1000;
const facebookFeedTimeoutMs = 8 * 1000;
const facebookFeedBudgetMs = 9 * 1000;
const regularFeedCacheTtlMs = 30 * 60 * 1000;
const facebookFeedCacheTtlMs = 3 * 60 * 60 * 1000;
const feedRefreshBudgetMs = 9 * 1000;
const feedRefreshPauseMs = 250;
const imageTimeoutMs = 8 * 1000;
const articleTimeoutMs = 10 * 1000;
const discoverTimeoutMs = 10 * 1000;
const translateTimeoutMs = 8 * 1000;
const translationCacheTtlMs = 30 * 60 * 1000;
const maxTranslationChars = 6000;
const systemFeeds = [
  {
    name: "Estreias da semana",
    url: process.env.RSS_DYAGRAM_PREMIERES_FEED || "https://rss-dyagram.netlify.app/estreias.xml",
    group: "Cinema e séries"
  }
];
const publicSiteUrl = process.env.RSS_DYAGRAM_SITE_URL || "https://rss-dyagram.netlify.app/";
const widgetItemLimit = 40;
const retiredSystemFeedUrls = [
  "https://rss-dyagram.netlify.app/capital-portuguesa-cultura.xml"
];
const requestHeaders = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ico": "image/x-icon"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendBuffer(res, status, body, type = "application/octet-stream") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=900"
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function sendCachedJson(res, status, payload, maxAge = 3600) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

async function readSharedSettings() {
  if (canUseBlobSettings()) {
    const raw = await getSettingsStore().get("settings");
    return raw ? sanitizeSettings(JSON.parse(raw)) : emptySettings();
  }

  try {
    const raw = await fs.promises.readFile(settingsPath, "utf8");
    return sanitizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptySettings();
    }

    throw error;
  }
}

async function writeSharedSettings(payload) {
  const settings = sanitizeSettings({
    ...payload,
    updatedAt: new Date().toISOString()
  });

  if (canUseBlobSettings()) {
    await getSettingsStore().set("settings", JSON.stringify(settings));
    return settings;
  }

  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  return settings;
}

function canUseBlobSettings() {
  return Boolean(getBlobStore && (settingsStoreFactory || blobSettingsCredentials()));
}

function getSettingsStore() {
  const credentials = blobSettingsCredentials();
  if (credentials) {
    return getBlobStore({
      name: "rss-dyagram",
      ...credentials
    });
  }

  if (settingsStoreFactory) {
    return settingsStoreFactory();
  }

  return getBlobStore("rss-dyagram");
}

function blobSettingsCredentials() {
  const siteID = process.env.RSS_DYAGRAM_BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.RSS_DYAGRAM_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;

  return siteID && token ? { siteID, token } : null;
}

function setSettingsStoreFactory(factory) {
  settingsStoreFactory = typeof factory === "function" ? factory : null;
}

function emptySettings() {
  return {
    feeds: uniqueFeedsPayload(systemFeeds),
    groups: uniqueStrings(systemFeeds.map((feed) => normalizeSettingGroup(feed.group))),
    updatedAt: ""
  };
}

function sanitizeSettings(payload = {}) {
  const feeds = uniqueFeedsPayload([
    ...(Array.isArray(payload.feeds) ? payload.feeds : []),
    ...systemFeeds
  ]);
  const groups = uniqueStrings([
    ...(Array.isArray(payload.groups) ? payload.groups : []),
    ...feeds.map((feed) => feed.group)
  ].map(normalizeSettingGroup)).slice(0, 250);

  return {
    feeds,
    groups,
    updatedAt: typeof payload.updatedAt === "string" && payload.updatedAt
      ? payload.updatedAt
      : new Date().toISOString()
  };
}

function uniqueFeedsPayload(feeds) {
  const seen = new Set();
  const result = [];

  feeds.forEach((feed) => {
    const normalized = normalizeSettingFeed(feed);
    if (!normalized.url || seen.has(normalized.url) || isRetiredSystemFeedUrl(normalized.url)) {
      return;
    }

    seen.add(normalized.url);
    result.push(normalized);
  });

  return result.slice(0, 500);
}

function isRetiredSystemFeedUrl(url) {
  const normalized = String(url || "").replace(/\/$/, "");
  return retiredSystemFeedUrls.some((retiredUrl) => retiredUrl.replace(/\/$/, "") === normalized);
}

function normalizeSettingFeed(feed = {}) {
  const url = String(feed.url || "").trim();

  if (!isHttpUrl(url)) {
    return {
      name: "",
      url: "",
      group: "Geral"
    };
  }

  return {
    name: truncateSettingValue(feed.name || "Novo RSS", 120),
    url,
    group: normalizeSettingGroup(feed.group)
  };
}

function normalizeSettingGroup(value) {
  return truncateSettingValue(value || "Geral", 80) || "Geral";
}

function truncateSettingValue(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeStaticPath(urlPath) {
  if (urlPath === "/facebook-feed.html") {
    return path.join(root, "facebook-feed.html");
  }

  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.normalize(path.join(publicDir, requested));

  if (!resolved.startsWith(publicDir)) {
    return null;
  }

  return resolved;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = feedTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("A origem demorou demasiado a responder.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readRequestBody(req, maxBytes = 40 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("O texto é demasiado longo para traduzir de uma vez."));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function fetchFeed(feedUrl) {
  const cached = cache.get(`feed:${feedUrl}`);
  if (cached && Date.now() - cached.createdAt < cacheTtlMs) {
    return cached;
  }

  if (isFacebookPageUrl(feedUrl)) {
    const result = await fetchFacebookPageFeed(feedUrl);
    cache.set(`feed:${feedUrl}`, result);
    return result;
  }

  const response = await fetchWithTimeout(feedUrl, {
    headers: {
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      ...requestHeaders
    }
  }, feedTimeoutMs);

  const text = await response.text();
  const result = {
    body: text,
    contentType: response.headers.get("content-type") || "application/xml; charset=utf-8",
    createdAt: Date.now(),
    status: response.status
  };

  if (!response.ok) {
    throw new Error(`A origem respondeu com HTTP ${response.status}.`);
  }

  cache.set(`feed:${feedUrl}`, result);
  return result;
}

async function fetchCachedFeed(feedUrl, options = {}) {
  const cached = await readFeedCache(feedUrl);
  if (!options.force && isFreshFeedCache(cached, feedUrl)) {
    return {
      ...cached,
      cacheStatus: "hit",
      status: cached.status || 200
    };
  }

  try {
    const fresh = await fetchFeed(feedUrl);
    const entry = await writeFeedCache(feedUrl, {
      body: fresh.body,
      contentType: fresh.contentType,
      status: fresh.status || 200,
      updatedAt: new Date().toISOString(),
      lastError: "",
      lastAttemptAt: new Date().toISOString()
    });

    return {
      ...entry,
      cacheStatus: cached?.body ? "refresh" : "miss"
    };
  } catch (error) {
    if (cached?.body) {
      await writeFeedCache(feedUrl, {
        ...cached,
        lastError: error.message || "Não foi possível atualizar o feed.",
        lastAttemptAt: new Date().toISOString()
      });

      return {
        ...cached,
        cacheStatus: "stale",
        stale: true,
        lastError: error.message || cached.lastError || ""
      };
    }

    throw error;
  }
}

async function readCachedNews(options = {}) {
  const settings = await readSharedSettings();
  const feeds = selectFeedsByScope(settings.feeds, options);
  const feedsData = await Promise.all(feeds.map(async (feed) => {
    const cached = await readFeedCache(feed.url);
    if (!cached?.body) {
      return {
        feed,
        status: "missing",
        body: "",
        contentType: "",
        updatedAt: "",
        stale: true,
        error: cached?.lastError || "Ainda não há cache para este feed."
      };
    }

    return {
      feed,
      status: "fulfilled",
      body: cached.body,
      contentType: cached.contentType || "application/xml; charset=utf-8",
      updatedAt: cached.updatedAt || "",
      stale: !isFreshFeedCache(cached, feed.url),
      error: cached.lastError || ""
    };
  }));

  return {
    feeds: settings.feeds,
    groups: settings.groups,
    settingsUpdatedAt: settings.updatedAt,
    generatedAt: new Date().toISOString(),
    feedsData
  };
}

async function buildWidgetPayload(options = {}) {
  const settings = await readSharedSettings();
  const limit = Math.max(1, Math.min(Number(options.limit) || widgetItemLimit, 100));
  const cachedFeeds = await Promise.all(settings.feeds.map(async (feed) => ({
    feed,
    cached: await readFeedCache(feed.url)
  })));
  const items = cachedFeeds.flatMap(({ feed, cached }) => (
    cached?.body ? parseWidgetFeedItems(cached.body, feed) : []
  ));
  const seen = new Set();
  const uniqueItems = items
    .sort((left, right) => right.timestamp - left.timestamp)
    .filter((item) => {
      const key = item.url || item.id;
      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  const latestCacheUpdate = cachedFeeds
    .map(({ cached }) => Date.parse(cached?.updatedAt || "") || 0)
    .sort((left, right) => right - left)[0] || 0;

  return {
    version: 1,
    app: "Rss Dyagram",
    siteUrl: publicSiteUrl,
    generatedAt: new Date().toISOString(),
    updatedAt: latestCacheUpdate ? new Date(latestCacheUpdate).toISOString() : "",
    itemCount: uniqueItems.length,
    unreadWindow: limit,
    items: uniqueItems.slice(0, limit).map(({ timestamp, ...item }) => item)
  };
}

async function refreshCachedFeeds(options = {}) {
  const settings = await readSharedSettings();
  const scopedFeeds = selectFeedsByScope(settings.feeds, options);
  const feedStates = await Promise.all(scopedFeeds.map(async (feed) => ({
    feed,
    cached: await readFeedCache(feed.url)
  })));
  const staleFeeds = feedStates
    .filter(({ feed, cached }) => options.force || !isFreshFeedCache(cached, feed.url))
    .sort((left, right) => feedCacheSortValue(left) - feedCacheSortValue(right));

  const regularFeeds = staleFeeds
    .filter(({ feed }) => !isFacebookPageUrl(feed.url))
    .slice(0, options.maxRegular ?? 6);
  const facebookFeeds = staleFeeds
    .filter(({ feed }) => isFacebookPageUrl(feed.url))
    .slice(0, options.maxFacebook ?? 1);
  const selectedFeeds = [...regularFeeds, ...facebookFeeds];
  const deadline = Date.now() + (options.budgetMs ?? feedRefreshBudgetMs);
  const refreshed = [];
  const errors = [];
  const skipped = Math.max(0, staleFeeds.length - selectedFeeds.length);

  for (const { feed } of selectedFeeds) {
    if (Date.now() > deadline - 900) {
      break;
    }

    try {
      const updated = await fetchCachedFeed(feed.url, { force: true });
      refreshed.push({
        name: feed.name,
        url: feed.url,
        updatedAt: updated.updatedAt || new Date().toISOString(),
        itemCount: countFeedItems(updated.body)
      });
    } catch (error) {
      await writeFeedCache(feed.url, {
        ...(await readFeedCache(feed.url) || {}),
        lastError: error.message || "Não foi possível atualizar o feed.",
        lastAttemptAt: new Date().toISOString()
      });
      errors.push({
        name: feed.name,
        url: feed.url,
        error: error.message || "Não foi possível atualizar o feed."
      });
    }

    if (isFacebookPageUrl(feed.url)) {
      await sleep(feedRefreshPauseMs);
    }
  }

  return {
    refreshed,
    errors,
    stale: staleFeeds.length,
    skipped: skipped + Math.max(0, selectedFeeds.length - refreshed.length - errors.length),
    scoped: scopedFeeds.length,
    generatedAt: new Date().toISOString()
  };
}

function selectFeedsByScope(feeds, options = {}) {
  if (options.url) {
    return feeds.filter((feed) => sameSettingFeedUrl(feed.url, options.url));
  }

  if (options.group) {
    const key = normalizeSettingGroup(options.group).toLocaleLowerCase("pt-PT");
    return feeds.filter((feed) => normalizeSettingGroup(feed.group).toLocaleLowerCase("pt-PT") === key);
  }

  return feeds;
}

function feedCacheSortValue({ feed, cached }) {
  if (!cached?.body) {
    return Date.parse(cached?.lastAttemptAt || "") || 0;
  }

  return Date.parse(cached.updatedAt || cached.lastAttemptAt || "") || 1;
}

function isFreshFeedCache(cached, feedUrl) {
  if (!cached?.body || !cached.updatedAt) {
    return false;
  }

  const updatedAt = Date.parse(cached.updatedAt);
  if (!updatedAt) {
    return false;
  }

  const ttl = isFacebookPageUrl(feedUrl) ? facebookFeedCacheTtlMs : regularFeedCacheTtlMs;
  return Date.now() - updatedAt < ttl;
}

async function readFeedCache(feedUrl) {
  const key = feedCacheKey(feedUrl);

  if (canUseBlobSettings()) {
    const raw = await getSettingsStore().get(key);
    return raw ? normalizeFeedCache(JSON.parse(raw), feedUrl) : null;
  }

  try {
    const raw = await fs.promises.readFile(feedCacheFilePath(feedUrl), "utf8");
    return normalizeFeedCache(JSON.parse(raw), feedUrl);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeFeedCache(feedUrl, payload) {
  const entry = normalizeFeedCache({
    ...payload,
    url: feedUrl,
    storedAt: new Date().toISOString()
  }, feedUrl);
  const key = feedCacheKey(feedUrl);
  const body = JSON.stringify(entry);

  if (canUseBlobSettings()) {
    await getSettingsStore().set(key, body);
    return entry;
  }

  await fs.promises.mkdir(feedCacheDir, { recursive: true });
  await fs.promises.writeFile(feedCacheFilePath(feedUrl), JSON.stringify(entry, null, 2));
  return entry;
}

function normalizeFeedCache(payload = {}, feedUrl) {
  return {
    url: String(payload.url || feedUrl || ""),
    body: String(payload.body || ""),
    contentType: String(payload.contentType || "application/xml; charset=utf-8"),
    status: Number(payload.status) || 200,
    updatedAt: String(payload.updatedAt || ""),
    storedAt: String(payload.storedAt || ""),
    lastAttemptAt: String(payload.lastAttemptAt || ""),
    lastError: String(payload.lastError || "")
  };
}

function feedCacheKey(feedUrl) {
  return `feed-cache/${crypto.createHash("sha1").update(String(feedUrl || "")).digest("hex")}`;
}

function feedCacheFilePath(feedUrl) {
  const filename = feedCacheKey(feedUrl).replace(/^feed-cache\//, "");
  return path.join(feedCacheDir, `${filename}.json`);
}

function countFeedItems(body) {
  const text = String(body || "");
  return (text.match(/<item\b/gi) || []).length + (text.match(/<entry\b/gi) || []).length;
}

function parseWidgetFeedItems(xml, feed) {
  const rssItems = extractTagBlocks(xml, "item", 80);
  const entries = rssItems.length ? rssItems : extractTagBlocks(xml, "entry", 80);

  return entries.map((entry) => {
    const rawTitle = widgetXmlValue(entry, "title") || "Sem título";
    const rawDescription = widgetXmlValue(entry, "description")
      || widgetXmlValue(entry, "summary")
      || widgetXmlValue(entry, "content:encoded")
      || widgetXmlValue(entry, "content")
      || "";
    const url = widgetEntryUrl(entry, feed.url);
    const rawId = widgetXmlValue(entry, "guid") || widgetXmlValue(entry, "id") || url || rawTitle;
    const dateValue = widgetXmlValue(entry, "pubDate")
      || widgetXmlValue(entry, "published")
      || widgetXmlValue(entry, "updated")
      || "";
    const timestamp = Date.parse(dateValue) || 0;
    const title = htmlToReadableText(rawTitle).replace(/\s+/g, " ").trim() || "Sem título";
    const description = htmlToReadableText(rawDescription).replace(/\s+/g, " ").trim().slice(0, 220);
    const image = widgetEntryImage(entry, rawDescription, url || feed.url);
    const id = crypto.createHash("sha1").update(`${feed.url}:${rawId}`).digest("hex");

    return {
      id,
      title,
      description,
      source: feed.name,
      group: feed.group,
      url,
      appUrl: url ? `${publicSiteUrl}?article=${encodeURIComponent(url)}` : publicSiteUrl,
      image,
      publishedAt: timestamp ? new Date(timestamp).toISOString() : "",
      timestamp
    };
  }).filter((item) => item.url && item.title);
}

function widgetXmlValue(xml, tagName) {
  const escapedTag = escapeRegExp(tagName);
  const match = String(xml || "").match(new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  if (!match) {
    return "";
  }

  return decodeHtmlEntities(match[1]
    .replace(/^\s*<!\[CDATA\[/i, "")
    .replace(/\]\]>\s*$/i, "")
    .trim());
}

function widgetEntryUrl(entry, fallbackUrl) {
  const textLink = widgetXmlValue(entry, "link");
  const atomLink = String(entry || "").match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] || "";
  const candidate = decodeHtmlEntities(atomLink || textLink).trim();
  return toAbsoluteUrl(candidate, fallbackUrl) || fallbackUrl;
}

function widgetEntryImage(entry, description, baseUrl) {
  const mediaUrl = String(entry || "").match(/<(?:enclosure|media:content|media:thumbnail)\b[^>]*\burl=["']([^"']+)["'][^>]*>/i)?.[1] || "";
  const htmlImage = String(description || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1] || "";
  return toAbsoluteUrl(decodeHtmlEntities(mediaUrl || htmlImage).trim(), baseUrl);
}

function sameSettingFeedUrl(left, right) {
  return String(left || "").replace(/\/$/, "") === String(right || "").replace(/\/$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverFeed(inputUrl) {
  const cacheKey = `discover:${inputUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < cacheTtlMs) {
    return cached;
  }

  if (isFacebookPageUrl(inputUrl)) {
    const feedUrl = canonicalFacebookPageUrl(inputUrl);
    const feed = await fetchFeed(feedUrl);
    const result = {
      url: feedUrl,
      title: feedTitleFromXml(feed.body) || "Facebook",
      discovered: false,
      createdAt: Date.now()
    };
    cache.set(cacheKey, result);
    cache.set(`discover:${feedUrl}`, result);
    return result;
  }

  const response = await fetchWithTimeout(inputUrl, {
    headers: {
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
      ...requestHeaders
    }
  }, discoverTimeoutMs);
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(`A origem respondeu com HTTP ${response.status}.`);
  }

  if (looksLikeFeed(body, contentType)) {
    const result = {
      url: inputUrl,
      title: feedTitleFromXml(body) || hostnameTitle(inputUrl),
      discovered: false,
      createdAt: Date.now()
    };
    cache.set(cacheKey, result);
    return result;
  }

  const discoveredUrls = [
    ...extractFeedLinks(body, inputUrl),
    ...commonFeedCandidates(inputUrl)
  ];

  for (const feedUrl of uniqueStrings(discoveredUrls)) {
    try {
      const feed = await fetchFeed(feedUrl);
      const result = {
        url: feedUrl,
        title: feedTitleFromXml(feed.body) || hostnameTitle(feedUrl),
        discovered: feedUrl !== inputUrl,
        createdAt: Date.now()
      };
      cache.set(cacheKey, result);
      return result;
    } catch {
      // Keep trying other advertised candidates.
    }
  }

  throw new Error("Não encontrei RSS/Atom nesta página.");
}

async function fetchImage(imageUrl) {
  const cacheKey = `image:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < cacheTtlMs) {
    return cached;
  }

  const response = await fetchWithTimeout(imageUrl, {
    headers: imageRequestHeaders(imageUrl)
  }, imageTimeoutMs);
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "application/octet-stream";

  if (!response.ok) {
    throw new Error(`A imagem respondeu com HTTP ${response.status}.`);
  }

  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("A origem não devolveu uma imagem.");
  }

  const result = {
    body,
    contentType,
    createdAt: Date.now(),
    status: response.status
  };

  cache.set(cacheKey, result);
  return result;
}

function imageRequestHeaders(imageUrl) {
  const headers = {
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
    "Referer": originForUrl(imageUrl),
    ...requestHeaders
  };

  if (isFacebookAssetUrl(imageUrl)) {
    headers["User-Agent"] = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
    headers["Referer"] = "https://www.facebook.com/";
  }

  return headers;
}

async function fetchFacebookPageFeed(feedUrl) {
  let lastError = null;
  let fallbackTitle = facebookTitleFromUrl(feedUrl);
  let fallbackDescription = "";
  const deadline = Date.now() + facebookFeedBudgetMs;

  for (const attempt of facebookFetchAttempts(feedUrl)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 800) {
      break;
    }

    try {
      const response = await fetchWithTimeout(attempt.url, {
        headers: attempt.headers
      }, Math.min(facebookFeedTimeoutMs, remainingMs));

      const html = await response.text();
      if (!response.ok) {
        lastError = new Error(`O Facebook respondeu com HTTP ${response.status}.`);
        continue;
      }

      fallbackTitle = facebookPageTitle(extractMetaContent(html, "og:title"), feedUrl) || fallbackTitle;
      fallbackDescription = extractMetaContent(html, "og:description") || fallbackDescription;

      const posts = parseFacebookPagePosts(html, feedUrl);
      if (!posts.length) {
        lastError = new Error("O Facebook respondeu sem publicações acessíveis neste momento.");
        continue;
      }

      const body = facebookPostsToRss({
        title: fallbackTitle,
        link: feedUrl,
        description: fallbackDescription,
        posts
      });

      return {
        body,
        contentType: "application/rss+xml; charset=utf-8",
        createdAt: Date.now(),
        status: response.status
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("O Facebook respondeu sem publicações acessíveis neste momento.");
}

function facebookFetchAttempts(feedUrl) {
  const baseHeaders = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
    "Referer": "https://www.facebook.com/"
  };
  const externalHit = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
  const googleBot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  return [
    { url: toMbasicFacebookUrl(feedUrl), agent: externalHit },
    { url: toMbasicFacebookUrl(feedUrl), agent: googleBot },
    { url: toWwwFacebookUrl(feedUrl), agent: externalHit },
    { url: facebookUrlWithLocale(feedUrl), agent: externalHit }
  ]
    .filter((attempt) => attempt.url)
    .filter((attempt, index, attempts) => (
      attempts.findIndex((candidate) => candidate.url === attempt.url && candidate.agent === attempt.agent) === index
    ))
    .map((attempt) => ({
      url: attempt.url,
      headers: {
        ...baseHeaders,
        "User-Agent": attempt.agent
      }
    }));
}

function parseFacebookPagePosts(html, pageUrl) {
  const postMatches = [...html.matchAll(/"post_id":"(\d+)"/g)];
  const posts = [];
  const maxScannedPosts = 240;
  let scannedPosts = 0;

  for (const match of postMatches) {
    scannedPosts += 1;
    const postId = match[1];
    const windowHtml = html.slice(Math.max(0, match.index - 5000), match.index + 30000);
    const message = extractFacebookMessage(windowHtml);
    const postUrl = extractFacebookPostUrl(windowHtml, pageUrl, postId);

    if (!message || !postUrl) {
      continue;
    }

    const timestamp = facebookPostTimestamp(windowHtml, postId);
    const interactions = parseFacebookInteractions(windowHtml);
    posts.push({
      id: postId,
      title: firstLine(message),
      description: message,
      link: postUrl,
      image: extractFacebookPostImage(windowHtml),
      date: timestamp ? new Date(timestamp * 1000).toUTCString() : "",
      likes: interactions.likes,
      shares: interactions.shares,
      comments: interactions.comments
    });

    if (scannedPosts >= maxScannedPosts) {
      break;
    }
  }

  return uniqueFacebookPosts(posts.sort((left, right) => facebookPostTime(right) - facebookPostTime(left)))
    .slice(0, 30);
}

function uniqueFacebookPosts(posts) {
  const seen = new Set();

  return posts.filter((post) => {
    const descriptionKey = cleanupFacebookText(post.description).toLocaleLowerCase("pt-PT").slice(0, 240);
    const key = descriptionKey
      ? `${descriptionKey}|${post.image || ""}`
      : normalizePostUrl(post.link);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function facebookPostTime(post) {
  const timestamp = Date.parse(post.date || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizePostUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").replace(/\/$/, "");
  }
}

function facebookPostTimestamp(html, postId = "") {
  const nearestTimestamp = nearestParsedTimestamp(html, postId);
  if (nearestTimestamp) {
    return nearestTimestamp;
  }

  const timestamp = firstParsedTimestamp(html, [
    /"creation_time"\s*:\s*(\d{9,13})/i,
    /"publish_time"\s*:\s*(\d{9,13})/i,
    /"created_time"\s*:\s*(\d{9,13})/i,
    /"publishTime"\s*:\s*(\d{9,13})/i
  ]);

  return timestamp;
}

function extractFacebookMessage(html) {
  const patterns = [
    /"message":\{"delight_ranges"[\s\S]*?"text":"((?:\\.|[^"\\])*)"/,
    /"message":\{"__typename":"TextWithEntities","text":"((?:\\.|[^"\\])*)"/,
    /"message":\{"text":"((?:\\.|[^"\\])*)"/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return cleanupFacebookText(decodeJsonString(match[1]));
    }
  }

  return "";
}

function extractFacebookPostUrl(html, pageUrl, postId) {
  const wwwMatch = html.match(/"wwwURL":"((?:\\.|[^"\\])*)"/);
  if (wwwMatch) {
    return decodeJsonString(wwwMatch[1]);
  }

  const postMatch = html.match(/"url":"(https:\\\/\\\/www\.facebook\.com\\\/[^"\\]*\\\/posts\\\/(?:\\.|[^"\\])*)"/);
  if (postMatch) {
    return decodeJsonString(postMatch[1]);
  }

  try {
    const parsed = new URL(pageUrl);
    return `https://www.facebook.com/${parsed.pathname.replace(/^\/|\/$/g, "")}/posts/${postId}`;
  } catch {
    return `https://www.facebook.com/${postId}`;
  }
}

function extractFacebookPostImage(html) {
  const patterns = [
    /"image"\s*:\s*\{[\s\S]{0,5000}?"uri":"((?:\\.|[^"\\])*)"/,
    /"photo_image"[\s\S]{0,5000}?"uri":"((?:\\.|[^"\\])*)"/,
    /"preferred_thumbnail"[\s\S]{0,5000}?"uri":"((?:\\.|[^"\\])*)"/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return decodeJsonString(match[1]);
    }
  }

  return "";
}

function facebookPostsToRss(feed) {
  const items = feed.posts.map((post) => {
    const imageMarkup = post.image ? `<p><img src="${escapeXml(post.image)}" /></p>` : "";
    return `
      <item>
        <title>${escapeXml(post.title)}</title>
        <link>${escapeXml(post.link)}</link>
        <guid isPermaLink="false">${escapeXml(post.id)}</guid>
        ${post.date ? `<pubDate>${escapeXml(post.date)}</pubDate>` : ""}
        <description><![CDATA[${imageMarkup}${escapeCdata(post.description)}]]></description>
        ${post.image ? `<enclosure url="${escapeXml(post.image)}" type="image/jpeg" />` : ""}
        <likes>${post.likes ?? ""}</likes>
        <shares>${post.shares ?? ""}</shares>
        <comments>${post.comments ?? ""}</comments>
      </item>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${escapeXml(feed.link)}</link>
    <description>${escapeXml(feed.description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

function isFacebookPageUrl(feedUrl) {
  try {
    const parsed = new URL(feedUrl);
    const pagePath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return /(^|\.)facebook\.com$/i.test(parsed.hostname)
      && pagePath.length > 0
      && !/\/posts\/|\/permalink\.php|story_fbid=|\/photo\//i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function canonicalFacebookPageUrl(feedUrl) {
  try {
    const parsed = new URL(feedUrl);
    const profileId = parsed.searchParams.get("id");
    parsed.protocol = "https:";
    parsed.hostname = "www.facebook.com";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = `/${parsed.pathname.replace(/^\/+|\/+$/g, "")}`;
    if (/^\/profile\.php$/i.test(parsed.pathname) && profileId) {
      parsed.searchParams.set("id", profileId);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return feedUrl;
  }
}

function facebookPageTitle(rawTitle, feedUrl) {
  const cleaned = String(rawTitle || "").replace(/\s*\|.*$/, "").trim();
  if (cleaned && !/^facebook$/i.test(cleaned)) {
    return cleaned;
  }

  return facebookTitleFromUrl(feedUrl);
}

function facebookTitleFromUrl(feedUrl) {
  try {
    const parsed = new URL(feedUrl);
    const handle = parsed.pathname.split("/").filter(Boolean)[0] || "Facebook";
    if (/^profile\.php$/i.test(handle) && parsed.searchParams.get("id")) {
      return parsed.searchParams.get("id");
    }

    const known = {
      abolapt: "A BOLA",
      beirabaixatv: "Beira Baixa TV"
    };
    const key = handle.toLowerCase();

    if (known[key]) {
      return known[key];
    }

    return handle
      .replace(/[-_.]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim() || "Facebook";
  } catch {
    return "Facebook";
  }
}

function looksLikeFeed(body, contentType = "") {
  const sample = String(body || "").slice(0, 4000);
  const type = String(contentType || "").toLowerCase();

  return /(rss|atom|\+xml|\/xml|text\/xml)/i.test(type) && /<(rss|feed)\b/i.test(sample)
    || /<(rss|feed)\b[\s>]/i.test(sample);
}

function feedTitleFromXml(xml) {
  const channelTitle = xml.match(/<channel\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  const feedTitle = xml.match(/<feed\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = channelTitle?.[1] || feedTitle?.[1] || "";

  return decodeHtmlEntities(title
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function extractFeedLinks(html, baseUrl) {
  const links = [];
  const linkPattern = /<link\b[^>]*>/gi;
  let match;

  while ((match = linkPattern.exec(html))) {
    const attrs = tagAttributes(match[0]);
    const rel = attrs.rel || "";
    const type = attrs.type || "";
    const href = attrs.href || "";

    if (!href) {
      continue;
    }

    const advertisesFeed = /\balternate\b/i.test(rel) && /(rss|atom|\+xml|\/xml)/i.test(type);
    const looksLikeFeedUrl = /(?:rss|atom|feed)(?:\.xml|\/|$)/i.test(href);

    if (advertisesFeed || looksLikeFeedUrl) {
      links.push(toAbsoluteUrl(decodeHtmlEntities(href), baseUrl));
    }
  }

  return links.filter((url) => /^https?:\/\//i.test(url));
}

function tagAttributes(tag) {
  const attrs = {};
  const pattern = /([^\s=\/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = pattern.exec(tag))) {
    const name = match[1].toLowerCase();
    if (name === "link") {
      continue;
    }

    attrs[name] = decodeHtmlEntities(match[2] || match[3] || match[4] || "");
  }

  return attrs;
}

function commonFeedCandidates(inputUrl) {
  try {
    const parsed = new URL(inputUrl);
    const origin = `${parsed.protocol}//${parsed.hostname}`;
    const pathBase = parsed.pathname.replace(/\/+$/, "");
    const candidates = [
      `${origin}/feed`,
      `${origin}/feed/`,
      `${origin}/rss`,
      `${origin}/rss.xml`,
      `${origin}/atom.xml`,
      `${origin}/feed.xml`
    ];

    if (pathBase && pathBase !== "") {
      candidates.unshift(`${origin}${pathBase}/feed/`);
      candidates.unshift(`${origin}${pathBase}/rss/`);
    }

    return candidates;
  } catch {
    return [];
  }
}

function hostnameTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Novo RSS";
  }
}

async function fetchArticle(articleUrl) {
  const cacheKey = `article:${articleUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < cacheTtlMs) {
    return cached;
  }

  const response = await fetchWithTimeout(articleUrl, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...requestHeaders
    }
  }, articleTimeoutMs);

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`A origem respondeu com HTTP ${response.status}.`);
  }

  const parsed = parseArticle(html, articleUrl);
  if (parsed.facebookUrl) {
    try {
      const facebookInteractions = await fetchFacebookInteractions(parsed.facebookUrl);
      parsed.interactions = {
        ...parsed.interactions,
        ...facebookInteractions,
        available: facebookInteractions.available || parsed.interactions.available,
        message: facebookInteractions.available ? "" : parsed.interactions.message
      };
    } catch {
      parsed.interactions.message = parsed.interactions.message || "Não foi possível obter as interações do Facebook.";
    }
  }

  const result = {
    ...parsed,
    createdAt: Date.now(),
    status: response.status
  };

  cache.set(cacheKey, result);
  return result;
}

function parseArticle(html, articleUrl) {
  const structuredArticle = extractStructuredArticle(html, articleUrl);
  const entryHtml = extractArticleHtml(html);
  const featuredHtml = extractClassBlock(html, "post-thumbnail");
  const metaImage = extractMetaImage(html, articleUrl);
  const entryImages = extractImages(entryHtml, articleUrl);
  const images = uniqueStrings([metaImage, ...structuredArticle.images, ...entryImages]);
  const featuredImage = extractImages(featuredHtml, articleUrl)[0] || structuredArticle.images[0] || metaImage || images[0] || "";
  const text = bestArticleText([
    structuredArticle.text,
    htmlToReadableText(entryHtml)
  ]);
  const facebookUrl = extractFacebookUrl(entryHtml) || extractCanonicalFacebookUrl(html);
  const comments = extractCommentCount(html);
  const shareTargets = extractShareTargets(html);

  return {
    text,
    images,
    featuredImage,
    facebookUrl,
    shareTargets,
    interactions: {
      likes: null,
      shares: null,
      comments,
      reactions: null,
      available: comments !== null,
      message: ""
    }
  };
}

function extractStructuredArticle(html, baseUrl) {
  const articles = [];
  const scriptPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptPattern.exec(html))) {
    const payload = parseJsonPayload(match[1]);
    if (payload) {
      collectStructuredArticles(payload, articles, baseUrl);
    }
  }

  return articles
    .map((article) => ({
      text: cleanupArticleText(article.text),
      images: uniqueStrings(article.images)
    }))
    .filter((article) => article.text || article.images.length)
    .sort((a, b) => b.text.length - a.text.length)[0] || { text: "", images: [] };
}

function parseJsonPayload(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^<!--\s*/, "")
    .replace(/\s*-->$/, "");

  if (!cleaned) {
    return null;
  }

  for (const candidate of [cleaned, decodeHtmlEntities(cleaned)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

function collectStructuredArticles(value, articles, baseUrl, depth = 0) {
  if (!value || depth > 8) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectStructuredArticles(entry, articles, baseUrl, depth + 1));
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : String(value["@type"] || "");
  const articleLike = /(?:^|\b)(NewsArticle|Article|BlogPosting|ReportageNewsArticle|Review)(?:\b|$)/i.test(type);
  const text = [value.articleBody, value.text]
    .map((entry) => structuredTextValue(entry))
    .filter(Boolean)
    .join("\n\n");

  if ((articleLike || value.articleBody) && text) {
    articles.push({
      text,
      images: structuredImageValues(value, baseUrl)
    });
  }

  Object.entries(value).forEach(([key, child]) => {
    if (["author", "publisher", "image", "thumbnail", "thumbnailUrl"].includes(key)) {
      return;
    }

    if (child && (Array.isArray(child) || typeof child === "object")) {
      collectStructuredArticles(child, articles, baseUrl, depth + 1);
    }
  });
}

function structuredTextValue(value) {
  if (typeof value === "string") {
    return decodeHtmlEntities(value).trim();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => structuredTextValue(entry)).filter(Boolean).join("\n\n");
  }

  if (value && typeof value === "object") {
    return structuredTextValue(value.text || value.value || "");
  }

  return "";
}

function structuredImageValues(value, baseUrl) {
  const rawImages = [
    ...flattenImageValue(value.image),
    ...flattenImageValue(value.thumbnail),
    ...flattenImageValue(value.thumbnailUrl)
  ];

  return uniqueStrings(rawImages
    .map((url) => toAbsoluteUrl(String(url || "").trim(), baseUrl))
    .filter(isUsableImageUrl));
}

function flattenImageValue(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return [decodeHtmlEntities(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenImageValue(entry));
  }

  if (typeof value === "object") {
    return [
      ...flattenImageValue(value.url),
      ...flattenImageValue(value.contentUrl),
      ...flattenImageValue(value["@id"])
    ];
  }

  return [];
}

async function fetchFacebookInteractions(facebookUrl) {
  const url = toMbasicFacebookUrl(facebookUrl);
  if (!url) {
    return emptyInteractions();
  }

  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    }
  }, articleTimeoutMs);

  if (!response.ok) {
    throw new Error(`O Facebook respondeu com HTTP ${response.status}.`);
  }

  return parseFacebookInteractions(await response.text());
}

function parseFacebookInteractions(html) {
  const likes = firstParsedNumber(html, [
    /"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
    /"reaction_count"\s*:\s*(\d+)/i,
    /"i18n_reaction_count"\s*:\s*"([^"]+)"/i
  ]);
  const shares = firstParsedNumber(html, [
    /"share_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
    /"i18n_share_count"\s*:\s*"([^"]+)"/i,
    /([\d.,]+\s*(?:mil|k|m)?)\s*partilhas?/i
  ]);
  const comments = firstParsedNumber(html, [
    /"comment_rendering_instance"\s*:\s*\{\s*"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/i,
    /"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/i,
    /([\d.,]+\s*(?:mil|k|m)?)\s*coment[aá]rios?/i
  ]);
  const available = [likes, shares, comments].some((value) => value !== null);

  return {
    likes,
    shares,
    comments,
    reactions: likes,
    available,
    message: available ? "" : "O Facebook não publicou contagens acessíveis para este post."
  };
}

function emptyInteractions() {
  return {
    likes: null,
    shares: null,
    comments: null,
    reactions: null,
    available: false,
    message: ""
  };
}

function firstParsedNumber(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const number = parseLocalizedNumber(match[1]);
      if (number !== null) {
        return number;
      }
    }
  }

  return null;
}

function firstParsedTimestamp(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) {
      continue;
    }

    let timestamp = Number(match[1]);
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (timestamp > 1000000000000) {
      timestamp = Math.floor(timestamp / 1000);
    }

    const earliestAccepted = Date.UTC(2005, 0, 1) / 1000;
    const latestAccepted = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
    if (timestamp >= earliestAccepted && timestamp <= latestAccepted) {
      return timestamp;
    }
  }

  return null;
}

function nearestParsedTimestamp(html, anchorText) {
  if (!anchorText) {
    return null;
  }

  const anchorIndex = html.indexOf(anchorText);
  if (anchorIndex < 0) {
    return null;
  }

  const pattern = /(?:\\?")?(creation_time|publish_time|publishTime|created_time)(?:\\?")?\s*:\s*(\d{9,13})/gi;
  let best = null;
  let match;

  while ((match = pattern.exec(html))) {
    const timestamp = normalizeTimestamp(match[2]);
    if (!timestamp) {
      continue;
    }

    const distance = Math.abs(match.index - anchorIndex);
    if (!best || distance < best.distance) {
      best = { timestamp, distance };
    }
  }

  return best?.timestamp || null;
}

function normalizeTimestamp(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  if (timestamp > 1000000000000) {
    timestamp = Math.floor(timestamp / 1000);
  }

  const earliestAccepted = Date.UTC(2005, 0, 1) / 1000;
  const latestAccepted = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
  return timestamp >= earliestAccepted && timestamp <= latestAccepted ? timestamp : null;
}

function parseLocalizedNumber(value) {
  const normalized = decodeHtmlEntities(value)
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase();
  const match = normalized.match(/(\d+(?:[.,]\d+)?)/);

  if (!match) {
    return null;
  }

  let numeric = match[1];
  if (numeric.includes(",") && numeric.includes(".")) {
    numeric = numeric.replace(/\./g, "").replace(",", ".");
  } else if (numeric.includes(",")) {
    numeric = numeric.replace(",", ".");
  } else if (/\.\d{3}\b/.test(numeric)) {
    numeric = numeric.replace(/\./g, "");
  }

  let number = Number(numeric);
  if (!Number.isFinite(number)) {
    return null;
  }

  if (/\b(mil|k)\b/i.test(normalized)) {
    number *= 1000;
  } else if (/\b(m|milh[õo]es?)\b/i.test(normalized)) {
    number *= 1000000;
  }

  return Math.round(number);
}

function toMbasicFacebookUrl(facebookUrl) {
  try {
    const parsed = new URL(facebookUrl);
    if (!/facebook\.com$/i.test(parsed.hostname)) {
      return "";
    }

    parsed.hostname = "mbasic.facebook.com";
    return parsed.toString();
  } catch {
    return "";
  }
}

function toWwwFacebookUrl(facebookUrl) {
  try {
    const parsed = new URL(facebookUrl);
    if (!/facebook\.com$/i.test(parsed.hostname)) {
      return "";
    }

    parsed.protocol = "https:";
    parsed.hostname = "www.facebook.com";
    return parsed.toString();
  } catch {
    return "";
  }
}

function facebookUrlWithLocale(facebookUrl) {
  const url = toWwwFacebookUrl(facebookUrl);
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("locale", "pt_PT");
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractClassBlock(html, className) {
  const escapedClass = escapeRegExp(className);
  const openTagPattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class=["'][^"']*\\b${escapedClass}\\b[^"']*["'][^>]*>`, "i");
  const openTag = openTagPattern.exec(html);

  if (!openTag) {
    return "";
  }

  const tag = openTag[1].toLowerCase();
  const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = openTag.index + openTag[0].length;
  let depth = 1;
  let tagMatch;

  while ((tagMatch = tagPattern.exec(html))) {
    const isClosing = /^<\//.test(tagMatch[0]);
    const isSelfClosing = /\/>$/.test(tagMatch[0]);

    if (isClosing) {
      depth -= 1;
    } else if (!isSelfClosing) {
      depth += 1;
    }

    if (depth === 0) {
      return html.slice(openTag.index, tagPattern.lastIndex);
    }
  }

  return html.slice(openTag.index);
}

function extractArticleHtml(html) {
  const classNames = [
    "entry-content",
    "post-content",
    "article-content",
    "article__content",
    "article-body",
    "article__body",
    "articleBody",
    "body__container",
    "story-body",
    "storyBody",
    "content-body",
    "post__content",
    "single-content",
    "td-post-content",
    "container--body-inner",
    "container--full-inner"
  ];
  const candidates = [
    ...classNames.map((className) => extractClassBlock(html, className)),
    ...extractTagBlocks(html, "article")
  ].filter(Boolean);

  return candidates
    .map((candidate) => ({
      html: candidate,
      text: cleanupArticleText(htmlToReadableText(candidate))
    }))
    .filter((candidate) => candidate.text.length >= 80)
    .sort((a, b) => b.text.length - a.text.length)[0]?.html || "";
}

function extractTagBlocks(html, tagName, limit = 8) {
  const blocks = [];
  const safeTag = escapeRegExp(tagName);
  const openTagPattern = new RegExp(`<${safeTag}\\b[^>]*>`, "gi");
  let openTag;

  while ((openTag = openTagPattern.exec(html)) && blocks.length < limit) {
    const tagPattern = new RegExp(`<\\/?${safeTag}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = openTag.index + openTag[0].length;
    let depth = 1;
    let tagMatch;

    while ((tagMatch = tagPattern.exec(html))) {
      const isClosing = /^<\//.test(tagMatch[0]);
      const isSelfClosing = /\/>$/.test(tagMatch[0]);

      if (isClosing) {
        depth -= 1;
      } else if (!isSelfClosing) {
        depth += 1;
      }

      if (depth === 0) {
        blocks.push(html.slice(openTag.index, tagPattern.lastIndex));
        openTagPattern.lastIndex = tagPattern.lastIndex;
        break;
      }
    }

    if (depth > 0) {
      blocks.push(html.slice(openTag.index));
      break;
    }
  }

  return blocks;
}

function bestArticleText(values) {
  const cleaned = uniqueStrings(values.map(cleanupArticleText));
  return cleaned.find((text) => text.length >= 160)
    || cleaned.sort((a, b) => b.length - a.length)[0]
    || "";
}

function extractImages(html, baseUrl) {
  const images = [];
  const imagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imagePattern.exec(html))) {
    const rawUrl = decodeHtmlEntities(match[1]).trim();
    if (!rawUrl) {
      continue;
    }

    const absolute = toAbsoluteUrl(rawUrl, baseUrl);
    if (isUsableImageUrl(absolute)) {
      images.push(absolute);
    }
  }

  return images;
}

function extractFacebookUrl(html) {
  const linkPattern = /<a\b[^>]*href=["']([^"']*facebook\.com[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let fallback = "";
  let match;

  while ((match = linkPattern.exec(html))) {
    const url = decodeHtmlEntities(match[1]);
    const label = htmlToReadableText(match[2]);

    if (/sharer|plugins/i.test(url)) {
      continue;
    }

    if (/ver no facebook/i.test(label) || /\/posts\/|\/permalink\.php|story_fbid=/i.test(url)) {
      return url;
    }

    fallback = fallback || url;
  }

  return fallback;
}

function extractCanonicalFacebookUrl(html) {
  const linkPattern = /<link\b[^>]*>/gi;
  let match;

  while ((match = linkPattern.exec(html))) {
    const tag = match[0];
    if (!/\brel=["'][^"']*\bcanonical\b/i.test(tag)) {
      continue;
    }

    const href = /\bhref=["']([^"']+)["']/i.exec(tag);
    if (href && /facebook\.com/i.test(href[1])) {
      return decodeHtmlEntities(href[1]);
    }
  }

  return "";
}

function extractCommentCount(html) {
  const commentHtml = extractClassBlock(html, "post__comments");
  const commentText = htmlToReadableText(commentHtml);
  const commentMatch = commentText.match(/\d+/);

  if (commentMatch) {
    return Number(commentMatch[0]);
  }

  const patterns = [
    /comments?["'\s:>]+(\d+)/i,
    /coment[aá]rios?["'\s:>]+(\d+)/i,
    /(\d+)\s+coment[aá]rios?/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function extractShareTargets(html) {
  const targets = [];

  if (/facebook\.com\/sharer/i.test(html)) {
    targets.push("Facebook");
  }

  if (/(twitter\.com|x\.com)\/intent\/tweet/i.test(html)) {
    targets.push("X/Twitter");
  }

  if (/whatsapp:|api\.whatsapp\.com/i.test(html)) {
    targets.push("WhatsApp");
  }

  return uniqueStrings(targets);
}

async function translateToPortuguese({ title = "", text = "" }) {
  const cleanTitle = String(title || "").trim();
  const rawText = String(text || "").trim();
  const cleanText = rawText.slice(0, maxTranslationChars);

  if (!cleanTitle && !cleanText) {
    throw new Error("Não há texto para traduzir.");
  }

  const [translatedTitle, translatedText] = await Promise.all([
    cleanTitle ? translateText(cleanTitle) : "",
    cleanText ? translateText(cleanText) : ""
  ]);

  return {
    title: translatedTitle,
    text: translatedText,
    truncated: rawText.length > cleanText.length
  };
}

async function translateText(text) {
  const cacheKey = translationCacheKey(text);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < translationCacheTtlMs) {
    return cached.text;
  }

  const parts = splitForTranslation(text);
  const translated = new Array(parts.length);
  const translatableIndexes = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.translate);

  parts.forEach((part, index) => {
    if (!part.translate) {
      translated[index] = part.text;
    }
  });

  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, translatableIndexes.length) }, async () => {
    while (cursor < translatableIndexes.length) {
      const current = translatableIndexes[cursor];
      cursor += 1;
      translated[current.index] = await translateChunk(current.part.text);
    }
  });

  if (workers.length) {
    await Promise.all(workers);
  }

  const result = translated.join("").replace(/\n{3,}/g, "\n\n").trim();
  cache.set(cacheKey, {
    text: result,
    createdAt: Date.now()
  });
  return result;
}

async function translateChunk(text) {
  try {
    return await translateChunkWithGoogle(text);
  } catch {
    return translateChunkWithMyMemory(text);
  }
}

async function translateChunkWithGoogle(text) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", "pt-PT");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      "Accept": "application/json",
      ...requestHeaders
    }
  }, translateTimeoutMs);
  const payload = await response.json();

  if (!response.ok || !Array.isArray(payload?.[0])) {
    throw new Error(`A tradução respondeu com HTTP ${response.status}.`);
  }

  return payload[0]
    .map((segment) => Array.isArray(segment) ? segment[0] : "")
    .join("")
    .trim();
}

async function translateChunkWithMyMemory(text) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|pt-PT");

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      "Accept": "application/json",
      ...requestHeaders
    }
  }, translateTimeoutMs);
  const payload = await response.json();

  if (!response.ok || Number(payload.responseStatus || 200) >= 400) {
    throw new Error(payload.responseDetails || `A tradução respondeu com HTTP ${response.status}.`);
  }

  return decodeHtmlEntities(payload.responseData?.translatedText || text).trim();
}

function translationCacheKey(text) {
  return `translate:${crypto.createHash("sha1").update(String(text || "")).digest("hex")}`;
}

function splitForTranslation(text, maxLength = 900) {
  const chunks = [];
  const pieces = String(text || "").replace(/\r/g, "").split(/(\n{2,})/);

  pieces.forEach((piece) => {
    if (!piece) {
      return;
    }

    if (/^\n+$/.test(piece)) {
      chunks.push({ text: piece, translate: false });
      return;
    }

    splitParagraph(piece, maxLength).forEach((part) => {
      chunks.push({ text: part, translate: true });
    });
  });

  return chunks;
}

function splitParagraph(text, maxLength) {
  const paragraph = String(text || "").replace(/[ \t]+/g, " ").trim();
  const parts = [];
  let remaining = paragraph;

  while (remaining.length > maxLength) {
    let splitAt = Math.max(
      remaining.lastIndexOf(". ", maxLength),
      remaining.lastIndexOf("! ", maxLength),
      remaining.lastIndexOf("? ", maxLength),
      remaining.lastIndexOf("; ", maxLength),
      remaining.lastIndexOf(", ", maxLength),
      remaining.lastIndexOf(" ", maxLength)
    );

    if (splitAt < Math.floor(maxLength * 0.55)) {
      splitAt = maxLength;
    }

    parts.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function htmlToReadableText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|blockquote|li)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstLine(value) {
  const line = String(value || "").split("\n").map((part) => part.trim()).find(Boolean) || "Publicação do Facebook";
  return line.length > 96 ? `${line.slice(0, 95).trim()}...` : line;
}

function cleanupFacebookText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupArticleText(text) {
  return decodeHtmlEntities(String(text || ""))
    .replace(/obs_ads\.queue_slot\([\s\S]*?(?:\);|\n{2,}|$)/gi, "\n\n")
    .replace(/\b(?:googletag|pbjs|dataLayer)\.[\s\S]*?(?:;|\n{2,}|$)/gi, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line
      && !/^VER NO FACEBOOK$/i.test(line)
      && !isArticleActionLine(line)
      && !/(obs_ads|queue_slot|web_article_middle|paywall_hide|script_id|"bidder"|"supplyType")/i.test(line))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isArticleActionLine(line) {
  const normalized = String(line || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /^(?:0|-->|-|Partilhar notícia|Partilhar no Facebook|Partilhar no WhatsApp|Partilhar no Messenger|Partilhar no Twitter|Partilhar no LinkedIn|Partilhar no Pinterest|Partilhar no Threads|Partilhar no Bluesky|Enviar por email|Copiar Link|Guardar|Comentar|Alertas|Benefícios exclusivos\?|TORNE-SE PREMIUM)$/i.test(normalized);
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${String(value || "").replace(/"/g, "\\\"")}"`);
  } catch {
    return String(value || "")
      .replace(/\\\//g, "/")
      .replace(/\\n/g, "\n")
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  }
}

function extractMetaContent(html, property) {
  const metaPattern = /<meta\b[^>]*>/gi;
  const expected = String(property || "").toLowerCase();
  let match;

  while ((match = metaPattern.exec(html))) {
    const tag = match[0];
    const propertyMatch = tag.match(/\b(?:property|name)=["']([^"']+)["']/i);
    if (!propertyMatch || propertyMatch[1].toLowerCase() !== expected) {
      continue;
    }

    const contentMatch = tag.match(/\bcontent=["']([^"']*)["']/i);
    if (contentMatch) {
      return decodeHtmlEntities(contentMatch[1]);
    }
  }

  return "";
}

function extractMetaImage(html, baseUrl) {
  const candidates = [
    extractMetaContent(html, "og:image:secure_url"),
    extractMetaContent(html, "og:image"),
    extractMetaContent(html, "twitter:image:src"),
    extractMetaContent(html, "twitter:image"),
    extractLinkHref(html, "image_src")
  ];

  return uniqueStrings(candidates
    .map((url) => String(url || "").trim())
    .filter(Boolean)
    .map((url) => toAbsoluteUrl(url, baseUrl))
    .filter(isUsableImageUrl))[0] || "";
}

function extractLinkHref(html, expectedRel) {
  const linkPattern = /<link\b[^>]*>/gi;
  const expected = String(expectedRel || "").toLowerCase();
  let match;

  while ((match = linkPattern.exec(html))) {
    const tag = match[0];
    const relMatch = tag.match(/\brel=["']([^"']+)["']/i);
    const rels = relMatch ? relMatch[1].toLowerCase().split(/\s+/) : [];
    if (!rels.includes(expected)) {
      continue;
    }

    const hrefMatch = tag.match(/\bhref=["']([^"']*)["']/i);
    if (hrefMatch) {
      return decodeHtmlEntities(hrefMatch[1]);
    }
  }

  return "";
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    Aacute: "Á",
    Acirc: "Â",
    Agrave: "À",
    Aring: "Å",
    Atilde: "Ã",
    Auml: "Ä",
    Ccedil: "Ç",
    Eacute: "É",
    Ecirc: "Ê",
    Egrave: "È",
    Euml: "Ë",
    Iacute: "Í",
    Icirc: "Î",
    Igrave: "Ì",
    Iuml: "Ï",
    Ntilde: "Ñ",
    Oacute: "Ó",
    Ocirc: "Ô",
    Ograve: "Ò",
    Otilde: "Õ",
    Ouml: "Ö",
    Uacute: "Ú",
    Ucirc: "Û",
    Ugrave: "Ù",
    Uuml: "Ü",
    amp: "&",
    aacute: "á",
    acirc: "â",
    agrave: "à",
    aring: "å",
    atilde: "ã",
    auml: "ä",
    apos: "'",
    ccedil: "ç",
    eacute: "é",
    ecirc: "ê",
    egrave: "è",
    eth: "ð",
    euml: "ë",
    gt: ">",
    hellip: "...",
    iacute: "í",
    icirc: "î",
    igrave: "ì",
    iuml: "ï",
    laquo: "<<",
    ldquo: "\"",
    lsquo: "'",
    lt: "<",
    mdash: "-",
    nbsp: " ",
    ndash: "-",
    ntilde: "ñ",
    oacute: "ó",
    ocirc: "ô",
    ograve: "ò",
    otilde: "õ",
    ouml: "ö",
    quot: "\"",
    raquo: ">>",
    rdquo: "\"",
    rsquo: "'",
    uacute: "ú",
    ucirc: "û",
    ugrave: "ù",
    uuml: "ü",
    yacute: "ý",
    yuml: "ÿ"
  };

  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => namedEntities[name] || namedEntities[name.toLowerCase()] || entity);
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeCdata(value) {
  return String(value || "").replaceAll("]]>", "]]]]><![CDATA[>");
}

function toAbsoluteUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return "";
  }
}

function originForUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/`;
  } catch {
    return "";
  }
}

function isFacebookAssetUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)fbsbx\.com$/i.test(parsed.hostname) || /(^|\.)fbcdn\.net$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isUsableImageUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/api/settings") {
    if (req.method === "GET") {
      try {
        sendJson(res, 200, await readSharedSettings());
      } catch (error) {
        sendJson(res, 500, { error: error.message || "Não foi possível ler a configuração." });
      }
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Usa POST para gravar a configuração." });
      return;
    }

    try {
      const payload = JSON.parse(await readRequestBody(req, 256 * 1024));
      sendJson(res, 200, await writeSharedSettings(payload));
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Não foi possível gravar a configuração." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/news") {
    try {
      sendJson(res, 200, await readCachedNews({
        url: requestUrl.searchParams.get("url") || "",
        group: requestUrl.searchParams.get("group") || ""
      }));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Não foi possível ler a cache de notícias." });
    }
    return;
  }

  if (["/widget.json", "/api/widget", "/api/widget.json"].includes(requestUrl.pathname)) {
    try {
      sendCachedJson(res, 200, await buildWidgetPayload());
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Não foi possível preparar o widget." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/refresh") {
    try {
      sendJson(res, 200, await refreshCachedFeeds({
        url: requestUrl.searchParams.get("url") || "",
        group: requestUrl.searchParams.get("group") || "",
        force: requestUrl.searchParams.get("force") === "1"
      }));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Não foi possível atualizar a cache." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/rss") {
    const feedUrl = requestUrl.searchParams.get("url");

    try {
      const parsed = new URL(feedUrl || "");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        sendJson(res, 400, { error: "Indica um URL RSS válido." });
        return;
      }

      const feed = await fetchCachedFeed(parsed.toString());
      send(res, 200, feed.body, feed.contentType);
    } catch (error) {
      sendJson(res, 502, { error: error.message || "Não foi possível ler o RSS." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/discover") {
    const siteUrl = requestUrl.searchParams.get("url");

    try {
      const parsed = new URL(siteUrl || "");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        sendJson(res, 400, { error: "Indica um URL válido." });
        return;
      }

      const feed = await discoverFeed(parsed.toString());
      sendJson(res, 200, {
        url: feed.url,
        title: feed.title,
        discovered: feed.discovered
      });
    } catch (error) {
      sendJson(res, 502, { error: error.message || "Não foi possível encontrar RSS neste site." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/article") {
    const articleUrl = requestUrl.searchParams.get("url");

    try {
      const parsed = new URL(articleUrl || "");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        sendJson(res, 400, { error: "Indica um URL de notícia válido." });
        return;
      }

      const article = await fetchArticle(parsed.toString());
      sendJson(res, 200, article);
    } catch (error) {
      sendJson(res, 502, { error: error.message || "Não foi possível ler a notícia." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/translate") {
    if (req.method === "GET") {
      try {
        const translated = await translateToPortuguese({
          title: requestUrl.searchParams.get("title") || "",
          text: requestUrl.searchParams.get("text") || ""
        });
        sendJson(res, 200, translated);
      } catch (error) {
        sendJson(res, 502, { error: error.message || "Não foi possível traduzir." });
      }
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Usa POST para traduzir." });
      return;
    }

    try {
      const payload = JSON.parse(await readRequestBody(req));
      const translated = await translateToPortuguese({
        title: payload.title,
        text: payload.text
      });
      sendJson(res, 200, translated);
    } catch (error) {
      sendJson(res, 502, { error: error.message || "Não foi possível traduzir." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/image") {
    const imageUrl = requestUrl.searchParams.get("url");

    try {
      const parsed = new URL(imageUrl || "");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        sendJson(res, 400, { error: "Indica um URL de imagem válido." });
        return;
      }

      const image = await fetchImage(parsed.toString());
      sendBuffer(res, 200, image.body, image.contentType);
    } catch (error) {
      sendJson(res, 502, { error: error.message || "Não foi possível carregar a imagem." });
    }
    return;
  }

  const filePath = safeStaticPath(decodeURIComponent(requestUrl.pathname));
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }

    const type = contentTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`RSS app: http://localhost:${port}`);
  });
}

module.exports = {
  buildWidgetPayload,
  discoverFeed,
  fetchCachedFeed,
  fetchArticle,
  fetchFeed,
  fetchImage,
  readCachedNews,
  readSharedSettings,
  refreshCachedFeeds,
  setSettingsStoreFactory,
  translateToPortuguese,
  writeSharedSettings
};
