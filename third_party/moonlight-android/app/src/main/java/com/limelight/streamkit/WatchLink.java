package com.limelight.streamkit;

import java.net.URI;
import java.net.URISyntaxException;

/** Durable application capability. Never include its fragment in requests or logs. */
public final class WatchLink {
    private final URI origin;
    private final String capability;

    private WatchLink(URI origin, String capability) {
        this.origin = origin;
        this.capability = capability;
    }

    public static WatchLink parse(String value, boolean allowDevelopmentHttp) {
        if (value == null || value.length() > 4096) {
            throw invalid();
        }
        try {
            URI uri = new URI(value.trim());
            String scheme = uri.getScheme();
            boolean secure = "https".equalsIgnoreCase(scheme);
            if ((!secure && !(allowDevelopmentHttp && "http".equalsIgnoreCase(scheme))) ||
                    uri.getHost() == null || uri.getRawUserInfo() != null ||
                    uri.getRawQuery() != null || !"/watch".equals(uri.getRawPath()) ||
                    uri.getPort() > 65535 || uri.getPort() == 0) {
                throw invalid();
            }
            String fragment = uri.getRawFragment();
            if (fragment == null || !fragment.matches("key=[A-Za-z0-9_-]{43}")) {
                throw invalid();
            }
            URI origin = new URI(secure ? "https" : "http", null,
                    uri.getHost(), uri.getPort(), null, null, null);
            return new WatchLink(origin, fragment.substring(4));
        } catch (URISyntaxException exception) {
            // URI exceptions contain the input, including the secret fragment.
            throw invalid();
        }
    }

    public URI origin() { return origin; }
    /** Change only the endpoint; retain the durable application capability. */
    public WatchLink withOrigin(String value, boolean allowDevelopmentHttp) {
        if (value == null || value.length() > 2048) throw invalid();
        try {
            URI replacement = new URI(value.trim());
            if (replacement.getRawQuery() != null || replacement.getRawFragment() != null ||
                    replacement.getRawUserInfo() != null ||
                    !(replacement.getRawPath() == null || replacement.getRawPath().isEmpty() || "/".equals(replacement.getRawPath()))) throw invalid();
            URI target = new URI(replacement.getScheme(), null, replacement.getHost(), replacement.getPort(), "/watch", null, "key=" + capability);
            return parse(target.toString(), allowDevelopmentHttp);
        } catch (URISyntaxException error) { throw invalid(); }
    }
    public URI admissionEndpoint() { return origin.resolve("/api/v1/watch/open"); }
    public String admissionAuthorization() { return "Bearer " + capability; }

    // Only the encrypted local store serializes the full capability.
    String storedValue() { return origin + "/watch#key=" + capability; }

    @Override
    public String toString() { return origin + "/watch#key=[redacted]"; }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid application viewing link");
    }
}
