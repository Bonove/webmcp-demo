const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;

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

  // Map URL to file path
  let urlPath = req.url.split('?')[0]; // strip query string
  if (urlPath === '/') urlPath = '/hypotheek-calculator.html';

  const filePath = path.join(__dirname, urlPath);
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
      role = msg.role; // 'page' or 'agent'

      // If there was an old connection for this role, close it
      if (peers[role] && peers[role] !== ws) {
        peers[role].close();
      }
      peers[role] = ws;

      console.log(`[ws] ${role} registered`);

      // Notify the other side that a peer connected
      const otherRole = role === 'page' ? 'agent' : 'page';
      const other = peers[otherRole];
      if (other && other.readyState === 1) {
        other.send(JSON.stringify({ type: 'peer_connected', role }));
      }

      // Also tell the newly registered client if the other side is already here
      if (other && other.readyState === 1) {
        ws.send(JSON.stringify({ type: 'peer_connected', role: otherRole }));
      }

      return;
    }

    // ── Forward everything else to the other side ──
    if (!role) return; // not registered yet — drop

    const otherRole = role === 'page' ? 'agent' : 'page';
    const other = peers[otherRole];
    if (other && other.readyState === 1) {
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
    if (other && other.readyState === 1) {
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
