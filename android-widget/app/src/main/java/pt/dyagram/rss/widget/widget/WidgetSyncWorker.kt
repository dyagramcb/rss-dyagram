package pt.dyagram.rss.widget.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import pt.dyagram.rss.widget.data.WidgetRepository
import pt.dyagram.rss.widget.data.WidgetStore

class WidgetSyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            WidgetRepository.refresh(applicationContext)
            RssDyagramWidget().updateAll(applicationContext)
            Result.success()
        } catch (_: Exception) {
            if (WidgetStore.load(applicationContext).items.isNotEmpty()) {
                RssDyagramWidget().updateAll(applicationContext)
                Result.success()
            } else {
                Result.retry()
            }
        }
    }

    companion object {
        private const val PERIODIC_WORK = "rss-dyagram-widget-periodic"
        private const val IMMEDIATE_WORK = "rss-dyagram-widget-now"

        private val connectedNetwork = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        fun ensurePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<WidgetSyncWorker>(1, TimeUnit.HOURS)
                .setConstraints(connectedNetwork)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK,
                ExistingPeriodicWorkPolicy.UPDATE,
                request
            )
        }

        fun enqueueNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<WidgetSyncWorker>()
                .setConstraints(connectedNetwork)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_WORK,
                ExistingWorkPolicy.REPLACE,
                request
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
        }
    }
}
