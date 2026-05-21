const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");
const api = require("../../server");

api.setSettingsStoreFactory(() => getStore("rss-dyagram"));

const handler = async () => {
  try {
    const result = await api.refreshCachedFeeds({
      maxRegular: 8,
      maxFacebook: 1,
      budgetMs: 9000
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify(result)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        error: error.message || "Não foi possível sincronizar feeds."
      })
    };
  }
};

exports.handler = schedule("*/30 * * * *", handler);
