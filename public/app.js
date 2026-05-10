const defaultFeeds = [
  {
    name: "Beira Baixa TV",
    url: "https://www.beirabaixatv.pt/feed",
    group: "Notícias"
  },
  {
    name: "A BOLA",
    url: "https://www.facebook.com/abolapt",
    group: "Desporto"
  },
  {
    name: "Pitchfork",
    url: "https://pitchfork.com/feed/rss",
    group: "Música"
  },
  {
    name: "PÚBLICO",
    url: "http://feeds.feedburner.com/PublicoRSS",
    group: "Cultura"
  }
];

const storageKey = "rss-reader-feeds";
const groupStorageKey = "rss-reader-groups";
const readStorageKey = "rss-reader-read-ids";
const defaultGroup = "Geral";
const groupPrefix = "group:";
const refreshIntervalMs = 10 * 60 * 1000;
const settingsRefreshIntervalMs = 60 * 1000;
const appVersion = "20260510-scoped-read-ids-2";
const initialFeeds = loadFeeds();
const initialGroups = loadGroups(initialFeeds);
const state = {
  feeds: initialFeeds,
  groups: initialGroups,
  expandedGroups: new Set(initialGroups.map(groupKey)),
  readIds: loadReadIds(),
  selectedUrl: "all",
  items: [],
  loading: false,
  activeReaderId: ""
};
let translationRequestId = 0;
let activeTranslationController = null;
let groupManagerInteracted = false;
let imageRenderTimer = 0;
let deferredInstallPrompt = null;
let settingsSyncReady = false;
let settingsSyncTimer = 0;
let settingsSyncInFlight = false;
let hasPendingSettingsSync = false;
let feedRefreshInFlight = false;

const feedList = document.querySelector("#feed-list");
const itemsEl = document.querySelector("#items");
const statusEl = document.querySelector("#status");
const feedCountEl = document.querySelector("#feed-count");
const pageTitleEl = document.querySelector("#page-title");
const sourceFilter = document.querySelector("#source-filter");
const searchInput = document.querySelector("#search");
const addFeedForm = document.querySelector("#add-feed-form");
const feedUrlInput = document.querySelector("#feed-url");
const feedGroupInput = document.querySelector("#feed-group");
const feedGroupsList = document.querySelector("#feed-groups");
const groupCreateForm = document.querySelector("#group-create-form");
const newGroupInput = document.querySelector("#new-group");
const groupManager = document.querySelector("#group-manager");
const groupManagerList = document.querySelector("#group-manager-list");
const refreshAllButton = document.querySelector("#refresh-all");
const resetFeedsButton = document.querySelector("#reset-feeds");
const menuButton = document.querySelector("#menu-button");
const closeDrawerButton = document.querySelector("#close-drawer");
const drawerBackdrop = document.querySelector("#drawer-backdrop");
const searchToggle = document.querySelector("#search-toggle");
const installAppButton = document.querySelector("#install-app");
const markReadButton = document.querySelector("#mark-read");
const reader = document.querySelector("#reader");
const readerBack = document.querySelector("#reader-back");
const readerCount = document.querySelector("#reader-count");
const readerTitle = document.querySelector("#reader-title");
const readerMeta = document.querySelector("#reader-meta");
const readerImage = document.querySelector("#reader-image");
const readerBody = document.querySelector("#reader-body");
const readerSource = document.querySelector("#reader-source");
const readerFacebook = document.querySelector("#reader-facebook");
const readerUnreadButton = document.querySelector("#reader-unread");
const readerUnreadLabel = document.querySelector("#reader-unread-label");
const readerTranslateButton = document.querySelector("#reader-translate");
const readerTranslateLabel = document.querySelector("#reader-translate-label");
const readerLikes = document.querySelector("#reader-likes");
const readerShares = document.querySelector("#reader-shares");
const readerComments = document.querySelector("#reader-comments");
const readerNote = document.querySelector("#reader-note");
const readerTranslationNote = document.querySelector("#reader-translation-note");

function loadFeeds() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    const merged = [...saved, ...defaultFeeds];
    return restoreDefaultFeedGroups(uniqueFeeds(merged));
  } catch {
    return restoreDefaultFeedGroups(uniqueFeeds(defaultFeeds));
  }
}

function saveFeeds(options = {}) {
  localStorage.setItem(storageKey, JSON.stringify(state.feeds.map(normalizeFeed)));
  if (options.sync !== false) {
    queueSettingsSync();
  }
}

function loadGroups(feeds = []) {
  const feedNames = feeds.map((feed) => feed.group);

  try {
    const saved = JSON.parse(localStorage.getItem(groupStorageKey) || "[]");
    return uniqueGroups([...feedNames, ...(Array.isArray(saved) ? saved : [])]);
  } catch {
    return uniqueGroups(feedNames);
  }
}

function saveGroups(options = {}) {
  localStorage.setItem(groupStorageKey, JSON.stringify(state.groups));
  if (options.sync !== false) {
    queueSettingsSync();
  }
}

async function loadSharedSettings(options = {}) {
  if (hasPendingSettingsSync || settingsSyncInFlight) {
    return false;
  }

  try {
    const response = await fetch(`/api/settings?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }

    const settings = await response.json();
    const sharedFeeds = uniqueFeeds(Array.isArray(settings.feeds) ? settings.feeds : []);
    const sharedGroups = uniqueGroups(Array.isArray(settings.groups) ? settings.groups : []);
    const previousFeedKey = settingsFingerprint(state.feeds, state.groups);

    if (settings.updatedAt) {
      state.feeds = sharedFeeds;
      state.groups = uniqueGroups([
        ...sharedGroups,
        ...sharedFeeds.map((feed) => feed.group)
      ]);
    } else {
      state.feeds = uniqueFeeds([...sharedFeeds, ...state.feeds]);
      state.groups = uniqueGroups([
        ...sharedGroups,
        ...state.groups,
        ...state.feeds.map((feed) => feed.group)
      ]);
    }
    state.feeds.forEach((feed) => state.expandedGroups.add(groupKey(feed.group)));

    const changed = previousFeedKey !== settingsFingerprint(state.feeds, state.groups);
    if (changed) {
      saveFeeds({ sync: false });
      saveGroups({ sync: false });
      if (options.render !== false) {
        render();
      }
    }

    return changed;
  } catch {
    return false;
  }
}

function queueSettingsSync() {
  if (!settingsSyncReady) {
    return;
  }

  hasPendingSettingsSync = true;
  window.clearTimeout(settingsSyncTimer);
  settingsSyncTimer = window.setTimeout(syncSettingsToServer, 350);
}

async function syncSettingsToServer() {
  if (settingsSyncInFlight) {
    hasPendingSettingsSync = true;
    return;
  }

  settingsSyncInFlight = true;
  hasPendingSettingsSync = false;

  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        feeds: managedFeeds(),
        groups: state.groups
      })
    });

    if (!response.ok) {
      throw new Error("Sync failed");
    }
  } catch {
    hasPendingSettingsSync = true;
    window.clearTimeout(settingsSyncTimer);
    settingsSyncTimer = window.setTimeout(syncSettingsToServer, 5000);
  } finally {
    settingsSyncInFlight = false;
  }
}

function settingsFingerprint(feeds, groups) {
  return JSON.stringify({
    feeds: uniqueFeeds(feeds).map(normalizeFeed).sort((a, b) => a.url.localeCompare(b.url)),
    groups: uniqueGroups(groups).sort((a, b) => a.localeCompare(b, "pt-PT"))
  });
}

function loadReadIds() {
  try {
    const saved = JSON.parse(localStorage.getItem(readStorageKey) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

function saveReadIds() {
  localStorage.setItem(readStorageKey, JSON.stringify([...state.readIds]));
}

function uniqueFeeds(feeds) {
  const seen = new Set();
  return feeds.map(normalizeFeed).filter((feed) => {
    const key = feedUrlKey(feed.url);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function restoreDefaultFeedGroups(feeds) {
  const defaultByUrl = new Map(defaultFeeds.map((feed) => {
    const normalized = normalizeFeed(feed);
    return [feedUrlKey(normalized.url), normalized];
  }));

  return feeds.map((feed) => {
    const defaultFeed = defaultByUrl.get(feedUrlKey(feed.url));
    if (!defaultFeed || groupKey(feed.group) !== groupKey(defaultGroup)) {
      return feed;
    }

    return { ...feed, group: defaultFeed.group };
  });
}

function uniqueGroups(groups) {
  const seen = new Set();
  return groups.map(normalizeGroup).filter((group) => {
    const key = groupKey(group);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeFeed(feed) {
  return {
    name: String(feed.name || "Novo RSS").trim() || "Novo RSS",
    url: String(feed.url || "").trim(),
    group: normalizeGroup(feed.group)
  };
}

function normalizeGroup(value) {
  return String(value || defaultGroup).trim() || defaultGroup;
}

function groupKey(value) {
  return normalizeGroup(value).toLocaleLowerCase("pt-PT");
}

function feedUrlKey(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    const isFacebook = /(^|\.)facebook\.com$/i.test(parsed.hostname);
    const profileId = parsed.searchParams.get("id");

    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = isFacebook ? "www.facebook.com" : parsed.hostname.toLowerCase();
    parsed.hash = "";

    if (isFacebook) {
      parsed.pathname = `/${parsed.pathname.replace(/^\/+|\/+$/g, "")}`;
      parsed.search = "";
      if (/^\/profile\.php$/i.test(parsed.pathname) && profileId) {
        parsed.searchParams.set("id", profileId);
      }
    }

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}

function sameFeedUrl(left, right) {
  return feedUrlKey(left) === feedUrlKey(right);
}

function matchingGroup(value) {
  const key = groupKey(value);
  return state.groups.find((group) => groupKey(group) === key) || "";
}

function ensureGroup(value) {
  const group = normalizeGroup(value);
  const existing = matchingGroup(group);

  if (existing) {
    return existing;
  }

  state.groups.push(group);
  state.groups = uniqueGroups(state.groups);
  state.expandedGroups.add(groupKey(group));
  saveGroups();
  return group;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function proxiedUrl(url) {
  return `/api/rss?url=${encodeURIComponent(url)}`;
}

function discoverUrl(url) {
  return `/api/discover?url=${encodeURIComponent(url)}`;
}

function imageUrl(url) {
  if (!url || /^(data:|blob:|\/)/i.test(url)) {
    return url || "";
  }

  return `/api/image?url=${encodeURIComponent(url)}`;
}

async function loadAllFeeds() {
  if (feedRefreshInFlight) {
    return false;
  }

  feedRefreshInFlight = true;
  const previousItems = state.items;
  const previousItemKeys = new Set(previousItems.map(itemKey));
  state.loading = true;
  state.feeds = managedFeeds();
  renderSources();
  const feedsToLoad = state.feeds;
  const totalFeeds = feedsToLoad.length;

  if (!totalFeeds) {
    state.loading = false;
    feedRefreshInFlight = false;
    render();
    setStatus("Não há feeds para atualizar.");
    return true;
  }

  setStatus(`A atualizar 0/${totalFeeds} feeds...`);

  try {
    const results = new Array(totalFeeds);
    let completedFeeds = 0;

    await runLimited(feedsToLoad, 4, async (feed, index) => {
      try {
        results[index] = {
          status: "fulfilled",
          value: await loadFeed(feed)
        };
      } catch (error) {
        results[index] = {
          status: "rejected",
          reason: error
        };
      } finally {
        completedFeeds += 1;
        setStatus(`A atualizar ${completedFeeds}/${totalFeeds} feeds...`);
      }
    });

    const items = [];
    const errors = [];

    results.forEach((result, index) => {
      const feed = feedsToLoad[index];

      if (result?.status === "fulfilled") {
        feed.name = result.value.title || feed.name;
        feed.lastLoaded = new Date().toISOString();
        feed.error = "";
        items.push(...result.value.items);
      } else {
        const message = result?.reason?.message || "Não foi possível ler o RSS.";
        feed.error = message;
        errors.push(`${feed.name}: ${message}`);
      }
    });

    state.items = mergeKnownItemData(
      uniqueItems(items).sort((a, b) => b.timestamp - a.timestamp),
      previousItems
    );
    syncFeedsFromItems();
    const newItems = state.items.filter((item) => !previousItemKeys.has(itemKey(item)));
    syncMissingImages(newItems.length ? newItems : state.items, {
      maxItems: newItems.length ? Number.POSITIVE_INFINITY : 24
    });
    state.feeds = uniqueFeeds(state.feeds);
    state.groups = uniqueGroups([...state.groups, ...state.feeds.map((feed) => feed.group)]);
    state.loading = false;
    saveFeeds();
    saveGroups();
    render();

    if (errors.length) {
      const successfulFeeds = totalFeeds - errors.length;
      const visibleErrors = errors.slice(0, 3).join(" | ");
      const suffix = errors.length > 3 ? ` | +${errors.length - 3} falhas` : "";
      setStatus(`Verificados ${totalFeeds}/${totalFeeds} feeds. Atualizados ${successfulFeeds}. Falharam: ${visibleErrors}${suffix}`, true);
      return false;
    }

    setStatus(`Verificados ${totalFeeds}/${totalFeeds} feeds às ${new Date().toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}.`);
    return true;
  } finally {
    state.loading = false;
    feedRefreshInFlight = false;
  }
}

async function loadFeed(feed) {
  try {
    return await readFeed(feed);
  } catch (error) {
    if (!shouldDiscoverFeed(error)) {
      throw error;
    }

    const discovered = await discoverFeedDetails(feed.url);
    if (!discovered.url || sameFeedUrl(discovered.url, feed.url)) {
      throw error;
    }

    feed.url = discovered.url;
    feed.name = discovered.title || feed.name;
    return readFeed(feed);
  }
}

async function readFeed(feed) {
  const response = await fetch(proxiedUrl(feed.url));
  const text = await response.text();

  if (!response.ok) {
    let message = "Não foi possível ler o RSS.";
    try {
      message = JSON.parse(text).error || message;
    } catch {
      message = text || message;
    }

    throw new Error(message);
  }

  return parseFeed(text, feed);
}

async function discoverFeedDetails(url) {
  const response = await fetch(discoverUrl(url));
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Não encontrei RSS nesse site.");
  }

  return {
    url: data.url || url,
    title: data.title || "Novo RSS",
    discovered: Boolean(data.discovered)
  };
}

function shouldDiscoverFeed(error) {
  return /rss|atom|xml|html|http 403|http 404|não foi possível ler/i.test(error.message || "");
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function itemKey(item) {
  return `${feedUrlKey(item.feedUrl)}:${item.id}`;
}

function activeItem() {
  return state.items.find((candidate) => itemKey(candidate) === state.activeReaderId);
}

function mergeKnownItemData(items, previousItems) {
  const previousByKey = new Map(previousItems.map((item) => [itemKey(item), item]));
  const previousByLink = new Map(previousItems
    .filter((item) => item.link)
    .map((item) => [item.link, item]));

  return items.map((item) => {
    const previous = previousByKey.get(itemKey(item)) || previousByLink.get(item.link);
    if (!previous) {
      return item;
    }

    if (!item.image && previous.image) {
      item.image = previous.image;
    }

    if (previous.fullText && previous.fullText.length > (item.fullText || "").length) {
      item.fullText = previous.fullText;
    }

    item.imageHydrating = false;
    item.imageHydrated = Boolean(item.image) || Boolean(previous.imageHydrated);
    item.articleLoaded = Boolean(previous.articleLoaded);
    item.articleImages = Array.isArray(previous.articleImages) ? previous.articleImages : [];
    item.facebookUrl = previous.facebookUrl || "";
    item.shareTargets = Array.isArray(previous.shareTargets) ? previous.shareTargets : [];
    item.interactions = mergeInteractions(previous.interactions, item.interactions);
    item.interactionsMessage = previous.interactionsMessage || "";
    item.translation = previous.translation || null;
    item.translationError = previous.translationError || "";
    item.showTranslation = Boolean(previous.showTranslation && previous.translation);

    return item;
  });
}

function parseFeed(xmlText, feed) {
  const documentXml = new DOMParser().parseFromString(xmlText, "application/xml");

  if (documentXml.querySelector("parsererror")) {
    throw new Error("A resposta não parece ser RSS/Atom válido.");
  }

  const channel = documentXml.querySelector("channel");
  const title = textOf(channel, "title") || textOf(documentXml, "feed > title") || feed.name;
  const rssItems = [...documentXml.querySelectorAll("item")];
  const atomItems = [...documentXml.querySelectorAll("entry")];
  const entries = rssItems.length ? rssItems : atomItems;
  const items = entries.map((entry) => parseItem(entry, feed, title)).filter(Boolean);

  return { title, items };
}

function parseItem(entry, feed, feedTitle) {
  const title = textOf(entry, "title") || "Sem título";
  const description = textOf(entry, "description") || textOf(entry, "summary") || textOf(entry, "content") || "";
  const link = linkOf(entry) || feed.url;
  const dateText = textOf(entry, "pubDate") || textOf(entry, "updated") || textOf(entry, "published") || "";
  const date = parseFeedDate(dateText);
  const image = imageOf(entry, description);
  const id = textOf(entry, "guid") || link || `${feed.url}-${title}`;
  const fullText = cleanText(description);

  return {
    id,
    feedName: feedTitle || feed.name,
    feedUrl: feed.url,
    feedGroup: normalizeGroup(feed.group),
    title: cleanText(title),
    description: trimText(fullText, 240),
    fullText,
    link,
    image,
    date: date ? date.toISOString() : "",
    timestamp: date ? date.getTime() : 0,
    interactions: feedInteractionsOf(entry),
    articleLoaded: false,
    articleLoading: false,
    articleError: "",
    imageHydrating: false,
    imageHydrated: Boolean(image),
    facebookUrl: "",
    translation: null,
    translationLoading: false,
    translationError: "",
    showTranslation: false
  };
}

function textOf(root, selector) {
  if (!root) {
    return "";
  }

  const found = root.querySelector(selector);
  return found ? found.textContent.trim() : "";
}

function parseFeedDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function linkOf(entry) {
  const link = entry.querySelector("link");
  if (!link) {
    return "";
  }

  return link.getAttribute("href") || link.textContent.trim();
}

function imageOf(entry, html) {
  const enclosure = entry.querySelector("enclosure[type^='image']");
  if (enclosure && enclosure.getAttribute("url")) {
    return enclosure.getAttribute("url");
  }

  const mediaNodes = [
    ...entry.getElementsByTagName("media:content"),
    ...entry.getElementsByTagName("media:thumbnail")
  ];
  const media = mediaNodes.find((node) => node.getAttribute("url"));
  if (media) {
    return media.getAttribute("url");
  }

  const imageMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imageMatch ? decodeHtml(imageMatch[1]) : "";
}

function feedInteractionsOf(entry) {
  const commentsNode = entry.getElementsByTagName("slash:comments")[0] || entry.getElementsByTagName("comments")[0];
  const comments = commentsNode ? numberOrNull(commentsNode.textContent) : null;
  const likesNode = entry.getElementsByTagName("likes")[0];
  const sharesNode = entry.getElementsByTagName("shares")[0];
  const likes = likesNode ? numberOrNull(likesNode.textContent) : null;
  const shares = sharesNode ? numberOrNull(sharesNode.textContent) : null;

  return {
    likes,
    shares,
    comments,
    reactions: likes
  };
}

function cleanText(value) {
  const holder = document.createElement("div");
  holder.innerHTML = value;
  return holder.textContent.replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  const holder = document.createElement("textarea");
  holder.innerHTML = value;
  return holder.value;
}

function trimText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function render() {
  renderSources();
  renderFilters();
  renderItems();
}

function renderSources() {
  feedList.innerHTML = "";
  renderGroupSuggestions();
  renderGroupManager();

  const allButton = sourceButton({
    name: "Todas as fontes",
    url: "all",
    lastLoaded: state.items.length ? new Date().toISOString() : ""
  });
  feedList.append(allButton);

  feedsByGroup().forEach((feeds, group) => {
    if (!feeds.length) {
      return;
    }

    const expanded = isGroupExpanded(group);
    const section = document.createElement("section");
    section.className = `feed-group${expanded ? " expanded" : ""}`;
    section.append(groupButton(group, feeds, expanded));
    if (expanded) {
      feeds.forEach((feed) => section.append(sourceButton(feed, { child: true })));
    }
    feedList.append(section);
  });
}

function sourceButton(feed, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  const active = feed.url === "all"
    ? state.selectedUrl === "all"
    : sameFeedUrl(state.selectedUrl, feed.url);
  button.className = `feed-button${options.child ? " feed-child" : ""}${active ? " active" : ""}`;
  button.dataset.url = feed.url;

  const feedItems = feed.url === "all" ? state.items : state.items.filter((item) => sameFeedUrl(item.feedUrl, feed.url));
  const count = unreadCount(feedItems);
  const meta = feed.error || `${formatUnreadCount(count)} por ler`;
  button.innerHTML = `
    <span>
      <span class="feed-name">${escapeHtml(feed.name)}</span>
      <span class="feed-meta">${escapeHtml(meta)}</span>
    </span>
  `;

  button.addEventListener("click", () => {
    state.selectedUrl = feed.url;
    render();
    closeDrawer();
  });

  return button;
}

function groupButton(group, feeds, expanded) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `feed-button group-button${state.selectedUrl === groupValue(group) ? " active" : ""}`;
  button.dataset.group = group;
  button.setAttribute("aria-expanded", String(expanded));

  const count = unreadCount(state.items.filter((item) => item.feedGroup === group));
  button.innerHTML = `
    <span>
      <span class="feed-name">${escapeHtml(group)}</span>
      <span class="feed-meta">${escapeHtml(formatUnreadCount(count))} por ler · ${feeds.length} fonte${feeds.length === 1 ? "" : "s"}</span>
    </span>
    <span class="group-toggle" aria-hidden="true"></span>
  `;

  button.addEventListener("click", () => {
    toggleGroup(group);
    state.selectedUrl = groupValue(group);
    render();
  });

  return button;
}

function isGroupExpanded(group) {
  return state.expandedGroups.has(groupKey(group));
}

function toggleGroup(group) {
  const key = groupKey(group);
  if (state.expandedGroups.has(key)) {
    state.expandedGroups.delete(key);
    return;
  }

  state.expandedGroups.add(key);
}

function renderGroupSuggestions() {
  feedGroupsList.innerHTML = "";
  state.groups.forEach((group) => feedGroupsList.append(new Option(group)));
}

function renderGroupManager() {
  const wasOpen = groupManager.open;
  groupManagerList.innerHTML = "";

  if (state.groups.length) {
    const groupTitle = document.createElement("div");
    groupTitle.className = "group-manager-section-title";
    groupTitle.textContent = "Mudar nome dos grupos";
    groupManagerList.append(groupTitle);
  }

  state.groups.forEach((group) => {
    const label = document.createElement("label");
    label.className = "group-manager-row group-rename-row";
    label.innerHTML = `
      <span>${escapeHtml(group)}</span>
      <input type="text" value="${escapeAttribute(group)}" data-group-name="${escapeAttribute(group)}" aria-label="Novo nome para ${escapeAttribute(group)}">
    `;
    groupManagerList.append(label);
  });

  const movableFeeds = managedFeeds();

  if (movableFeeds.length) {
    const feedTitle = document.createElement("div");
    feedTitle.className = "group-manager-section-title";
    feedTitle.textContent = "Mover feeds";
    groupManagerList.append(feedTitle);
  }

  movableFeeds.forEach((feed) => {
    const row = document.createElement("div");
    row.className = "group-manager-row feed-edit-row";
    row.innerHTML = `
      <span>${escapeHtml(feed.name)}</span>
      <select data-feed-url="${escapeAttribute(feed.url)}" aria-label="Grupo de ${escapeAttribute(feed.name)}">
        ${groupSelectOptions(feed.group)}
      </select>
      <button class="feed-delete-button" type="button" data-delete-feed-url="${escapeAttribute(feed.url)}" aria-label="Apagar ${escapeAttribute(feed.name)}">
        Apagar
      </button>
    `;
    groupManagerList.append(row);
  });

  groupManager.open = groupManagerInteracted ? wasOpen : false;
}

function managedFeeds() {
  return uniqueFeeds([...state.feeds, ...feedsFromItems(state.items)])
    .sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));
}

function syncFeedsFromItems() {
  const before = state.feeds.length;
  state.feeds = managedFeeds();

  if (state.feeds.length > before) {
    saveFeeds();
  }
}

function feedsFromItems(items) {
  return uniqueFeeds(items.map((item) => ({
    name: item.feedName,
    url: item.feedUrl,
    group: item.feedGroup
  })));
}

function deleteFeed(feedUrl) {
  const feed = managedFeeds().find((candidate) => sameFeedUrl(candidate.url, feedUrl));
  if (!feed) {
    return "";
  }

  const removedItems = state.items.filter((item) => sameFeedUrl(item.feedUrl, feed.url));
  removedItems.forEach((item) => state.readIds.delete(itemKey(item)));
  state.items = state.items.filter((item) => !sameFeedUrl(item.feedUrl, feed.url));
  state.feeds = uniqueFeeds(state.feeds.filter((candidate) => !sameFeedUrl(candidate.url, feed.url)));

  if (sameFeedUrl(state.selectedUrl, feed.url) || (
    isGroupValue(state.selectedUrl) &&
    !state.feeds.some((candidate) => candidate.group === groupFromValue(state.selectedUrl))
  )) {
    state.selectedUrl = "all";
  }

  if (removedItems.some((item) => itemKey(item) === state.activeReaderId)) {
    closeReader();
  }

  saveReadIds();
  saveFeeds();
  return feed.name;
}

function groupSelectOptions(selectedGroup) {
  const selected = matchingGroup(selectedGroup) || normalizeGroup(selectedGroup);
  const options = uniqueGroups([...state.groups, selected]);
  return options.map((group) => `
    <option value="${escapeAttribute(group)}"${groupKey(group) === groupKey(selected) ? " selected" : ""}>${escapeHtml(group)}</option>
  `).join("");
}

function renderFilters() {
  sourceFilter.innerHTML = "";
  sourceFilter.append(new Option("Todas as fontes", "all"));
  feedsByGroup().forEach((feeds, group) => {
    const optGroup = document.createElement("optgroup");
    optGroup.label = group;
    optGroup.append(new Option(`Todas em ${group}`, groupValue(group)));
    feeds.forEach((feed) => optGroup.append(new Option(feed.name, feed.url)));
    sourceFilter.append(optGroup);
  });
  sourceFilter.value = state.selectedUrl;
}

function filteredItems() {
  const query = searchInput.value.trim().toLowerCase();

  return state.items.filter((item) => {
    const sourceMatches = sourceMatchesSelection(item);
    const queryMatches = !query || `${item.title} ${item.description} ${item.fullText} ${item.feedName} ${item.feedGroup}`.toLowerCase().includes(query);
    return sourceMatches && queryMatches;
  });
}

function renderItems() {
  const items = filteredItems();
  const unread = unreadCount(items);
  feedCountEl.textContent = `${formatUnreadCount(unread)} por ler`;
  readerCount.textContent = formatUnreadCount(unreadCount());
  pageTitleEl.textContent = selectedTitle();
  itemsEl.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.loading ? "A carregar notícias..." : "Não há notícias para mostrar.";
    itemsEl.append(empty);
    return;
  }

  items.forEach((item, index) => itemsEl.append(itemCard(item, index)));
  syncMissingImages(items);
}

function itemCard(item, index = 0) {
  const article = document.createElement("article");
  article.className = `item-card${isRead(item) ? " read" : ""}`;
  article.tabIndex = 0;
  article.setAttribute("role", "button");
  article.dataset.id = itemKey(item);
  const date = item.date ? relativeTime(new Date(item.date)) : "sem data";
  const priorityAttribute = index < 6 ? ' fetchpriority="high"' : "";
  const imageMarkup = item.image
    ? `<img class="thumb" src="${escapeAttribute(imageUrl(item.image))}" alt="" decoding="async"${priorityAttribute}>`
    : `<div class="thumb placeholder"><span></span></div>`;

  article.innerHTML = `
    ${imageMarkup}
    <div class="item-content">
      <h3 class="item-title">${escapeHtml(item.title)}</h3>
      <p class="item-description">${escapeHtml(item.description)}</p>
      <div class="item-kicker">
        <span>${escapeHtml(item.feedName)}</span>
        <span>/</span>
        <span>${escapeHtml(date)}</span>
      </div>
      <div class="item-actions">
        <a href="${escapeAttribute(item.link)}" target="_blank" rel="noopener">Abrir notícia</a>
      </div>
    </div>
  `;

  const thumbnail = article.querySelector("img.thumb");
  if (thumbnail) {
    thumbnail.addEventListener("error", () => thumbnail.replaceWith(thumbPlaceholder()), { once: true });
  }

  article.addEventListener("click", () => openReader(itemKey(item)));
  article.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openReader(itemKey(item));
    }
  });

  return article;
}

function thumbPlaceholder() {
  const fallback = document.createElement("div");
  fallback.className = "thumb placeholder";
  fallback.innerHTML = "<span></span>";
  return fallback;
}

function syncMissingImages(items, options = {}) {
  const maxItems = options.maxItems ?? 12;
  const candidates = items
    .filter((item) => !item.image && !item.imageHydrating && !item.imageHydrated && isArticleLink(item.link))
    .slice(0, maxItems);

  if (!candidates.length) {
    return 0;
  }

  candidates.forEach((item) => {
    item.imageHydrating = true;
  });

  hydrateMissingImages(candidates);
  return candidates.length;
}

async function hydrateMissingImages(items) {
  await runLimited(items, 3, async (item) => {
    try {
      const data = await fetchArticleDetails(item.link);
      const hadImage = Boolean(item.image);
      mergeArticleDetails(item, data);

      if (!hadImage && item.image) {
        scheduleItemsRender();
        if (state.activeReaderId === itemKey(item)) {
          renderReader(item);
        }
      }
    } catch {
      // Some sources block article scraping. Keep the RSS item visible with its fallback thumbnail.
    } finally {
      item.imageHydrating = false;
      item.imageHydrated = true;
    }
  });
}

function scheduleItemsRender() {
  if (imageRenderTimer) {
    return;
  }

  imageRenderTimer = window.setTimeout(() => {
    imageRenderTimer = 0;
    renderItems();
  }, 80);
}

async function runLimited(values, limit, worker) {
  let index = 0;
  const workerCount = Math.min(limit, values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < values.length) {
      const currentIndex = index;
      const value = values[index];
      index += 1;
      await worker(value, currentIndex);
    }
  });

  await Promise.all(workers);
}

function isArticleLink(url) {
  return /^https?:\/\//i.test(url || "");
}

function openReader(itemId) {
  const item = state.items.find((candidate) => itemKey(candidate) === itemId);
  if (!item) {
    return;
  }

  cancelActiveTranslation();
  state.items.forEach((candidate) => {
    candidate.translationLoading = false;
  });

  state.activeReaderId = itemId;
  item.showTranslation = false;
  item.translationLoading = false;
  item.translationError = "";

  if (!isRead(item)) {
    setItemRead(item, true);
    render();
  }

  renderReader(item);
  document.querySelector(".reader-article").scrollTop = 0;
  document.body.classList.add("reader-open");
  reader.setAttribute("aria-hidden", "false");

  if (!item.articleLoaded && !item.articleLoading) {
    loadArticleDetails(item);
  }
}

function renderReader(item) {
  const translated = item.showTranslation && item.translation;
  readerTitle.textContent = translated ? item.translation.title || item.title : item.title;
  const readerDate = item.date
    ? new Date(item.date).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" })
    : "sem data";
  readerMeta.textContent = `by ${item.feedName.toLowerCase()} / ${readerDate}`;
  readerBody.textContent = translated
    ? item.translation.text || item.fullText || item.description || "Sem texto disponível no RSS."
    : item.fullText || item.description || "Sem texto disponível no RSS.";
  readerCount.textContent = formatUnreadCount(unreadCount());
  readerUnreadLabel.textContent = isRead(item) ? "Unread" : "Read";
  renderTranslationState(item);
  readerSource.href = item.link;
  readerFacebook.href = item.facebookUrl || "#";
  readerFacebook.hidden = !item.facebookUrl;
  renderInteractionMetrics(item);

  if (item.image) {
    readerImage.src = imageUrl(item.image);
    readerImage.hidden = false;
  } else {
    readerImage.removeAttribute("src");
    readerImage.hidden = true;
  }
}

function renderTranslationState(item) {
  const hasText = Boolean(translationSourceText(item));
  const translated = item.showTranslation && item.translation;

  readerTranslateButton.disabled = !hasText;
  readerTranslateButton.classList.toggle("active", Boolean(translated));
  readerTranslateLabel.textContent = item.translationLoading
    ? "Cancelar"
    : translated ? "Original" : "Traduzir";

  if (item.translationLoading) {
    readerTranslationNote.textContent = "A traduzir do inglês para português...";
  } else if (translated) {
    readerTranslationNote.textContent = item.translation.truncated
      ? "Traduzido para português. O texto foi encurtado para a tradução não ficar presa."
      : "Traduzido para português.";
  } else if (item.translationError) {
    readerTranslationNote.textContent = `Não foi possível traduzir: ${item.translationError}`;
  } else {
    readerTranslationNote.textContent = "";
  }
}

function closeReader() {
  const item = activeItem();
  if (item?.translationLoading) {
    cancelTranslation(item);
  }

  state.activeReaderId = "";
  document.body.classList.remove("reader-open");
  reader.setAttribute("aria-hidden", "true");
}

function isRead(item) {
  return state.readIds.has(itemKey(item));
}

function setItemRead(item, read) {
  const key = itemKey(item);

  if (read) {
    state.readIds.add(key);
  } else {
    state.readIds.delete(key);
  }

  saveReadIds();
}

function unreadCount(items = state.items) {
  return items.filter((item) => !isRead(item)).length;
}

function formatUnreadCount(count) {
  return count > 999 ? "1000+" : String(count);
}

function sourceMatchesSelection(item) {
  if (state.selectedUrl === "all") {
    return true;
  }

  if (isGroupValue(state.selectedUrl)) {
    return item.feedGroup === groupFromValue(state.selectedUrl);
  }

  return sameFeedUrl(item.feedUrl, state.selectedUrl);
}

function selectedTitle() {
  if (state.selectedUrl === "all") {
    return "Newsfeed";
  }

  if (isGroupValue(state.selectedUrl)) {
    return groupFromValue(state.selectedUrl);
  }

  return state.feeds.find((feed) => sameFeedUrl(feed.url, state.selectedUrl))?.name || "Newsfeed";
}

function feedGroups() {
  return state.groups;
}

function feedsByGroup() {
  const groups = new Map();
  state.groups.forEach((group) => groups.set(group, []));

  state.feeds.forEach((feed) => {
    const group = matchingGroup(feed.group) || normalizeGroup(feed.group);
    if (!groups.has(group)) {
      groups.set(group, []);
    }

    groups.get(group).push(feed);
  });

  return groups;
}

function groupValue(group) {
  return `${groupPrefix}${group}`;
}

function isGroupValue(value) {
  return String(value || "").startsWith(groupPrefix);
}

function groupFromValue(value) {
  return String(value || "").slice(groupPrefix.length);
}

function renameGroup(oldName, newName) {
  const current = matchingGroup(oldName);
  const next = normalizeGroup(newName);

  if (!current || groupKey(current) === groupKey(next)) {
    return current || next;
  }

  const existing = matchingGroup(next);
  const finalName = existing || next;

  state.groups = uniqueGroups(state.groups.map((group) => (
    groupKey(group) === groupKey(current) ? finalName : group
  )));

  if (state.expandedGroups.has(groupKey(current))) {
    state.expandedGroups.delete(groupKey(current));
    state.expandedGroups.add(groupKey(finalName));
  }

  state.feeds.forEach((feed) => {
    if (groupKey(feed.group) === groupKey(current)) {
      feed.group = finalName;
    }
  });

  state.items.forEach((item) => {
    if (groupKey(item.feedGroup) === groupKey(current)) {
      item.feedGroup = finalName;
    }
  });

  if (state.selectedUrl === groupValue(current)) {
    state.selectedUrl = groupValue(finalName);
  }

  if (groupKey(feedGroupInput.value) === groupKey(current)) {
    feedGroupInput.value = finalName;
  }

  saveGroups();
  saveFeeds();
  return finalName;
}

function markFilteredItemsRead() {
  filteredItems().forEach((item) => state.readIds.add(itemKey(item)));
  saveReadIds();
  render();

  const item = activeItem();
  if (item) {
    renderReader(item);
  }
}

async function loadArticleDetails(item) {
  item.articleLoading = true;
  item.articleError = "";

  if (state.activeReaderId === itemKey(item)) {
    renderReader(item);
  }

  try {
    const data = await fetchArticleDetails(item.link);
    mergeArticleDetails(item, data);
  } catch (error) {
    item.articleError = error.message || "Não foi possível ler a notícia.";
  } finally {
    item.articleLoading = false;
    if (state.activeReaderId === itemKey(item)) {
      renderReader(item);
    }
  }
}

async function fetchArticleDetails(url) {
  const response = await fetch(`/api/article?url=${encodeURIComponent(url)}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Não foi possível ler a notícia.");
  }

  return data;
}

function mergeArticleDetails(item, data) {
  if (data.text && data.text.length > (item.fullText || "").length) {
    item.fullText = data.text;
    if (!item.translationLoading && !item.showTranslation) {
      clearTranslation(item);
    }
  }

  const articleImages = Array.isArray(data.images) ? data.images : [];
  const bestImage = data.featuredImage || articleImages[0] || "";
  if (!item.image && bestImage) {
    item.image = bestImage;
  }

  item.articleImages = articleImages;
  item.facebookUrl = data.facebookUrl || item.facebookUrl;
  item.shareTargets = Array.isArray(data.shareTargets) ? data.shareTargets : [];
  item.interactions = mergeInteractions(item.interactions, data.interactions);
  item.interactionsMessage = data.interactions?.message || "";
  item.articleLoaded = true;
}

function clearTranslation(item) {
  item.translation = null;
  item.showTranslation = false;
  item.translationError = "";
}

async function toggleReaderTranslation() {
  const item = activeItem();
  if (!item) {
    return;
  }

  if (item.translationLoading) {
    cancelTranslation(item, "Tradução cancelada.");
    renderReader(item);
    return;
  }

  if (item.showTranslation && item.translation) {
    item.showTranslation = false;
    renderReader(item);
    return;
  }

  if (item.translation) {
    item.showTranslation = true;
    renderReader(item);
    return;
  }

  await translateItem(item);
}

async function translateItem(item) {
  const sourceText = translationSourceText(item);
  if (!sourceText) {
    return;
  }

  cancelActiveTranslation();
  const requestId = translationRequestId + 1;
  translationRequestId = requestId;
  item.translationRequestId = requestId;
  item.translationLoading = true;
  item.translationError = "";
  renderReader(item);

  const controller = new AbortController();
  activeTranslationController = controller;

  try {
    const data = await postTranslate({
      title: item.title,
      text: sourceText
    }, controller, 12000);

    if (item.translationRequestId !== requestId) {
      return;
    }

    item.translation = {
      title: data.title || item.title,
      text: data.text || sourceText,
      truncated: Boolean(data.truncated)
    };
    item.showTranslation = true;
  } catch (error) {
    if (item.translationRequestId === requestId) {
      item.translationError = error.message || "A tradução falhou.";
    }
  } finally {
    if (activeTranslationController === controller) {
      activeTranslationController = null;
    }

    if (item.translationRequestId === requestId) {
      item.translationLoading = false;
      if (state.activeReaderId === itemKey(item)) {
        renderReader(item);
      }
    }
  }
}

async function postTranslate(payload, controller, timeoutMs) {
  if ((payload.text || "").length <= 1600 && (payload.title || "").length <= 240) {
    return getTranslate(payload, controller, timeoutMs);
  }

  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("A tradução demorou demasiado. Tenta novamente."));
    }, timeoutMs);
  });
  const requestPromise = fetch("/api/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    cache: "no-store",
    signal: controller.signal,
    body: JSON.stringify(payload)
  }).then(async (response) => {
    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      throw new Error(data.error || "A tradução falhou.");
    }

    return data;
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function getTranslate(payload, controller, timeoutMs) {
  const requestUrl = new URL("/api/translate", window.location.origin);
  requestUrl.searchParams.set("title", payload.title || "");
  requestUrl.searchParams.set("text", payload.text || "");
  requestUrl.searchParams.set("v", `${appVersion}-${Date.now()}`);

  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("A tradução demorou demasiado. Tenta novamente."));
    }, timeoutMs);
  });
  const requestPromise = fetch(requestUrl.toString(), {
    cache: "no-store",
    signal: controller.signal
  }).then(async (response) => {
    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      throw new Error(data.error || "A tradução falhou.");
    }

    return data;
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function cancelTranslation(item, message = "") {
  cancelActiveTranslation();
  item.translationRequestId = ++translationRequestId;
  item.translationLoading = false;
  item.translationError = message;
}

function cancelActiveTranslation() {
  if (activeTranslationController) {
    activeTranslationController.abort();
    activeTranslationController = null;
  }
}

function translationSourceText(item) {
  return (item.description || item.fullText || "").trim();
}

function mergeInteractions(current = {}, incoming = {}) {
  return {
    likes: firstNumber(incoming.likes, current.likes),
    shares: firstNumber(incoming.shares, current.shares),
    comments: firstNumber(incoming.comments, current.comments),
    reactions: firstNumber(incoming.reactions, current.reactions)
  };
}

function renderInteractionMetrics(item) {
  const interactions = item.interactions || {};
  readerLikes.textContent = metricText(interactions.likes, item.articleLoading);
  readerShares.textContent = metricText(interactions.shares, item.articleLoading);
  readerComments.textContent = metricText(interactions.comments, item.articleLoading);

  const hasNumbers = [interactions.likes, interactions.shares, interactions.comments]
    .some((value) => numberOrNull(value) !== null);

  if (item.articleLoading) {
    readerNote.textContent = "A obter texto completo e interações disponíveis...";
    return;
  }

  if (hasNumbers) {
    readerNote.textContent = "";
    return;
  }

  if (item.articleError) {
    readerNote.textContent = `Não foi possível obter o artigo completo: ${item.articleError}`;
    return;
  }

  const shareTargets = item.shareTargets?.length ? ` O site tem botões para ${item.shareTargets.join(" e ")}, mas não publica os totais.` : "";
  readerNote.textContent = `${item.interactionsMessage || "A origem não disponibiliza contagens públicas de gostos, partilhas ou comentários."}${shareTargets}`;
}

function metricText(value, loading) {
  const number = numberOrNull(value);
  if (number !== null) {
    return new Intl.NumberFormat("pt-PT").format(number);
  }

  return loading ? "..." : "n/d";
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) {
      return number;
    }
  }

  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function relativeTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "sem data";
  }

  const diffMs = Date.now() - date.getTime();

  if (diffMs < -60000) {
    return date.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
  }

  const minutes = Math.max(0, Math.floor(diffMs / 60000));

  if (minutes < 1) {
    return "1m";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }

  return date.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

addFeedForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = feedUrlInput.value.trim();
  if (!url) {
    return;
  }

  try {
    new URL(url);
  } catch {
    setStatus("Esse URL não parece válido.", true);
    return;
  }

  setStatus("A procurar RSS ou página de Facebook...");

  let discovered;
  try {
    discovered = await discoverFeedDetails(url);
  } catch (error) {
    setStatus(error.message || "Não encontrei RSS nesse site.", true);
    return;
  }

  const selectedGroup = isGroupValue(state.selectedUrl) ? groupFromValue(state.selectedUrl) : "";
  const group = ensureGroup(feedGroupInput.value || selectedGroup);
  const existingRawFeed = state.feeds.find((feed) => sameFeedUrl(feed.url, url));
  if (existingRawFeed && existingRawFeed.url !== discovered.url) {
    existingRawFeed.url = discovered.url;
    existingRawFeed.name = discovered.title;
    existingRawFeed.group = group;
    state.feeds = uniqueFeeds(state.feeds);
    feedUrlInput.value = "";
    feedGroupInput.value = "";
    saveFeeds();
    setStatus(`RSS encontrado: ${discovered.url}`);
    await loadAllFeeds();
    return;
  }

  if (state.feeds.some((feed) => sameFeedUrl(feed.url, discovered.url))) {
    setStatus("Esse RSS já está na lista.");
    return;
  }

  state.feeds.push({ name: discovered.title, url: discovered.url, group });
  feedUrlInput.value = "";
  feedGroupInput.value = "";
  saveFeeds();
  setStatus(discovered.discovered ? `RSS encontrado: ${discovered.url}` : "RSS adicionado.");
  await loadAllFeeds();
});

groupCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const existed = Boolean(matchingGroup(newGroupInput.value));
  const group = ensureGroup(newGroupInput.value);
  state.expandedGroups.add(groupKey(group));
  newGroupInput.value = "";
  feedGroupInput.value = group;
  state.selectedUrl = groupValue(group);
  setStatus(existed ? `Grupo "${group}" já existe.` : `Grupo "${group}" criado.`);
  render();
});

refreshAllButton.addEventListener("click", refreshAllFeeds);
markReadButton.addEventListener("click", markFilteredItemsRead);

resetFeedsButton.addEventListener("click", async () => {
  localStorage.removeItem(storageKey);
  localStorage.removeItem(groupStorageKey);
  localStorage.removeItem(readStorageKey);
  state.feeds = loadFeeds();
  state.groups = loadGroups(state.feeds);
  state.expandedGroups = new Set(state.groups.map(groupKey));
  state.readIds = loadReadIds();
  state.selectedUrl = "all";
  await loadAllFeeds();
});

sourceFilter.addEventListener("change", () => {
  state.selectedUrl = sourceFilter.value;
  render();
});

groupManager.addEventListener("toggle", async () => {
  groupManagerInteracted = true;
  if (groupManager.open) {
    await loadSharedSettings({ render: true });
    groupManager.open = true;
  }
});

groupManagerList.addEventListener("change", (event) => {
  if (event.target.matches("input[data-group-name]")) {
    groupManagerInteracted = true;
    const oldName = event.target.dataset.groupName;
    const requestedName = normalizeGroup(event.target.value);
    const renamed = renameGroup(oldName, requestedName);
    setStatus(
      groupKey(oldName) === groupKey(renamed)
        ? `Grupo "${renamed}" mantido.`
        : `Grupo "${oldName}" renomeado para "${renamed}".`
    );
    render();
    groupManager.open = true;
    return;
  }

  if (!event.target.matches("select[data-feed-url]")) {
    return;
  }

  groupManagerInteracted = true;
  let feed = state.feeds.find((candidate) => sameFeedUrl(candidate.url, event.target.dataset.feedUrl));
  if (!feed) {
    feed = managedFeeds().find((candidate) => sameFeedUrl(candidate.url, event.target.dataset.feedUrl));
    if (feed) {
      state.feeds.push(feed);
      state.feeds = uniqueFeeds(state.feeds);
    }
  }

  if (!feed) {
    return;
  }

  feed.group = ensureGroup(event.target.value);
  saveFeeds();

  state.items.forEach((item) => {
    if (sameFeedUrl(item.feedUrl, feed.url)) {
      item.feedGroup = feed.group;
    }
  });

  if (isGroupValue(state.selectedUrl) && !feedGroups().includes(groupFromValue(state.selectedUrl))) {
    state.selectedUrl = "all";
  }

  render();
});

groupManagerList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("button[data-delete-feed-url]");
  if (!deleteButton) {
    return;
  }

  groupManagerInteracted = true;
  const feed = managedFeeds().find((candidate) => sameFeedUrl(candidate.url, deleteButton.dataset.deleteFeedUrl));
  if (!feed || !window.confirm(`Apagar o feed "${feed.name}"?`)) {
    return;
  }

  const deletedName = deleteFeed(deleteButton.dataset.deleteFeedUrl);
  if (!deletedName) {
    return;
  }

  setStatus(`Feed "${deletedName}" apagado.`);
  render();
  groupManager.open = true;
});

searchInput.addEventListener("input", renderItems);
menuButton.addEventListener("click", openDrawer);
closeDrawerButton.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
readerBack.addEventListener("click", closeReader);
readerUnreadButton.addEventListener("click", () => {
  const item = activeItem();
  if (!item) {
    return;
  }

  setItemRead(item, !isRead(item));
  render();
  renderReader(item);
});
readerTranslateButton.addEventListener("click", toggleReaderTranslation);
installAppButton?.addEventListener("click", installPwa);
searchToggle.addEventListener("click", () => {
  document.body.classList.toggle("search-open");
  if (document.body.classList.contains("search-open")) {
    searchInput.focus();
  }
});

readerImage.addEventListener("error", () => {
  readerImage.removeAttribute("src");
  readerImage.hidden = true;
});

function openDrawer() {
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  document.body.classList.remove("drawer-open");
}

function initPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;

    if (installAppButton && !isStandaloneApp()) {
      installAppButton.hidden = false;
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;

    if (installAppButton) {
      installAppButton.hidden = true;
      installAppButton.disabled = false;
    }

    setStatus("Rss Dyagram instalada.");
  });
}

async function installPwa() {
  if (!deferredInstallPrompt) {
    return;
  }

  installAppButton.disabled = true;
  deferredInstallPrompt.prompt();

  try {
    await deferredInstallPrompt.userChoice;
  } catch {
    // Some browsers do not expose the install result.
  }

  deferredInstallPrompt = null;
  installAppButton.hidden = true;
  installAppButton.disabled = false;
}

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

initPwa();
startApp();

async function startApp() {
  render();
  await loadSharedSettings({ render: true });
  settingsSyncReady = true;
  await loadAllFeeds();
  window.setInterval(refreshAllFeeds, refreshIntervalMs);
  window.setInterval(refreshSharedSettings, settingsRefreshIntervalMs);
}

async function refreshSharedSettings() {
  const changed = await loadSharedSettings({ render: true });
  if (changed) {
    await loadAllFeeds();
  }
}

async function refreshAllFeeds() {
  await loadSharedSettings({ render: true });
  return loadAllFeeds();
}
