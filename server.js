const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let getBlobStore = null;

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
const cache = new Map();
const cacheTtlMs = 5 * 60 * 1000;
const feedTimeoutMs = 8 * 1000;
const imageTimeoutMs = 8 * 1000;
const articleTimeoutMs = 10 * 1000;
const discoverTimeoutMs = 10 * 1000;
const translateTimeoutMs = 8 * 1000;
const translationCacheTtlMs = 30 * 60 * 1000;
const maxTranslationChars = 6000;
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
  return Boolean(getBlobStore && (process.env.NETLIFY || process.env.NETLIFY_SITE_ID));
}

function getSettingsStore() {
  return getBlobStore("rss-dyagram");
}

function emptySettings() {
  return {
    feeds: [],
    groups: [],
    updatedAt: ""
  };
}

function sanitizeSettings(payload = {}) {
  const feeds = uniqueFeedsPayload(Array.isArray(payload.feeds) ? payload.feeds : []);
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
    if (!normalized.url || seen.has(normalized.url)) {
      return;
    }

    seen.add(normalized.url);
    result.push(normalized);
  });

  return result.slice(0, 500);
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
  const pageUrl = toMbasicFacebookUrl(feedUrl);
  const response = await fetchWithTimeout(pageUrl, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    }
  }, feedTimeoutMs);

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`O Facebook respondeu com HTTP ${response.status}.`);
  }

  const pageTitle = extractMetaContent(html, "og:title") || "Facebook";
  const posts = parseFacebookPagePosts(html, feedUrl);
  const body = facebookPostsToRss({
    title: pageTitle.replace(/\s*\|.*$/, "").trim() || pageTitle,
    link: feedUrl,
    description: extractMetaContent(html, "og:description") || "",
    posts
  });

  return {
    body,
    contentType: "application/rss+xml; charset=utf-8",
    createdAt: Date.now(),
    status: response.status
  };
}

function parseFacebookPagePosts(html, pageUrl) {
  const postMatches = [...html.matchAll(/"post_id":"(\d+)"/g)];
  const posts = [];
  const seen = new Set();

  for (const match of postMatches) {
    const postId = match[1];
    if (seen.has(postId)) {
      continue;
    }

    seen.add(postId);
    const windowHtml = html.slice(Math.max(0, match.index - 5000), match.index + 30000);
    const message = extractFacebookMessage(windowHtml);
    const postUrl = extractFacebookPostUrl(windowHtml, pageUrl, postId);

    if (!message || !postUrl) {
      continue;
    }

    const timestamp = firstParsedNumber(windowHtml, [/"creation_time":(\d+)/i]) || Math.floor(Date.now() / 1000);
    const interactions = parseFacebookInteractions(windowHtml);
    posts.push({
      id: postId,
      title: firstLine(message),
      description: message,
      link: postUrl,
      image: extractFacebookPostImage(windowHtml),
      date: new Date(timestamp * 1000).toUTCString(),
      likes: interactions.likes,
      shares: interactions.shares,
      comments: interactions.comments
    });

    if (posts.length >= 25) {
      break;
    }
  }

  return posts;
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
        <pubDate>${escapeXml(post.date)}</pubDate>
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
    parsed.protocol = "https:";
    parsed.hostname = "www.facebook.com";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = `/${parsed.pathname.replace(/^\/+|\/+$/g, "")}`;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return feedUrl;
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
  const entryHtml = extractClassBlock(html, "entry-content") || extractClassBlock(html, "post-content") || "";
  const featuredHtml = extractClassBlock(html, "post-thumbnail");
  const metaImage = extractMetaImage(html, articleUrl);
  const images = uniqueStrings([metaImage, ...extractImages(entryHtml, articleUrl)]);
  const featuredImage = extractImages(featuredHtml, articleUrl)[0] || metaImage || images[0] || "";
  const text = cleanupArticleText(htmlToReadableText(entryHtml));
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
      message: comments === null
        ? "A fonte publica o artigo, mas não expõe contagens públicas de gostos ou partilhas."
        : ""
    }
  };
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
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^VER NO FACEBOOK$/i.test(line))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "...",
    laquo: "<<",
    ldquo: "\"",
    lsquo: "'",
    lt: "<",
    mdash: "-",
    nbsp: " ",
    ndash: "-",
    quot: "\"",
    raquo: ">>",
    rdquo: "\"",
    rsquo: "'"
  };

  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => namedEntities[name.toLowerCase()] || entity);
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

  if (requestUrl.pathname === "/api/rss") {
    const feedUrl = requestUrl.searchParams.get("url");

    try {
      const parsed = new URL(feedUrl || "");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        sendJson(res, 400, { error: "Indica um URL RSS válido." });
        return;
      }

      const feed = await fetchFeed(parsed.toString());
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
  discoverFeed,
  fetchArticle,
  fetchFeed,
  fetchImage,
  readSharedSettings,
  translateToPortuguese,
  writeSharedSettings
};
