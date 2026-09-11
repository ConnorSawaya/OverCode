package ai.overcode.mobile;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

@CapacitorPlugin(name = "OvercodeUpdater")
public class OvercodeUpdaterPlugin extends Plugin {
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";
    private static final String TRUSTED_UPDATE_HOST = "github.com";
    private static final String TRUSTED_UPDATE_PATH_PREFIX = "/ConnorSawaya/overcode/releases/download/";
    private long activeDownloadId = -1L;
    private File activeFile;
    private boolean waitingForInstallPermission;

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
            if (downloadId != activeDownloadId) return;

            activeDownloadId = -1L;
            DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null || !isSuccessfulDownload(manager, downloadId) || activeFile == null || !activeFile.exists()) {
                notifyListeners("updateDownloadFailed", new JSObject());
                return;
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !context.getPackageManager().canRequestPackageInstalls()) {
                waitingForInstallPermission = true;
                Intent settingsIntent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
                settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(settingsIntent);
                notifyListeners("updateInstallPermissionRequired", new JSObject());
                return;
            }

            launchInstaller(context);
        }
    };

    @Override
    protected void handleOnDestroy() {
        try {
            getContext().unregisterReceiver(downloadReceiver);
        } catch (IllegalArgumentException ignored) {
            // The receiver may already have been removed by the Android lifecycle.
        }
        super.handleOnDestroy();
    }

    @Override
    public void load() {
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        ContextCompat.registerReceiver(
                getContext(),
                downloadReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnResume() {
        if (waitingForInstallPermission
                && activeFile != null
                && activeFile.exists()
                && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || getContext().getPackageManager().canRequestPackageInstalls())) {
            waitingForInstallPermission = false;
            launchInstaller(getContext());
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        Uri updateUri = url == null ? null : Uri.parse(url);
        if (!isTrustedUpdateUri(updateUri)) {
            call.reject("An HTTPS APK URL is required.");
            return;
        }
        if (activeDownloadId != -1L) {
            call.reject("An update is already downloading.");
            return;
        }

        File downloads = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (downloads == null) {
            call.reject("The app download folder is unavailable.");
            return;
        }

        String fileName = "Overcode-Mobile-update.apk";
        activeFile = new File(downloads, fileName);
        if (activeFile.exists() && !activeFile.delete()) {
            call.reject("The previous update file could not be replaced.");
            return;
        }

        DownloadManager.Request request = new DownloadManager.Request(updateUri);
        request.setTitle("Overcode Mobile update");
        request.setDescription("Downloading the latest Overcode Mobile APK");
        request.setMimeType(APK_MIME_TYPE);
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(true);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);

        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("Android download service is unavailable.");
            return;
        }
        activeDownloadId = manager.enqueue(request);

        JSObject result = new JSObject();
        result.put("downloadId", activeDownloadId);
        call.resolve(result);
    }

    private void launchInstaller(Context context) {
        Uri apkUri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                activeFile);
        Intent installIntent = new Intent(Intent.ACTION_VIEW);
        installIntent.setDataAndType(apkUri, APK_MIME_TYPE);
        installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(installIntent);
    }

    private static boolean isSuccessfulDownload(DownloadManager manager, long downloadId) {
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) return false;
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            return status == DownloadManager.STATUS_SUCCESSFUL;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private static boolean isTrustedUpdateUri(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && TRUSTED_UPDATE_HOST.equalsIgnoreCase(uri.getHost())
                && uri.getUserInfo() == null
                && (uri.getQuery() == null || uri.getQuery().isEmpty())
                && (uri.getFragment() == null || uri.getFragment().isEmpty())
                && uri.getPath() != null
                && uri.getPath().startsWith(TRUSTED_UPDATE_PATH_PREFIX)
                && uri.getPath().endsWith("/Overcode-Mobile.apk");
    }
}
