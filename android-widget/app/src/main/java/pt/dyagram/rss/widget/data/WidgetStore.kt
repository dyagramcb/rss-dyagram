package pt.dyagram.rss.widget.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object WidgetStore {
    private const val PREFS_NAME = "rss_dyagram_widget"
    private const val DATA_KEY = "widget_payload"
    private const val READ_KEY = "read_urls"

    fun load(context: Context): WidgetData {
        val raw = prefs(context).getString(DATA_KEY, "").orEmpty()
        if (raw.isBlank()) return WidgetData()

        return runCatching { parse(JSONObject(raw)) }.getOrDefault(WidgetData())
    }

    fun save(context: Context, data: WidgetData) {
        prefs(context).edit().putString(DATA_KEY, serialize(data).toString()).apply()
    }

    fun readUrls(context: Context): Set<String> =
        prefs(context).getStringSet(READ_KEY, emptySet()).orEmpty().toSet()

    fun markRead(context: Context, url: String) {
        val values = readUrls(context).toMutableSet()
        values += url
        prefs(context).edit().putStringSet(READ_KEY, values.toList().takeLast(500).toSet()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun parse(json: JSONObject): WidgetData {
        val itemsJson = json.optJSONArray("items") ?: JSONArray()
        val items = buildList {
            for (index in 0 until itemsJson.length()) {
                val item = itemsJson.optJSONObject(index) ?: continue
                val url = item.optString("url")
                if (url.isBlank()) continue

                add(
                    WidgetStory(
                        id = item.optString("id"),
                        title = item.optString("title", "Sem título"),
                        description = item.optString("description"),
                        source = item.optString("source", "Rss Dyagram"),
                        group = item.optString("group"),
                        url = url,
                        appUrl = item.optString("appUrl"),
                        publishedAt = item.optString("publishedAt")
                    )
                )
            }
        }

        return WidgetData(
            updatedAt = json.optString("updatedAt"),
            generatedAt = json.optString("generatedAt"),
            items = items
        )
    }

    private fun serialize(data: WidgetData): JSONObject = JSONObject().apply {
        put("updatedAt", data.updatedAt)
        put("generatedAt", data.generatedAt)
        put("items", JSONArray().apply {
            data.items.forEach { item ->
                put(JSONObject().apply {
                    put("id", item.id)
                    put("title", item.title)
                    put("description", item.description)
                    put("source", item.source)
                    put("group", item.group)
                    put("url", item.url)
                    put("appUrl", item.appUrl)
                    put("publishedAt", item.publishedAt)
                })
            }
        })
    }
}
