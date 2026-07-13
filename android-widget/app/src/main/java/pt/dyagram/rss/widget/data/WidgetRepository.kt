package pt.dyagram.rss.widget.data

import android.content.Context
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

object WidgetRepository {
    private const val ENDPOINT = "https://rss-dyagram.netlify.app/widget.json"
    private const val REFRESH_ENDPOINT = "https://rss-dyagram.netlify.app/api/widget-refresh"

    fun refresh(context: Context, forceRemote: Boolean = false): WidgetData {
        val endpoint = if (forceRemote) {
            "$REFRESH_ENDPOINT?t=${System.currentTimeMillis()}"
        } else {
            ENDPOINT
        }
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = if (forceRemote) 20_000 else 12_000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "RssDyagramWidget/1.0")
            if (forceRemote) {
                useCaches = false
                setRequestProperty("Cache-Control", "no-cache")
            }
        }

        try {
            if (connection.responseCode !in 200..299) {
                throw IOException("O servidor respondeu com HTTP ${connection.responseCode}")
            }

            val payload = connection.inputStream.bufferedReader().use { it.readText() }
            val data = parse(JSONObject(payload))
            WidgetStore.save(context, data)
            return data
        } finally {
            connection.disconnect()
        }
    }

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
}
