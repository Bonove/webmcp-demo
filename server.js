const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;

// API key config from environment variables
const API_KEYS = {
  claude: process.env.ANTHROPIC_API_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
};

// MIME type map
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// CORS headers applied to every HTTP response
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /api/providers ──
  if (req.method === 'GET' && req.url === '/api/providers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      claude: !!API_KEYS.claude,
      openai: !!API_KEYS.openai,
      gemini: !!API_KEYS.gemini,
    }));
    return;
  }

  // ── POST /api/chat ──
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Ongeldige JSON' }));
        return;
      }

      const { provider, body: apiBody } = parsed;

      if (!provider || !['claude', 'openai', 'gemini'].includes(provider)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Onbekende provider: ' + provider }));
        return;
      }

      const apiKey = API_KEYS[provider];
      if (!apiKey) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key niet geconfigureerd voor ' + provider }));
        return;
      }

      const payload = JSON.stringify(apiBody);
      let options;

      if (provider === 'claude') {
        options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        };
      } else if (provider === 'openai') {
        options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        };
      } else if (provider === 'gemini') {
        options = {
          hostname: 'generativelanguage.googleapis.com',
          path: '/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(apiKey),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        };
      }

      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('[proxy] Error forwarding to', provider, ':', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy fout: ' + err.message }));
      });

      proxyReq.write(payload);
      proxyReq.end();
    });
    return;
  }

  // Map URL to file path
  let urlPath = req.url.split('?')[0]; // strip query string
  if (urlPath === '/') urlPath = '/hypotheek-calculator.html';

  const filePath = path.join(__dirname, urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ── WebSocket relay ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

// Track connections by role: { page: ws | null, agent: ws | null }
const peers = { page: null, agent: null };

wss.on('connection', (ws) => {
  let role = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore non-JSON
    }

    // ── Register ──
    if (msg.type === 'register') {
      role = msg.role;
      if (role !== 'page' && role !== 'agent') { role = null; return; }

      // If there was an old connection for this role, close it
      if (peers[role] && peers[role] !== ws) {
        peers[role].close();
      }
      peers[role] = ws;

      console.log(`[ws] ${role} registered`);

      // Notify the other side that a peer connected
      const otherRole = role === 'page' ? 'agent' : 'page';
      const other = peers[otherRole];
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: 'peer_connected', role }));
      }

      // Also tell the newly registered client if the other side is already here
      if (other && other.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'peer_connected', role: otherRole }));
      }

      return;
    }

    // ── Forward everything else to the other side ──
    if (!role) return; // not registered yet — drop

    const otherRole = role === 'page' ? 'agent' : 'page';
    const other = peers[otherRole];
    if (other && other.readyState === WebSocket.OPEN) {
      other.send(raw.toString());
    }
  });

  ws.on('close', () => {
    if (!role) return;
    console.log(`[ws] ${role} disconnected`);

    // Only clear if this is still the active connection for the role
    if (peers[role] === ws) {
      peers[role] = null;
    }

    // Notify the other side
    const otherRole = role === 'page' ? 'agent' : 'page';
    const other = peers[otherRole];
    if (other && other.readyState === WebSocket.OPEN) {
      other.send(JSON.stringify({ type: 'peer_disconnected', role }));
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] error (${role || 'unregistered'}):`, err.message);
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  WebMCP relay server running`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Server:          http://localhost:${PORT}`);
  console.log(`  Calculator:      http://localhost:${PORT}/hypotheek-calculator.html`);
  console.log(`  Chat client:     http://localhost:${PORT}/chat-client.html`);
  console.log(`  WebSocket:       ws://localhost:${PORT}`);
  console.log();
});
