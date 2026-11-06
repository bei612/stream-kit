package com.limelight.streamkit;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Blocking protocol adapter. Its owner runs calls off the UI/authority executor. */
public final class ManagedApi {
    private static final int MAX_BODY = 1024 * 1024;
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final MediaType SDP = MediaType.get("application/sdp");
    private final OkHttpClient http;
    private final HttpUrl control;
    private final boolean developmentHttp;

    public static final class Failure extends IOException {
        public final int status;
        public final String code;
        Failure(int status, String code) {
            super("Stream Kit request failed (" + status + ", " + code + ")");
            this.status = status;
            this.code = code;
        }
    }

    public static final class Admission {
        public final ConnectionAuthority authority;
        public final long hostId;
        public final long appId;
        public final HttpUrl gateway;
        Admission(ConnectionAuthority authority, long hostId, long appId, HttpUrl gateway) {
            this.authority = authority;
            this.hostId = hostId;
            this.appId = appId;
            this.gateway = gateway;
        }
        @Override public String toString() { return "Admission{credentials=[redacted]}"; }
    }

    public static final class Ticket {
        private final String token;
        public final String expiresAt;
        Ticket(String token, String expiresAt) { this.token = token; this.expiresAt = expiresAt; }
        @Override public String toString() { return "Ticket{credentials=[redacted]}"; }
    }

    public static final class Answer {
        public final String sdp;
        public final HttpUrl resource;
        Answer(String sdp, HttpUrl resource) { this.sdp = sdp; this.resource = resource; }
        @Override public String toString() { return "Answer{session=[redacted]}"; }
    }

    public ManagedApi(WatchLink link, boolean developmentHttp) {
        this.control = HttpUrl.get(link.origin());
        this.developmentHttp = developmentHttp;
        this.http = new OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
                .callTimeout(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
                .retryOnConnectionFailure(false).build();
        validateTransport(control);
    }

    public Admission open(WatchLink link) throws IOException {
        if (!control.equals(HttpUrl.get(link.origin()))) throw protocol();
        try {
            JSONObject invitation;
            String streamPort;
            try (Response response = execute(controlRequest("/api/v1/watch/open", link.admissionAuthorization())
                    .post(RequestBody.create("", JSON)).build())) {
                streamPort = response.header("X-Stream-Port");
                invitation = data(response);
            }
            long hostId = positiveId(invitation, "host_id");
            long appId = positiveId(invitation, "app_id");
            String publicGateway = invitation.optString("gateway_public_url", "");
            HttpUrl gateway;
            if (!publicGateway.isEmpty()) {
                gateway = HttpUrl.parse(publicGateway);
                if (gateway == null) throw protocol();
                validateTransport(gateway);
                if (!gateway.encodedPath().endsWith("/")) {
                    gateway = gateway.newBuilder().addPathSegment("").build();
                }
            } else {
                if (streamPort == null || !streamPort.matches("[0-9]{1,5}")) throw protocol();
                int port = Integer.parseInt(streamPort);
                if (port < 1 || port > 65535) throw protocol();
                gateway = control.newBuilder().port(port).build();
            }
            String bearer = credential(invitation, "invitation");
            JSONObject joined = controlJson("/api/v1/client-sessions/join", "Bearer " + bearer, "POST", "{}");
            ConnectionAuthority authority = authority(joined);
            // A valid late join can always be explicitly released by the caller.
            boolean accepted = false;
            try {
                if (positiveId(joined, "host_id") != hostId || positiveId(joined, "app_id") != appId ||
                        !authority.sessionId.equals(invitation.getString("session_id"))) throw protocol();
                accepted = true;
                return new Admission(authority, hostId, appId, gateway);
            } finally {
                if (!accepted) {
                    try { leave(authority); } catch (IOException ignored) { }
                }
            }
        } catch (JSONException | IllegalArgumentException exception) {
            throw protocol();
        }
    }

    public ConnectionAuthority heartbeat(ConnectionAuthority current, boolean microphone, boolean live) throws IOException {
        String body = "{\"microphone\":" + microphone + ",\"microphone_live\":" + live + "}";
        return update(current, "/heartbeat", body);
    }

    public ConnectionAuthority resume(ConnectionAuthority current) throws IOException {
        return update(current, "/resume", "{}");
    }

    private ConnectionAuthority update(ConnectionAuthority current, String operation, String body) throws IOException {
        try {
            ConnectionAuthority next = authority(controlJson(connectionPath(current) + operation,
                    current.authorization(), "POST", body));
            if (!next.sessionId.equals(current.sessionId) || !next.connectionId.equals(current.connectionId)) throw protocol();
            return next;
        } catch (JSONException | IllegalArgumentException exception) { throw protocol(); }
    }

    public Ticket ticket(ConnectionAuthority current) throws IOException {
        try {
            JSONObject result = controlJson(connectionPath(current) + "/ticket", current.authorization(), "POST", "{}");
            return new Ticket(credential(result, "ticket"), result.getString("expires_at"));
        } catch (JSONException | IllegalArgumentException exception) { throw protocol(); }
    }

    public void leave(ConnectionAuthority current) throws IOException {
        try (Response response = execute(controlRequest(connectionPath(current), current.authorization()).delete().build())) {
            if (response.code() != 410 && response.code() != 404 && !response.isSuccessful()) throw failure(response);
        }
    }

    public String iceConfiguration(Admission admission, Ticket ticket) throws IOException {
        try (Response response = execute(mediaRequest(admission, ticket, mediaEndpoint(admission, "webrtc"))
                .method("OPTIONS", null).build())) {
            if (!response.isSuccessful()) throw failure(response);
            return String.join(",", response.headers("Link"));
        }
    }

    public JSONObject profile(Admission admission, Ticket ticket) throws IOException {
        try (Response response = execute(mediaRequest(admission, ticket, mediaEndpoint(admission, "profile")).get().build())) {
            if (!response.isSuccessful()) throw failure(response);
            return new JSONObject(body(response));
        } catch (JSONException exception) { throw protocol(); }
    }

    public Answer offer(Admission admission, Ticket ticket, String sdp) throws IOException {
        HttpUrl endpoint = mediaEndpoint(admission, "webrtc");
        try (Response response = execute(mediaRequest(admission, ticket, endpoint).post(RequestBody.create(sdp, SDP)).build())) {
            if (response.code() != 201) throw failure(response);
            String location = response.header("Location");
            HttpUrl resource = location == null ? null : endpoint.resolve(location);
            if (resource == null) throw protocol();
            validateMediaResource(admission, resource);
            return new Answer(body(response), resource);
        }
    }

    public void deleteMedia(Admission admission, Ticket ticket, HttpUrl resource) throws IOException {
        try (Response response = execute(mediaRequest(admission, ticket, resource).delete().build())) {
            if (response.code() != 404 && response.code() != 410 && !response.isSuccessful()) throw failure(response);
        }
    }

    private HttpUrl mediaEndpoint(Admission admission, String path) throws IOException {
        HttpUrl result = admission.gateway.resolve("api/host/stream/" + path);
        if (result == null) throw protocol();
        return result;
    }

    private Request.Builder mediaRequest(Admission admission, Ticket ticket, HttpUrl url) throws IOException {
        validateMediaResource(admission, url);
        return new Request.Builder().url(url).header("X-Stream-Media-Ticket", ticket.token)
                .header("Cache-Control", "no-store").header("User-Agent", "StreamKit-Android/1");
    }

    private void validateMediaResource(Admission admission, HttpUrl url) throws IOException {
        HttpUrl base = admission.gateway;
        String prefix = base.encodedPath() + "api/host/stream/";
        String path = url.encodedPath();
        if (!url.scheme().equals(base.scheme()) || !url.host().equals(base.host()) || url.port() != base.port() ||
                !url.username().isEmpty() || !url.password().isEmpty() || url.query() != null || url.fragment() != null ||
                !path.startsWith(prefix) || !path.substring(prefix.length()).matches("profile|webrtc(?:/[0-9]+)?")) {
            throw protocol();
        }
    }

    private void validateTransport(HttpUrl url) {
        if ((!url.isHttps() && !developmentHttp) || (control.isHttps() && !url.isHttps()) ||
                !url.username().isEmpty() || !url.password().isEmpty() || url.query() != null || url.fragment() != null) {
            throw new IllegalArgumentException("Invalid server transport configuration");
        }
    }

    private Request.Builder controlRequest(String path, String authorization) {
        return new Request.Builder().url(control.resolve(path)).header("Authorization", authorization)
                .header("Cache-Control", "no-store").header("User-Agent", "StreamKit-Android/1");
    }

    private JSONObject controlJson(String path, String authorization, String method, String content) throws IOException {
        try (Response response = execute(controlRequest(path, authorization)
                .method(method, RequestBody.create(content, JSON)).build())) { return data(response); }
    }

    private Response execute(Request request) throws IOException {
        // Do not propagate an exception containing request URLs or header values to UI/logging.
        try { return http.newCall(request).execute(); }
        catch (IOException exception) { throw new Failure(0, "TRANSPORT_UNAVAILABLE"); }
    }

    private static JSONObject data(Response response) throws IOException {
        if (!response.isSuccessful()) throw failure(response);
        try {
            JSONObject envelope = new JSONObject(body(response));
            if (!"ok".equals(envelope.getString("status"))) throw protocol();
            return envelope.getJSONObject("data");
        } catch (JSONException exception) { throw protocol(); }
    }

    private static Failure failure(Response response) {
        // Never display server-controlled text that might echo a secret.
        return new Failure(response.code(), "REQUEST_REJECTED");
    }

    private static String body(Response response) throws IOException {
        if (response.body() == null || response.body().contentLength() > MAX_BODY) throw protocol();
        try (InputStream input = response.body().byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = input.read(buffer)) != -1) {
                if (output.size() + length > MAX_BODY) throw protocol();
                output.write(buffer, 0, length);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static ConnectionAuthority authority(JSONObject data) throws JSONException, IOException {
        JSONObject connection = data.getJSONObject("connection");
        String role = connection.getString("role");
        if (!"viewer".equals(role) && !"controller".equals(role)) throw protocol();
        Object microphone = data.getJSONObject("audio").get("microphone_enabled");
        if (!(microphone instanceof Boolean)) throw protocol();
        return new ConnectionAuthority(data.getString("session_id"), connection.getString("connection_id"),
                credential(data, "connection_token"), integer(data, "revision"), integer(data, "control_epoch"),
                "controller".equals(role) ? ConnectionAuthority.Role.CONTROLLER : ConnectionAuthority.Role.VIEWER,
                (Boolean) microphone);
    }

    private static long integer(JSONObject object, String name) throws JSONException, IOException {
        Object value = object.get(name);
        if (!(value instanceof Number)) throw protocol();
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > 9007199254740991L || number != Math.floor(number)) throw protocol();
        return ((Number) value).longValue();
    }

    private static long positiveId(JSONObject object, String name) throws JSONException, IOException {
        long value = integer(object, name);
        if (value == 0 || value > 0xffffffffL) throw protocol();
        return value;
    }

    private static String credential(JSONObject object, String name) throws JSONException, IOException {
        String value = object.getString(name);
        if (value.isEmpty() || value.length() > 8192 || value.matches("(?s).*\\s.*")) throw protocol();
        return value;
    }

    private static String connectionPath(ConnectionAuthority connection) {
        return "/api/v1/client-sessions/" + connection.sessionId + "/connections/" + connection.connectionId;
    }

    private static Failure protocol() { return new Failure(502, "INVALID_PROTOCOL_RESPONSE"); }
}
