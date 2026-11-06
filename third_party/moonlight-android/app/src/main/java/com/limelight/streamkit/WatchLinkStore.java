package com.limelight.streamkit;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One encrypted bookmark; no connection tokens, backups or exported key material. */
final class WatchLinkStore implements AutoCloseable {
    interface Loaded { void complete(WatchLink link, boolean unreadable); }
    interface Saved { void complete(boolean success); }
    private static final String ALIAS = "stream-kit-watch-link-v1";
    private static final byte[] AAD = ALIAS.getBytes(StandardCharsets.UTF_8);
    private final AtomicFile file;
    private final boolean development;
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean closed;

    WatchLinkStore(Context context, boolean development) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "watch-link.enc"));
        this.development = development;
    }

    void load(Loaded callback) {
        storage.execute(() -> {
            WatchLink link = null;
            boolean unreadable = false;
            try {
                if (file.getBaseFile().exists()) {
                    if (file.getBaseFile().length() > 8192) throw new IllegalStateException();
                    byte[] bytes = file.readFully();
                    if (bytes.length < 30 || bytes[0] != 1) throw new IllegalStateException();
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, bytes, 1, 12));
                    cipher.updateAAD(AAD);
                    byte[] plaintext = cipher.doFinal(bytes, 13, bytes.length - 13);
                    try { link = WatchLink.parse(new String(plaintext, StandardCharsets.UTF_8), development); }
                    finally { java.util.Arrays.fill(plaintext, (byte) 0); }
                }
            } catch (Exception ignored) {
                // Authentication/key failures must never fall back to plaintext or auto-connect.
                unreadable = true;
            }
            WatchLink loaded = link;
            boolean failed = unreadable;
            main.post(() -> { if (!closed) callback.complete(loaded, failed); });
        });
    }

    void save(WatchLink link, Saved callback) {
        storage.execute(() -> {
            boolean success = false;
            FileOutputStream output = null;
            byte[] plaintext = link.storedValue().getBytes(StandardCharsets.UTF_8);
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key(true));
                cipher.updateAAD(AAD);
                if (cipher.getIV().length != 12) throw new IllegalStateException();
                byte[] encrypted = cipher.doFinal(plaintext);
                byte[] bytes = ByteBuffer.allocate(13 + encrypted.length).put((byte) 1).put(cipher.getIV()).put(encrypted).array();
                output = file.startWrite();
                output.write(bytes);
                file.finishWrite(output);
                output = null;
                success = true;
            } catch (Exception ignored) {
                if (output != null) file.failWrite(output);
            } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
            boolean saved = success;
            main.post(() -> { if (!closed) callback.complete(saved); });
        });
    }

    void clear() {
        storage.execute(() -> file.delete());
    }

    private SecretKey key(boolean create) throws Exception {
        if (Build.VERSION.SDK_INT < 23) throw new IllegalStateException("Encrypted bookmark requires Android 6+");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
        if (existing != null) return existing;
        if (!create) throw new IllegalStateException("Bookmark key is unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    @Override public void close() { closed = true; storage.shutdown(); }
}
