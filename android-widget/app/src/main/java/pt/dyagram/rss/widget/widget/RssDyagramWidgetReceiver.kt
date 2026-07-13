package pt.dyagram.rss.widget.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

class RssDyagramWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = RssDyagramWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        WidgetSyncWorker.ensurePeriodic(context)
        WidgetSyncWorker.enqueueNow(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        WidgetSyncWorker.cancel(context)
    }
}
