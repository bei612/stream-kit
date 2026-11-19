package io.github.bei612.streamkit.bookmarkguard;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.Arrays;

/** Same-signer, testOnly instrumentation. Never decrypts or exports the bookmark.
 * Android restarts the target process before each invocation; no Activity is
 * created, so the application's asynchronous bookmark writer cannot race us.
 */
public final class BookmarkGuard extends Instrumentation {
    private String action;
    private int expectedVersion;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        action = arguments == null ? null : arguments.getString("action");
        expectedVersion = arguments == null ? -1 : Integer.parseInt(arguments.getString("version", "-1"));
        start();
    }

    private static byte[] read(AtomicFile file) throws Exception {
        // openRead recovers an interrupted AtomicFile write before size checking.
        try (FileInputStream input = file.openRead()) {
            long length = input.getChannel().size();
            if (length < 30 || length > 8192) throw new IllegalStateException();
            byte[] bytes = new byte[(int) length];
            int count = 0;
            while (count < bytes.length) {
                int n = input.read(bytes, count, bytes.length - count);
                if (n < 0) throw new IllegalStateException();
                count += n;
            }
            if (input.read() != -1 || bytes[0] != 1) throw new IllegalStateException();
            return bytes;
        }
    }

    private static void write(AtomicFile file, byte[] bytes) throws Exception {
        FileOutputStream output = file.startWrite();
        try { output.write(bytes); file.finishWrite(output); }
        catch (Exception error) { file.failWrite(output); throw error; }
        if (!Arrays.equals(read(file), bytes)) throw new IllegalStateException();
    }

    private static boolean exists(AtomicFile file) {
        File base = file.getBaseFile();
        return base.exists() || new File(base.getPath() + ".bak").exists()
                || new File(base.getPath() + ".new").exists();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            String target = getTargetContext().getPackageName();
            if (!"io.github.bei612.streamkit".equals(target) || expectedVersion <= 0 ||
                    getTargetContext().getPackageManager().getPackageInfo(target, 0).versionCode != expectedVersion)
                throw new IllegalStateException();
            File directory = getTargetContext().getNoBackupFilesDir();
            AtomicFile bookmark = new AtomicFile(new File(directory, "watch-link.enc"));
            AtomicFile saved = new AtomicFile(new File(directory, "acceptance-original-watch-link.enc"));
            byte[] bytes;
            if ("backup".equals(action)) {
                // An existing recovery copy must never be replaced by a test link.
                if (exists(saved)) throw new IllegalStateException();
                bytes = read(bookmark);
                write(saved, bytes);
            } else if ("restore".equals(action)) {
                bytes = read(saved);
                write(bookmark, bytes);
                saved.delete();
                if (exists(saved)) throw new IllegalStateException();
            } else throw new IllegalArgumentException();
            StringBuilder digest = new StringBuilder();
            for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes))
                digest.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            result.putString("ciphertext_sha256", digest.toString());
            result.putString("action", action);
            result.putString("result", "complete");
            finish(Activity.RESULT_OK, result);
        } catch (Exception error) {
            // No paths, keys, intent data or raw exception text in test output.
            result.putString("result", "failed");
            result.putString("error_type", error.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
