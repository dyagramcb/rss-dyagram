package pt.dyagram.rss.widget.data

data class WidgetStory(
    val id: String,
    val title: String,
    val source: String,
    val group: String,
    val url: String,
    val appUrl: String,
    val publishedAt: String
)

data class WidgetData(
    val updatedAt: String = "",
    val generatedAt: String = "",
    val items: List<WidgetStory> = emptyList()
)
