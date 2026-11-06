package com.limelight.streamkit;

import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.MockResponse;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class ManagedApiTest {
    private static final String KEY = "A".repeat(43);
    private MockWebServer server;
    private final List<String> requests = new ArrayList<>();
    private String base;
    private boolean redirect;
    private String mediaLocation = "/api/host/stream/webrtc/42";
    private String joinedHost = "17";
    private String revision = "2";
    private String connectionRole = "viewer";

    @Before public void start() throws Exception {
        server = new MockWebServer();
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) { return handle(request); }
        });
        server.start();
        base = "http://127.0.0.1:" + server.getPort();
    }
    @After public void stop() throws IOException { server.shutdown(); }

    private WatchLink link() { return WatchLink.parse(base + "/watch#key=" + KEY, true); }

    private String state() {
        return "{\"session_id\":\"session-1\",\"host_id\":" + joinedHost + ",\"app_id\":29," +
                "\"revision\":" + revision + ",\"control_epoch\":0,\"connection_token\":\"connection-secret\"," +
                "\"connection\":{\"connection_id\":\"connection-1\",\"role\":\"" + connectionRole + "\"}," +
                "\"audio\":{\"microphone_enabled\":true}}";
    }

    private MockResponse handle(RecordedRequest exchange) {
        String path = exchange.getPath();
        synchronized (requests) { requests.add(exchange.getMethod() + " " + path); }
        MockResponse result = new MockResponse();
        String response = "{}";
        int code = 200;
        if (path.equals("/api/v1/watch/open")) {
            if (!("Bearer " + KEY).equals(exchange.getHeader("Authorization"))) code = 401;
            if (redirect) { code = 302; result.addHeader("Location", base + "/redirected"); }
            result.addHeader("X-Stream-Port", String.valueOf(server.getPort()));
            response = "{\"invitation\":\"invitation-secret\",\"session_id\":\"session-1\",\"host_id\":17,\"app_id\":29,\"gateway_public_url\":\"\"}";
        } else if (path.equals("/api/v1/client-sessions/join")) {
            if (!"Bearer invitation-secret".equals(exchange.getHeader("Authorization"))) code = 401;
            response = state();
        } else if (path.startsWith("/api/v1/client-sessions/session-1/connections/connection-1")) {
            if (!"Bearer connection-secret".equals(exchange.getHeader("Authorization"))) code = 401;
            if (path.endsWith("/ticket")) response = "{\"ticket\":\"media-secret\",\"expires_at\":\"2026-11-06T12:00:00Z\",\"role\":\"controller\"}";
            else response = state();
        } else if (path.startsWith("/api/host/stream/")) {
            if (!"media-secret".equals(exchange.getHeader("X-Stream-Media-Ticket")) ||
                    exchange.getHeader("Authorization") != null) code = 401;
            if (exchange.getMethod().equals("POST")) {
                code = code == 200 ? 201 : code;
                result.addHeader("Location", mediaLocation);
                response = "v=0\r\n";
            }
        } else code = 404;
        if (path.startsWith("/api/v1/")) response = "{\"status\":\"ok\",\"data\":" + response + "}";
        return result.setResponseCode(code).setBody(response);
    }

    @Test public void admissionHeartbeatAndMediaUseSeparateCredentials() throws Exception {
        ManagedApi api = new ManagedApi(link(), true);
        ManagedApi.Admission admission = api.open(link());
        assertEquals(17, admission.hostId);
        assertEquals(29, admission.appId);
        assertEquals(base + "/", admission.gateway.toString());
        assertEquals(ConnectionAuthority.Role.VIEWER, admission.authority.role);
        ManagedApi.Ticket ticket = api.ticket(admission.authority);
        assertEquals(ConnectionAuthority.Role.VIEWER, admission.authority.role);
        assertEquals("connection-1", api.heartbeat(admission.authority, false, false).connectionId);
        assertEquals("session-1", api.resume(admission.authority).sessionId);
        ManagedApi.Answer answer = api.offer(admission, ticket, "v=0\r\n");
        assertEquals(base + mediaLocation, answer.resource.toString());
        api.deleteMedia(admission, ticket, answer.resource);
        api.leave(admission.authority);
        assertEquals(8, requests.size());
        assertTrue(requests.stream().noneMatch(value -> value.contains(KEY) || value.contains("secret")));
    }

    @Test public void redirectsCannotForwardAdmissionCredential() throws Exception {
        redirect = true;
        try { new ManagedApi(link(), true).open(link()); fail("Redirect accepted"); }
        catch (ManagedApi.Failure error) { assertEquals(302, error.status); }
        assertEquals(List.of("POST /api/v1/watch/open"), requests);
    }

    @Test public void mismatchedApplicationReleasesJoinedConnection() throws Exception {
        joinedHost = "18";
        try { new ManagedApi(link(), true).open(link()); fail("Wrong app accepted"); }
        catch (ManagedApi.Failure error) { assertEquals(502, error.status); }
        assertTrue(requests.contains("DELETE /api/v1/client-sessions/session-1/connections/connection-1"));
    }

    @Test public void foreignMediaLocationIsRejectedBeforeTicketCanBeSent() throws Exception {
        mediaLocation = "https://untrusted.invalid/api/host/stream/webrtc/42";
        ManagedApi api = new ManagedApi(link(), true);
        ManagedApi.Admission admission = api.open(link());
        try { api.offer(admission, api.ticket(admission.authority), "v=0\r\n"); fail("Foreign media location accepted"); }
        catch (ManagedApi.Failure error) { assertEquals(502, error.status); }
        assertEquals(4, requests.size());
    }

    @Test public void numericStringsCannotBecomeAuthorityVersions() throws Exception {
        revision = "\"2\"";
        try { new ManagedApi(link(), true).open(link()); fail("Coerced authority version"); }
        catch (ManagedApi.Failure error) { assertEquals(502, error.status); }
    }

    @Test public void unknownRolesFailClosed() throws Exception {
        connectionRole = "admin";
        try { new ManagedApi(link(), true).open(link()); fail("Unknown role accepted"); }
        catch (ManagedApi.Failure error) { assertEquals(502, error.status); }
    }
}
