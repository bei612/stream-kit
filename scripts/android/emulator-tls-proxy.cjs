// Isolated acceptance fixture. Never bundled with the product or installed as a service.
// Validates the release client's actual TLS stack against Android's user-CA store.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const root = path.resolve(__dirname, '../../.local/android-release-tls');
const tls = { key: fs.readFileSync(path.join(root, 'server.key')), cert: fs.readFileSync(path.join(root, 'server.crt')), minVersion: 'TLSv1.2' };
const counters = { controlRequests: 0, mediaRequests: 0, opened: 0, offers: 0, errors: 0 };
const servers = [];
for (const [port, upstreamPort, control] of [[11900, 9000, true], [11808, 8080, false]]) {
  const server = https.createServer(tls, (incoming, outgoing) => {
    counters[control ? 'controlRequests' : 'mediaRequests']++;
    const request = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: incoming.url,
      method: incoming.method, headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` } }, response => {
      const headers = { ...response.headers };
      if (control && incoming.url === '/api/v1/watch/open' && response.statusCode === 200) {
        let length = 0;
        const chunks = [];
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 1048576) { request.destroy(); outgoing.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            envelope.data.gateway_public_url = 'https://10.0.2.2:11808/';
            const body = Buffer.from(JSON.stringify(envelope));
            delete headers['transfer-encoding'];
            delete headers['content-encoding'];
            headers['content-length'] = String(body.length);
            headers['x-stream-port'] = '11808';
            outgoing.writeHead(response.statusCode, headers);
            outgoing.end(body);
            counters.opened++;
          } catch { counters.errors++; outgoing.destroy(); }
        });
      } else {
        if (!control && incoming.method === 'POST' && incoming.url === '/api/host/stream/webrtc' && response.statusCode === 201) counters.offers++;
        outgoing.writeHead(response.statusCode, headers);
        response.pipe(outgoing);
      }
    });
    request.setTimeout(20000, () => request.destroy());
    request.on('error', () => { counters.errors++; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on('aborted', () => request.destroy());
    incoming.pipe(request);
  });
  server.listen(port, '127.0.0.1');
  servers.push(server);
}
const metrics = setInterval(() => fs.writeFileSync(path.join(root, 'metrics.json'), JSON.stringify(counters)), 1000);
function stop() { clearInterval(metrics); for (const server of servers) server.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Isolated emulator TLS fixture listening on loopback 11900/11808; credentials are not logged.');
