package pt.dyagram.rss.widget.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.itemsIndexed
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider as DayNightColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.layout.wrapContentHeight
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import pt.dyagram.rss.widget.MainActivity
import pt.dyagram.rss.widget.R
import pt.dyagram.rss.widget.data.WidgetData
import pt.dyagram.rss.widget.data.WidgetStore
import pt.dyagram.rss.widget.data.WidgetStory
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RssDyagramWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = WidgetStore.load(context)
        val readUrls = WidgetStore.readUrls(context)

        provideContent {
            WidgetContent(context, data, readUrls)
        }
    }
}

@Composable
private fun WidgetContent(context: Context, data: WidgetData, readUrls: Set<String>) {
    val unreadCount = data.items.count { it.url !in readUrls }
    val stories = data.items.take(50)

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(DayNightColorProvider(Color.White, Ink))
            .cornerRadius(18.dp)
            .padding(14.dp)
    ) {
        Header(context, unreadCount)
        Spacer(GlanceModifier.height(10.dp))

        if (stories.isEmpty()) {
            EmptyState()
        } else {
            LazyColumn(
                modifier = GlanceModifier
                    .fillMaxWidth()
                    .defaultWeight()
            ) {
                itemsIndexed(stories) { index, story ->
                    Column {
                        StoryRow(context, story, story.url in readUrls)
                        if (index < stories.lastIndex) {
                            Divider()
                        }
                    }
                }
            }
        }

        Text(
            text = "${stories.size} notícias · ${updateLabel(data)}",
            style = TextStyle(
                color = DayNightColorProvider(Muted, MutedDark),
                fontSize = 9.sp
            ),
            maxLines = 1
        )
    }
}

@Composable
private fun Header(context: Context, unreadCount: Int) {
    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .clickable(actionStartActivity(siteIntent(context))),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = GlanceModifier
                .size(36.dp)
                .background(AccentProvider)
                .cornerRadius(10.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "RD",
                style = TextStyle(
                    color = ColorProvider(Color.White),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold
                )
            )
        }
        Spacer(GlanceModifier.width(10.dp))
        Column {
            Text(
                text = "Rss Dyagram",
                style = TextStyle(
                    color = DayNightColorProvider(Ink, Color.White),
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold
                ),
                maxLines = 1
            )
            Text(
                text = "$unreadCount por ler",
                style = TextStyle(
                    color = AccentProvider,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium
                ),
                maxLines = 1
            )
        }
        Spacer(GlanceModifier.defaultWeight())
        Image(
            provider = ImageProvider(R.drawable.ic_refresh),
            contentDescription = "Atualizar",
            modifier = GlanceModifier
                .size(32.dp)
                .padding(5.dp)
                .clickable(actionRunCallback<RefreshAction>())
        )
    }
}

@Composable
private fun StoryRow(context: Context, story: WidgetStory, isRead: Boolean) {
    Column(
        modifier = GlanceModifier
            .fillMaxWidth()
            .wrapContentHeight()
            .clickable(actionStartActivity(storyIntent(context, story)))
            .padding(vertical = 8.dp)
    ) {
        Text(
            text = metadataLabel(story),
            style = TextStyle(
                color = if (isRead) DayNightColorProvider(Muted, MutedDark) else AccentProvider,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold
            ),
            maxLines = 1
        )
        Spacer(GlanceModifier.height(3.dp))
        Text(
            text = story.title,
            style = TextStyle(
                color = if (isRead) DayNightColorProvider(Muted, MutedDark) else DayNightColorProvider(Ink, Color.White),
                fontSize = 12.sp,
                fontWeight = if (isRead) FontWeight.Normal else FontWeight.Bold
            ),
            maxLines = 2
        )
        if (story.description.isNotBlank()) {
            Spacer(GlanceModifier.height(3.dp))
            Text(
                text = story.description,
                style = TextStyle(
                    color = DayNightColorProvider(Muted, MutedDark),
                    fontSize = 10.sp
                ),
                maxLines = 2
            )
        }
    }
}

private fun metadataLabel(story: WidgetStory): String {
    val parts = listOf(
        story.source.uppercase(Locale.getDefault()),
        story.group,
        publishedLabel(story.publishedAt)
    ).filter { it.isNotBlank() }

    return parts.joinToString(" · ")
}

private fun publishedLabel(value: String): String {
    if (value.isBlank()) return ""

    return runCatching {
        val input = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
        val date = input.parse(value.take(19)) ?: return ""
        SimpleDateFormat("dd/MM HH:mm", Locale.forLanguageTag("pt-PT")).format(date)
    }.getOrDefault("")
}

@Composable
private fun Divider() {
    Box(
        modifier = GlanceModifier
            .fillMaxWidth()
            .height(1.dp)
            .background(DayNightColorProvider(Line, LineDark))
    ) {}
}

@Composable
private fun EmptyState() {
    Column(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "A preparar as notícias...",
            style = TextStyle(
                color = DayNightColorProvider(Muted, MutedDark),
                fontSize = 12.sp
            )
        )
        Text(
            text = "Toque em atualizar",
            style = TextStyle(color = AccentProvider, fontSize = 11.sp)
        )
    }
}

private fun siteIntent(context: Context) = Intent(context, MainActivity::class.java).apply {
    data = Uri.parse("rssdyagram://open")
}

private fun storyIntent(context: Context, story: WidgetStory) = Intent(context, MainActivity::class.java).apply {
    data = Uri.parse("rssdyagram://open?article=${Uri.encode(story.url)}")
    putExtra(MainActivity.EXTRA_ARTICLE_URL, story.url)
    putExtra(MainActivity.EXTRA_APP_URL, story.appUrl)
}

private fun updateLabel(data: WidgetData): String {
    val raw = data.updatedAt.ifBlank { data.generatedAt }
    if (raw.isBlank()) return "Ainda sem sincronização"

    return runCatching {
        val input = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
        val date = input.parse(raw.take(19)) ?: Date()
        "Atualizado ${SimpleDateFormat("dd/MM 'às' HH:mm", Locale.forLanguageTag("pt-PT")).format(date)}"
    }.getOrDefault("Atualizado recentemente")
}

private val Ink = Color(0xFF12111D)
private val Muted = Color(0xFF85838E)
private val MutedDark = Color(0xFFB7B4C2)
private val Line = Color(0xFFE9E8EE)
private val LineDark = Color(0xFF35323F)
private val AccentProvider = DayNightColorProvider(Color(0xFF596CFF), Color(0xFF91A0FF))
