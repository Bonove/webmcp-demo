# WebMCP Hypotheek Demo — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a live WebMCP demo where an AI agent on a separate device discovers and operates mortgage calculator tools on a Centraal Beheer website, with the form visually filling itself on a beamer.

**Architecture:** Three components communicating via WebSocket: (1) the existing mortgage calculator page with a WS bridge that advertises WebMCP tools and executes tool calls with animated form filling, (2) a minimal Node.js WebSocket relay server, (3) a standalone mobile-friendly chat client that connects to Claude/GPT-4o/Gemini APIs and translates tool definitions per model.

**Tech Stack:** Vanilla HTML/CSS/JS (no build tools), Node.js with `ws` package for relay, REST calls to Claude/OpenAI/Gemini APIs.

---

## Agent Allocation

| Task | Agent Type | Reason |
|------|-----------|--------|
| Task 1: Project setup | general-purpose | package.json, file copying, config |
| Task 2: Relay server | general-purpose | Small Node.js WebSocket server |
| Task 3: Website bridge | application-performance:frontend-developer | DOM manipulation, animation, WebSocket client |
| Task 4: Chat client | application-performance:frontend-developer | Mobile-friendly UI, multi-API integration |
| Task 5: Integration & review | feature-dev:code-reviewer | End-to-end verification |

**Parallelization:** Tasks 2 and 3 can run in parallel (no dependencies). Task 4 depends on tasks 2+3 for the protocol contract but can start UI work early. Task 5 runs after all others.

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `server.js` (entry point that serves static files + relay)
- Copy: `hypotheek-calculator.html` from `../hypotheek-calculator.html`

**Step 1: Create package.json**

```json
{
  "name": "webmcp-demo",
  "version": "1.0.0",
  "description": "WebMCP hypotheek demo — AI agent discovers and operates mortgage tools",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

**Step 2: Copy hypotheek-calculator.html into repo**

```bash
cp ../hypotheek-calculator.html ./hypotheek-calculator.html
```

**Step 3: Create .gitignore**

```
node_modules/
.env
.DS_Store
```

**Step 4: Install dependencies**

```bash
npm install
```

**Step 5: Commit**

```bash
git add package.json .gitignore hypotheek-calculator.html
git commit -m "feat: project setup with package.json and base calculator"
```

---

## Task 2: Relay Server

**Files:**
- Create: `server.js`

**Context:** This is a combined HTTP static file server + WebSocket relay. One process serves everything: static HTML files on port 3001 and WebSocket connections on the same port via upgrade. Two roles: `page` (the website) and `agent` (the chat client). Messages are forwarded between them.

**Step 1: Build server.js**

The server must:
1. Serve static files (hypotheek-calculator.html, chat-client.html) via HTTP
2. Handle WebSocket upgrade on the same port
3. Track connections by role (`page` or `agent`)
4. On `register` message: store the connection's role
5. Forward all other messages from page→agent and agent→page
6. Handle disconnects: notify the other side with `{ type: "peer_disconnected" }`
7. Handle reconnects: when a new page/agent connects, notify the other side with `{ type: "peer_connected" }`

```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;

// --- Static file server ---
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

const httpServer = http.createServer((req, res) => {
  // Default to index or requested file
  let filePath = req.url === '/' ? '/hypotheek-calculator.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// --- WebSocket relay ---
const wss = new WebSocketServer({ server: httpServer });
const clients = { page: null, agent: null };

wss.on('connection', (ws) => {
  let role = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'register') {
      role = msg.role;
      clients[role] = ws;
      console.log(`[relay] ${role} connected`);

      // Notify peer
      const peer = role === 'page' ? 'agent' : 'page';
      if (clients[peer] && clients[peer].readyState === 1) {
        clients[peer].send(JSON.stringify({ type: 'peer_connected', role }));
      }
      return;
    }

    // Forward to peer
    const peer = role === 'page' ? 'agent' : 'page';
    if (clients[peer] && clients[peer].readyState === 1) {
      clients[peer].send(raw.toString());
    }
  });

  ws.on('close', () => {
    if (role && clients[role] === ws) {
      clients[role] = null;
      console.log(`[relay] ${role} disconnected`);

      // Notify peer
      const peer = role === 'page' ? 'agent' : 'page';
      if (clients[peer] && clients[peer].readyState === 1) {
        clients[peer].send(JSON.stringify({ type: 'peer_disconnected', role }));
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[webmcp-demo] Running on http://localhost:${PORT}`);
  console.log(`[webmcp-demo] Calculator: http://localhost:${PORT}/hypotheek-calculator.html`);
  console.log(`[webmcp-demo] Chat client: http://localhost:${PORT}/chat-client.html`);
});
```

**Step 2: Test relay starts**

```bash
node server.js
# Expected: "[webmcp-demo] Running on http://localhost:3001"
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add combined HTTP + WebSocket relay server"
```

---

## Task 3: Website WebSocket Bridge

**Files:**
- Modify: `hypotheek-calculator.html` (add bridge script + status bar + animated form filling)

**Context:** The existing page already has two WebMCP tools registered:
1. `bereken_maandlasten` — declarative via `<form toolname="...">` at line 615, with fields: woningwaarde, hypotheekbedrag, rentevaste_periode, hypotheekvorm, looptijd, bruto_jaarinkomen, heeft_partner, partner_jaarinkomen
2. `get_hypotheek_advies` — imperative via `navigator.modelContext.registerTool()` at line 995, with handler function

The bridge must:
1. Connect to `ws://HOST:3001` on page load
2. Collect tool definitions from the page (read form attributes + the imperative tool schema)
3. Send `tools_available` to relay when agent connects
4. On `tool_call`: animate form filling (set each field with a visible delay), run calculation, send `tool_result` back
5. Show a status bar at the top of the page

**Step 1: Add status bar CSS and HTML**

Add a fixed status bar above the header. States:
- Disconnected (red): "Geen verbinding met relay server"
- Waiting (amber): "Wachten op AI agent..."
- Connected (green): "AI agent verbonden"
- Executing (blue, animated): "Tool wordt uitgevoerd: bereken_maandlasten..."

```html
<!-- Add right after <body> -->
<div class="webmcp-status" id="webmcpStatus">
  <span class="status-dot"></span>
  <span class="status-text">Verbinding maken...</span>
</div>
```

```css
.webmcp-status {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--cb-font);
  z-index: 1000;
  transition: background 0.3s;
}
.webmcp-status.disconnected { background: #fee2e2; color: #991b1b; }
.webmcp-status.waiting { background: #fef3c7; color: #92400e; }
.webmcp-status.connected { background: #d1fae5; color: #065f46; }
.webmcp-status.executing { background: #dbeafe; color: #1e40af; }
.webmcp-status .status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: currentColor;
}
.webmcp-status.executing .status-dot {
  animation: pulse 1s infinite;
}
```

Also shift the header down by 36px: `.cb-header { top: 36px; }`

**Step 2: Add WebSocket bridge script**

Add a new `<script>` block at the end of the file (before closing `</body>`). This script:

1. Defines the tool schemas by reading the DOM:
   - For `bereken_maandlasten`: read form `[toolname]` attribute, iterate `<input>` and `<select>` elements, build JSON Schema from name/type/min/max/required attributes
   - For `get_hypotheek_advies`: hardcode the schema (it's defined in the imperative registerTool call, we duplicate it here since we can't introspect navigator.modelContext)

2. Connects to WebSocket relay at `ws://${location.host}`:
   - Sends `{ type: "register", role: "page" }`
   - On `peer_connected` (agent arrives): sends `tools_available` with both tool schemas
   - On `tool_call`: dispatches to the right handler
   - On `peer_disconnected`: updates status bar

3. Tool call handler for `bereken_maandlasten`:
   - Receives arguments object
   - For each field, sets the value with a 200ms delay (animated, so audience sees it)
   - Highlights the field briefly (blue border flash)
   - After all fields are set, triggers form submit
   - Returns the calculation result

4. Tool call handler for `get_hypotheek_advies`:
   - Calls the same advisory logic that the imperative tool uses
   - Returns the result object

```javascript
// === WebSocket Bridge ===
(function() {
  const statusEl = document.getElementById('webmcpStatus');
  const statusText = statusEl.querySelector('.status-text');

  function setStatus(state, text) {
    statusEl.className = 'webmcp-status ' + state;
    statusText.textContent = text;
  }

  // -- Tool schemas (read from page) --
  const tools = [
    {
      name: 'bereken_maandlasten',
      description: document.getElementById('hypotheekForm').getAttribute('tooldescription'),
      inputSchema: {
        type: 'object',
        properties: {
          woningwaarde: { type: 'number', description: 'Woningwaarde in euros', minimum: 50000, maximum: 2000000 },
          hypotheekbedrag: { type: 'number', description: 'Hypotheekbedrag in euros', minimum: 50000, maximum: 2000000 },
          rentevaste_periode: { type: 'number', description: 'Rentevaste periode in jaren', enum: [1, 5, 10, 15, 20, 30] },
          hypotheekvorm: { type: 'string', description: 'Type hypotheek', enum: ['annuitair', 'lineair'] },
          looptijd: { type: 'number', description: 'Looptijd in jaren', enum: [10, 15, 20, 25, 30] },
          bruto_jaarinkomen: { type: 'number', description: 'Bruto jaarinkomen in euros (optioneel, voor netto berekening)' },
          heeft_partner: { type: 'string', description: 'Heeft de aanvrager een partner?', enum: ['ja', 'nee'] },
          partner_jaarinkomen: { type: 'number', description: 'Bruto jaarinkomen partner in euros (optioneel)' }
        },
        required: ['woningwaarde', 'hypotheekbedrag', 'rentevaste_periode', 'hypotheekvorm', 'looptijd']
      }
    },
    {
      name: 'get_hypotheek_advies',
      description: 'Geeft gepersonaliseerd hypotheekadvies op basis van persoonlijke situatie. Retourneert aanbevolen hypotheekvorm, geschatte maximale hypotheek, en tips.',
      inputSchema: {
        type: 'object',
        properties: {
          leeftijd: { type: 'number', description: 'Leeftijd van de aanvrager' },
          gezinssituatie: { type: 'string', enum: ['alleenstaand', 'samenwonend', 'getrouwd', 'gescheiden'], description: 'Huidige gezinssituatie' },
          woonsituatie: { type: 'string', enum: ['eerste_woning', 'verhuizen', 'oversluiten', 'verbouwen'], description: 'Doel van de hypotheek' },
          bruto_jaarinkomen: { type: 'number', description: 'Bruto jaarinkomen aanvrager' },
          partner_inkomen: { type: 'number', description: 'Bruto jaarinkomen partner (optioneel)' },
          eigen_geld: { type: 'number', description: 'Beschikbaar eigen geld (optioneel)' }
        },
        required: ['leeftijd', 'gezinssituatie', 'woonsituatie', 'bruto_jaarinkomen']
      }
    }
  ];

  // -- Animated form filling --
  async function animateField(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = 'border-color 0.3s, box-shadow 0.3s';
    el.style.borderColor = '#0050f0';
    el.style.boxShadow = '0 0 0 3px rgba(0,80,240,0.2)';
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    el.style.borderColor = '';
    el.style.boxShadow = '';
  }

  async function handleBerekenMaandlasten(args) {
    // Reset form first
    resetForm();
    await new Promise(r => setTimeout(r, 300));

    // Fill fields with animation
    if (args.woningwaarde) await animateField('woningwaarde', args.woningwaarde);
    if (args.hypotheekbedrag) await animateField('hypotheekbedrag', args.hypotheekbedrag);
    if (args.rentevaste_periode) await animateField('rentevaste_periode', args.rentevaste_periode);
    if (args.hypotheekvorm) await animateField('hypotheekvorm', args.hypotheekvorm);
    if (args.looptijd) await animateField('looptijd', args.looptijd);
    if (args.bruto_jaarinkomen) await animateField('bruto_jaarinkomen', args.bruto_jaarinkomen);
    if (args.heeft_partner === 'ja') {
      togglePartner(true);
      await new Promise(r => setTimeout(r, 200));
      if (args.partner_jaarinkomen) await animateField('partner_jaarinkomen', args.partner_jaarinkomen);
    }

    // Calculate using existing function
    const formData = {
      woningwaarde: parseInt(args.woningwaarde) || 350000,
      hypotheekbedrag: parseInt(args.hypotheekbedrag) || 320000,
      rentevaste_periode: parseInt(args.rentevaste_periode) || 10,
      hypotheekvorm: args.hypotheekvorm || 'annuitair',
      looptijd: parseInt(args.looptijd) || 30,
      bruto_jaarinkomen: parseInt(args.bruto_jaarinkomen) || 0,
      heeft_partner: args.heeft_partner || 'nee',
      partner_jaarinkomen: parseInt(args.partner_jaarinkomen) || 0
    };

    const result = calculateMortgage(formData);
    displayResults(result);
    return result;
  }

  // -- WebSocket connection --
  let ws;
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', role: 'page' }));
      setStatus('waiting', 'Wachten op AI agent...');
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'peer_connected' && msg.role === 'agent') {
        setStatus('connected', 'AI agent verbonden');
        ws.send(JSON.stringify({ type: 'tools_available', tools }));
      }

      if (msg.type === 'peer_disconnected' && msg.role === 'agent') {
        setStatus('waiting', 'Wachten op AI agent...');
      }

      if (msg.type === 'tool_call') {
        setStatus('executing', `Tool wordt uitgevoerd: ${msg.name}...`);
        let result;
        if (msg.name === 'bereken_maandlasten') {
          result = await handleBerekenMaandlasten(msg.arguments);
        } else if (msg.name === 'get_hypotheek_advies') {
          // Re-use the imperative handler logic (duplicated here since we can't call navigator.modelContext)
          result = handleAdvies(msg.arguments);
        }
        ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, result }));
        setStatus('connected', 'AI agent verbonden');
      }
    };

    ws.onclose = () => {
      setStatus('disconnected', 'Geen verbinding met relay server');
      setTimeout(connect, 3000); // auto-reconnect
    };
  }

  connect();
})();
```

Note: `handleAdvies` reuses the same logic from the existing imperative tool handler (the `INTEREST_RATES`, `getTaxRate` etc. are already global). Extract the handler body into a standalone function.

**Step 3: Remove or hide the old WebMCP debug badge/panel**

The existing badge at line 822-840 can be removed or hidden — the status bar replaces it.

**Step 4: Commit**

```bash
git add hypotheek-calculator.html
git commit -m "feat: add WebSocket bridge with animated form filling to calculator"
```

---

## Task 4: Chat Client

**Files:**
- Create: `chat-client.html`

**Context:** Standalone HTML page that runs on a phone or second laptop. Connects to the relay server, receives tool definitions from the website, and lets the user chat with an AI that can call those tools. Must support Claude, GPT-4o, and Gemini APIs.

**Step 1: Build chat-client.html — structure and styles**

Mobile-first design:
- Full viewport height
- Header (48px): model selector dropdown (left), API key button (right)
- Chat area (flex-grow, scrollable): message bubbles
- Input area (bottom): text input + send button, sticky

Styling: dark theme to contrast with the CB website on the beamer. Monospace accents for tool calls.

Key CSS classes:
- `.msg.user` — right-aligned, blue bubble
- `.msg.assistant` — left-aligned, dark bubble
- `.msg.tool-call` — left-aligned, outlined, monospace, shows tool name + params
- `.msg.tool-result` — left-aligned, small, green accent, shows result summary

**Step 2: Build chat-client.html — WebSocket connection**

On load:
1. Connect to `ws://${location.host}` (same server as the page)
2. Send `{ type: "register", role: "agent" }`
3. On `tools_available`: store the tool definitions, enable the chat input
4. On `tool_result`: resolve the pending promise for the tool call
5. On `peer_disconnected` (page): show warning in chat
6. On `peer_connected` (page): show info in chat

**Step 3: Build chat-client.html — API key management**

- Tapping the key icon in the header opens a modal/drawer
- Three fields: Claude API key, OpenAI API key, Gemini API key
- All stored in `localStorage` under keys `apikey_claude`, `apikey_openai`, `apikey_gemini`
- On save, validate that the selected model has a key set

**Step 4: Build chat-client.html — AI API adapters**

Three adapter functions that all share the same signature:

```javascript
async function callAI(provider, messages, tools) → { message, toolCalls[] }
```

**Claude adapter:**
- Endpoint: `https://api.anthropic.com/v1/messages`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`
- Body: `{ model: "claude-sonnet-4-20250514", max_tokens: 1024, system: SYSTEM_PROMPT, messages, tools }`
- Tools format: `{ name, description, input_schema }` (pass inputSchema as input_schema)
- Response: check `content[]` for `type: "tool_use"` blocks

**OpenAI adapter:**
- Endpoint: `https://api.openai.com/v1/chat/completions`
- Headers: `Authorization: Bearer KEY`
- Body: `{ model: "gpt-4o", messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages], tools }`
- Tools format: `{ type: "function", function: { name, description, parameters } }` (pass inputSchema as parameters)
- Response: check `choices[0].message.tool_calls[]`

**Gemini adapter:**
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=KEY`
- Body: `{ contents: [...messages], tools: [{ functionDeclarations }], systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] } }`
- functionDeclarations format: `{ name, description, parameters }` (pass inputSchema as parameters, remove `minimum`/`maximum` since Gemini doesn't support them)
- Response: check `candidates[0].content.parts[]` for `functionCall`

**System prompt (shared across all models):**

```
Je bent een hypotheekadviseur van Centraal Beheer. Je helpt klanten met vragen over hypotheken.

Je hebt toegang tot tools op de Centraal Beheer website. Gebruik deze tools om berekeningen te maken en advies te geven. Gebruik altijd de tools wanneer een klant vraagt naar maandlasten, hypotheekkosten, of advies.

Antwoord altijd in het Nederlands. Wees vriendelijk en helder. Geef na een berekening een korte samenvatting van de belangrijkste cijfers.
```

**Step 5: Build chat-client.html — conversation loop**

The main send function:

1. Add user message to chat UI and messages array
2. Call `callAI(selectedProvider, messages, tools)`
3. If response contains tool calls:
   a. For each tool call: show tool-call bubble in chat, send `tool_call` via WebSocket, wait for `tool_result`
   b. Add tool results to messages array
   c. Call `callAI` again with updated messages (the AI will now formulate a response using the tool results)
4. Show assistant message in chat

This loop handles multi-turn tool use (AI may call multiple tools or call a tool then respond).

**Step 6: Commit**

```bash
git add chat-client.html
git commit -m "feat: add chat client with Claude, GPT-4o, and Gemini support"
```

---

## Task 5: Integration Test & Review

**Files:**
- All files in repo

**Step 1: Start server and verify static serving**

```bash
node server.js
# Open http://localhost:3001/ — should serve hypotheek-calculator.html
# Open http://localhost:3001/chat-client.html — should serve chat client
```

**Step 2: Verify WebSocket relay**

- Open calculator in browser tab 1 → status bar should show "Wachten op AI agent..."
- Open chat client in browser tab 2 → calculator status should change to "AI agent verbonden"
- Close chat client tab → calculator should revert to "Wachten op AI agent..."

**Step 3: End-to-end test with Claude API**

- In chat client, select Claude, enter API key
- Type: "Wat kost een hypotheek van 350.000 euro voor een huis van 400.000?"
- Verify: calculator form fills in animated, results appear, chat shows AI response with summary

**Step 4: Test model switching**

- Switch to GPT-4o, ask similar question → verify same flow works
- Switch to Gemini, ask similar question → verify same flow works

**Step 5: Test get_hypotheek_advies tool**

- Ask: "Ik ben 28, alleenstaand, wil mijn eerste huis kopen, verdien 55.000 per jaar. Wat is jullie advies?"
- Verify: AI calls `get_hypotheek_advies`, returns tips and recommendation

**Step 6: Code review**

Review all files for:
- No hardcoded API keys
- Proper error handling on WebSocket disconnect/reconnect
- Mobile responsiveness of chat client
- Clean console output (no stray logs)
- CORS headers not needed (same origin via server.js)

**Step 7: Final commit**

```bash
git add -A
git commit -m "chore: integration fixes and cleanup"
```
