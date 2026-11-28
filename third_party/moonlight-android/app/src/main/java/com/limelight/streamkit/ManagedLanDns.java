package com.limelight.streamkit;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.SystemClock;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import javax.jmdns.JmDNS;
import javax.jmdns.ServiceInfo;
import okhttp3.Dns;

/** Resolves the configured LAN authority through Sunshine's existing DNS-SD advertisement. */
final class ManagedLanDns implements Dns {
    private static final String SERVICE_TYPE = "_nvstream._tcp.local.";
    private static final long DISCOVERY_MS = 3000;
    private static final long CACHE_MS = 5000;
    private static final int MAX_ADDRESSES = 8;

    private final ConnectivityManager connectivity;
    private final WifiManager wifi;
    private final String watchHostname;
    private Network cachedNetwork;
    private InetAddress cachedInterface;
    private List<InetAddress> cachedAddresses;
    private long cacheExpiresAt;

    ManagedLanDns(Context context, String watchHostname) {
        Context app = context.getApplicationContext();
        connectivity = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        wifi = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
        this.watchHostname = watchHostname;
    }

    static boolean allowsDiscovery(String requestedName, String watchHostname) {
        String name = canonicalName(requestedName);
        return name.endsWith(".local") && name.equals(canonicalName(watchHostname));
    }

    private static String canonicalName(String name) {
        if (name == null) return "";
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".") ? lower.substring(0, lower.length() - 1) : lower;
    }

    static List<InetAddress> serviceAddresses(String hostname, ServiceInfo[] services) {
        String wanted = canonicalName(hostname);
        Set<InetAddress> addresses = new LinkedHashSet<>();
        for (ServiceInfo service : services) {
            // The friendly service instance name can differ from the DNS hostname.
            if (!wanted.equals(canonicalName(service.getServer()))) continue;
            for (Inet4Address address : service.getInet4Addresses()) {
                if (!address.isSiteLocalAddress()) continue;
                addresses.add(address);
                if (addresses.size() >= MAX_ADDRESSES) return new ArrayList<>(addresses);
            }
        }
        return new ArrayList<>(addresses);
    }

    @Override
    public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        try {
            return Dns.SYSTEM.lookup(hostname);
        } catch (UnknownHostException failure) {
            if (allowsDiscovery(hostname, watchHostname)) {
                try {
                    List<InetAddress> addresses = discover();
                    if (!addresses.isEmpty()) return addresses;
                } catch (IOException | SecurityException error) {
                    failure.addSuppressed(error);
                }
            }
            throw failure;
        }
    }

    private synchronized List<InetAddress> discover() throws IOException {
        if (connectivity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M)
            return Collections.emptyList();
        Network network = connectivity.getActiveNetwork();
        if (network == null) return Collections.emptyList();
        NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
        LinkProperties link = connectivity.getLinkProperties(network);
        if (caps == null || link == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
            return Collections.emptyList();
        boolean onWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        if (!onWifi && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
            return Collections.emptyList();
        InetAddress local = null;
        for (LinkAddress entry : link.getLinkAddresses()) {
            InetAddress address = entry.getAddress();
            if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                local = address;
                break;
            }
        }
        if (local == null) return Collections.emptyList();
        if (network.equals(cachedNetwork) && local.equals(cachedInterface)
                && SystemClock.elapsedRealtime() < cacheExpiresAt) {
            return cachedAddresses;
        }
        WifiManager.MulticastLock lock = onWifi && wifi != null ?
                wifi.createMulticastLock("Stream Kit LAN discovery") : null;
        if (lock != null) lock.acquire();
        try (JmDNS dns = JmDNS.create(local)) {
            List<InetAddress> addresses = serviceAddresses(watchHostname, dns.list(SERVICE_TYPE, DISCOVERY_MS));
            if (!network.equals(connectivity.getActiveNetwork())) return Collections.emptyList();
            cachedNetwork = network;
            cachedInterface = local;
            cachedAddresses = Collections.unmodifiableList(addresses);
            cacheExpiresAt = SystemClock.elapsedRealtime() + CACHE_MS;
            return cachedAddresses;
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
        }
    }
}
