import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("local startup, settings, cold cache, refresh and widget without production access", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rss-dyagram-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const forceStop = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await stopped;
      } finally {
        clearTimeout(forceStop);
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  // A separate directory and an allowlisted environment isolate all writes from real data.
  await cp(path.join(root, "server.js"), path.join(directory, "server.js"));
  await cp(path.join(root, "public"), path.join(directory, "public"), { recursive: true });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const feedUrl = `${base}/test-feed.xml`;
  await writeFile(path.join(directory, "public/test-feed.xml"), `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Local test</title><link>${base}</link><description>Test fixture</description>
<item><title>Temporary article</title><link>${base}/article</link><guid>test-article</guid>
<description>Local test summary.</description><pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`);

  child = spawn(process.execPath, [path.join(directory, "server.js")], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      RSS_DYAGRAM_SITE_URL: base,
      RSS_DYAGRAM_PREMIERES_FEED: feedUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Local server startup timed out")), 5000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Local server exited before startup")));
    child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
  });

  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, { ...options, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, route);
    return response;
  };
  assert.match(await (await request("/")).text(), /Rss Dyagram/i);
  for (const route of ["/app.js", "/styles.css", "/sw.js", "/manifest.webmanifest", "/estreias.xml"]) {
    await (await request(route)).arrayBuffer();
  }
  const settings = await (await request("/api/settings")).json();
  assert.equal(settings.feeds.length, 1);
  assert.equal(settings.feeds[0].url, feedUrl);
  await request("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...settings, groups: [...settings.groups, "Local test"] })
  });
  assert.ok((await (await request("/api/settings")).json()).groups.includes("Local test"));
  const cold = await (await request("/api/news")).json();
  assert.equal(cold.feedsData[0].status, "missing");
  await request(`/api/refresh?url=${encodeURIComponent(feedUrl)}&force=1`, { method: "POST" });
  const news = await (await request("/api/news")).json();
  assert.equal(news.feedsData[0].status, "fulfilled");
  const widget = await (await request("/widget.json")).json();
  assert.equal(widget.items.length, 1);
  assert.equal(widget.items[0].title, "Temporary article");
  assert.equal(widget.unreadWindow, 50);
});
