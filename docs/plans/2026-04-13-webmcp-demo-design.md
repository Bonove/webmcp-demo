# WebMCP Hypotheek Demo — Design Document

**Datum**: 2026-04-13
**Status**: Goedgekeurd

## Doel

Een live demo die laat zien hoe WebMCP werkt: een AI agent op een apart device (telefoon/laptop) ontdekt tools op een website en bedient het formulier — visueel zichtbaar voor het publiek op een beamer.

## Architectuur

```
Beamer (hypotheek-calculator.html)
  │  WebMCP tools (declaratief + imperatief)
  │  WebSocket bridge → adverteert tools, voert calls uit, animeert formulier
  │
  ├── ws://relay:3001 ──┐
  │                      │
  │               Relay Server (relay.js)
  │               Node.js WebSocket relay
  │               Forwardt berichten page ↔ agent
  │                      │
  └──────────────────────┤
                         │
Telefoon/Laptop 2 (chat-client.html)
  Chat UI + model selector (Claude / GPT-4o / Gemini)
  API key in localStorage
  Ontvangt tools van website, stuurt naar AI als function definitions
  Bij tool_call: stuurt via relay naar website, wacht op result
```

## Componenten

### 1. hypotheek-calculator.html (bestaand + bridge)

De bestaande CB hypotheek-calculator met WebMCP tools. Toevoeging:

- WebSocket client die verbindt met relay server
- Leest geregistreerde tools (declaratief via `[toolname]` attributen, imperatief via registerTool)
- Stuurt `tools_available` naar relay bij connectie
- Bij `tool_call`: vult formulier geanimeerd in (veld voor veld), voert berekening uit, stuurt `tool_result` terug
- Statusbalk bovenaan: "Wachten op AI agent..." / "AI agent verbonden" / "Tool wordt uitgevoerd..."

### 2. relay.js

Minimale WebSocket relay (~40 regels Node.js):

- Draait op `ws://localhost:3001`
- Twee rollen: `page` en `agent`
- Bij connectie: client stuurt `{ type: "register", role: "page"|"agent" }`
- Forwardt berichten tussen page en agent
- Protocol berichten:
  - `tools_available` (page → agent): tool definities
  - `tool_call` (agent → page): `{ type: "tool_call", id, name, arguments }`
  - `tool_result` (page → agent): `{ type: "tool_result", id, result }`
- Geen auth, geen persistence

### 3. chat-client.html

Standalone HTML-pagina, mobiel-vriendelijk:

- **Header**: Model selector dropdown + API key invoerveld (opgeslagen in localStorage)
- **Chat area**: User bubbles rechts, AI links. Bij tool calls een visueel blokje met tool naam + parameters
- **Input**: Tekstveld + verzendknop
- **Logica**:
  1. Verbindt met relay als `agent`
  2. Ontvangt `tools_available`
  3. Vertaalt tools naar het juiste format per AI model
  4. Bij user bericht: stuurt naar AI API met tools
  5. Bij tool call: stuurt via relay naar website, wacht op result, stuurt terug naar AI
  6. Toont AI antwoord
- **AI API adapters**: Vertaallaag per model (Claude tools[], GPT function.parameters, Gemini functionDeclarations[])
- **System prompt**: Instrueert het model dat het een hypotheek-assistent is voor Centraal Beheer en de beschikbare tools moet gebruiken

## Protocol

WebSocket berichten zijn JSON:

```json
// Registratie
{ "type": "register", "role": "page" }
{ "type": "register", "role": "agent" }

// Tools adverteren (page → agent)
{
  "type": "tools_available",
  "tools": [
    {
      "name": "bereken_maandlasten",
      "description": "Bereken de maandelijkse hypotheeklasten...",
      "inputSchema": { "type": "object", "properties": { ... } }
    }
  ]
}

// Tool aanroep (agent → page)
{
  "type": "tool_call",
  "id": "call_123",
  "name": "bereken_maandlasten",
  "arguments": { "woningwaarde": 400000, "hypotheekbedrag": 350000, ... }
}

// Tool resultaat (page → agent)
{
  "type": "tool_result",
  "id": "call_123",
  "result": { "bruto_maandlasten": 1580.23, "netto_maandlasten": 1190.50, ... }
}
```

## Demo-flow

1. Presentator start relay: `node relay.js`
2. Opent hypotheek-calculator.html op beamer → "Wachten op AI agent..."
3. Opent chat-client.html op telefoon → kiest model → beamer toont "AI agent verbonden"
4. Typt vraag op telefoon
5. Publiek ziet formulier invullen op beamer
6. Telefoon toont AI-antwoord
7. Kan live switchen tussen Claude/GPT/Gemini

## Beslissingen

- **Geen build tools**: Alles is vanilla HTML/JS/CSS, direct te openen
- **API keys client-side**: Acceptabel voor demo-context
- **Eén relay server**: Simpelste bridge, geen auth nodig voor lokaal netwerk
- **Geanimeerd formulier invullen**: Cruciaal voor het visuele "wow"-effect
- **Model-agnostisch**: Toont dat WebMCP niet gebonden is aan één AI provider

## Deployment

Uiteindelijk naar Render (render-makerstreet) voor remote demo's:
- Relay server als web service
- HTML bestanden als static site (of via dezelfde server)
