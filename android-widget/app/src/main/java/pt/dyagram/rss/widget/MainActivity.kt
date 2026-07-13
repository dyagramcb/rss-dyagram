package pt.dyagram.rss.widget

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.launch
import pt.dyagram.rss.widget.data.WidgetStore
import pt.dyagram.rss.widget.widget.RssDyagramWidget
import pt.dyagram.rss.widget.widget.WidgetSyncWorker

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WidgetSyncWorker.ensurePeriodic(applicationContext)

        val articleUrl = intent.getStringExtra(EXTRA_ARTICLE_URL)
            ?: intent.data?.getQueryParameter("article")
            ?: ""
        val appUrl = intent.getStringExtra(EXTRA_APP_URL)
            ?: articleUrl.takeIf { it.isNotBlank() }?.let(::readerUrl)
            ?: SITE_URL

        lifecycleScope.launch {
            if (articleUrl.isNotBlank()) {
                WidgetStore.markRead(applicationContext, articleUrl)
                RssDyagramWidget().updateAll(applicationContext)
            }

            openSite(appUrl)
            finish()
        }
    }

    private fun openSite(url: String) {
        val target = runCatching { Uri.parse(url) }.getOrDefault(Uri.parse(SITE_URL))
        startActivity(Intent(Intent.ACTION_VIEW, target))
    }

    private fun readerUrl(articleUrl: String): String =
        "$SITE_URL?article=${Uri.encode(articleUrl)}"

    companion object {
        const val SITE_URL = "https://rss-dyagram.netlify.app/"
        const val EXTRA_ARTICLE_URL = "article_url"
        const val EXTRA_APP_URL = "app_url"
    }
}
