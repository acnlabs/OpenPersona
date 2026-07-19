# Signal Protocol — Host-Side Implementation Guide

The Signal Protocol is the **nervous system** between a persona and its host environment.

OpenPersona personas are **agent-framework agnostic** — they run on OpenClaw, Claude Code, Cursor,
Codex, ZeroClaw, and any SKILL.md-compatible runner. The Signal Protocol follows the same principle:
it is a **runner-agnostic, file-based contract**. Any host that wants to respond to its personas
can implement it. Any host that doesn't implement it still runs the persona normally — signals are
simply unanswered.

- **Persona → Host** (`signals.json`): the persona emits requests — for capabilities, tools, scheduling, file access, resources, or peer communication
- **Host → Persona** (`signal-responses.json`): the host resolves those requests; the persona reads responses at the start of the next turn

OpenPersona ships the **client side** (`scripts/state-sync.js`) with every generated persona pack.
The **host side** is an open contract — this document specifies it so that any runner or platform
can implement it without depending on OpenPersona internals.

**The full closed loop — four steps:**

```
1. Persona emits        →  signals.json            (state-sync.js signal <type> [payload])
2. Host reads + acts    →  signal-responses.json    (host-side script or plugin)
3. Persona consumes     ←  signal-responses.json    (state-sync.js responses [type])
4. Runner sees result   ←  next-turn context        (openpersona state responses <slug>)
```

---

## Why This Matters

A persona installed into a host with **no signal handler** works fine — signals are written but
never answered, and the persona degrades gracefully.

A persona installed into a host that **implements the handler** gains a nervous system: it can
request new capabilities, trigger scheduling, route messages to peers, and the host can evolve
its own configuration based on what its personas collectively need.

This is intentional asymmetry: **the persona always arrives ready; the host chooses to
become responsive.**

---

## Feedback Directory

Both files live in a **feedback directory** resolved from the host's home location.
The persona's `state-sync.js` resolves the path in this order:

1. `$OPENCLAW_HOME/feedback/` — if env var `OPENCLAW_HOME` is set
2. `$OPENPERSONA_HOME/feedback/` — if env var `OPENPERSONA_HOME` is set (explicit non-OpenClaw / test override)
3. `~/.openclaw/feedback/` — if that directory already exists (standard OpenClaw layout)
4. `~/.openpersona/feedback/` — universal fallback

Explicit environment variables always win over implicit directory discovery. In particular,
setting `OPENPERSONA_HOME` must not be shadowed by a pre-existing `~/.openclaw` on the machine.

```
<feedback-dir>/
├── signals.json          ← persona writes here (array, capped at 200 entries)
└── signal-responses.json ← host writes here (array)
```

**For non-OpenClaw runners:** set `OPENPERSONA_HOME` to any directory you control.
The persona will write signals there; your host reads from the same path.

---

## Signal Schema (Persona → Host)

Each entry appended to `signals.json`:

```json
{
  "type": "capability_gap",
  "slug": "samantha",
  "timestamp": "2026-03-09T10:30:00.000Z",
  "payload": {
    "capability": "web_search",
    "reason": "User asked me to look up current news"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Signal category — one of the six types below |
| `slug` | string | Persona slug that emitted the signal |
| `timestamp` | ISO 8601 | Emission time |
| `payload` | object | Type-specific data |

**Array semantics:** the persona appends; the file is capped at 200 entries (oldest pruned).
The host should process new (unresponded) signals and may prune acknowledged entries.

**Emitting via CLI:**
```bash
# From the persona pack directory
node scripts/state-sync.js signal agent_communication '{"intent":"connect","target_agent_id":"agent-bob","transport":"websocket"}'

# Via OpenPersona CLI (from any directory)
openpersona state signal <slug> agent_communication '{"intent":"connect","target_agent_id":"agent-bob","transport":"websocket"}'
```

---

## Response Schema (Host → Persona)

Each entry written to `signal-responses.json`:

```json
{
  "type": "capability_gap",
  "slug": "samantha",
  "status": "resolved",
  "response": {
    "capability": "web_search",
    "message": "Skill installed. Restart conversation to activate."
  },
  "processed": false,
  "timestamp": "2026-03-09T10:31:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Must match the original signal type |
| `slug` | string | Must match the persona slug |
| `status` | string | `resolved` \| `acknowledged` \| `rejected` |
| `response` | object | Type-specific response data (host-defined shape) |
| `processed` | boolean | Start as `false`; persona sets `true` after reading |
| `timestamp` | ISO 8601 | When the host responded |

**Lookup semantics:** the persona reads the **last** entry where
`type === signal.type && slug === signal.slug && processed === false`.
The host writes new responses; the persona marks them processed after reading.

**Consuming via CLI:**
```bash
# Read and consume all pending responses (marks processed: true)
node scripts/state-sync.js responses

# Filter to a specific type
node scripts/state-sync.js responses agent_communication

# Peek without consuming (processed stays false)
node scripts/state-sync.js responses --peek

# Via OpenPersona CLI (pretty-printed)
openpersona state responses <slug>
openpersona state responses <slug> --type agent_communication
openpersona state responses <slug> --peek
openpersona state responses <slug> --json          # raw JSON
```

Emitting a signal with `state-sync.js signal` also automatically reads and marks the latest
matching response, so the persona sees the host's answer inline at emit time.

---

## Signal Types & Host Responsibilities

### `capability_gap`

The persona needs a capability (skill or faculty) that is not currently available.

**Payload:**
```json
{ "capability": "web_search", "reason": "User asked me to look up current news" }
```

**What the host can do:**
- Install or enable the missing skill/faculty through its own skill management
- Queue a `capability_unlock` pending command into the persona's state so it activates next session
- Respond with an available alternative

**Example response:**
```json
{
  "status": "resolved",
  "response": {
    "capability": "web_search",
    "message": "Skill installed. Active on next session.",
    "pendingCommand": { "type": "capability_unlock", "payload": { "skill": "web_search" } }
  }
}
```

---

### `tool_missing`

A required binary or external tool is not present in the host environment.

**Payload:**
```json
{ "tool": "ffmpeg", "requiredBy": "voice", "installHint": "brew install ffmpeg" }
```

**What the host can do:**
- Execute the install (if it has permission to run system commands)
- Surface a prompt to the operator requesting manual installation
- Respond with the install result or a deferred acknowledgement

**Example response:**
```json
{ "status": "resolved", "response": { "tool": "ffmpeg", "installed": true } }
```

---

### `scheduling`

The persona wants to schedule a future action — a reminder, a periodic check, a timed message.

**Payload:**
```json
{
  "action": "remind",
  "target": "user",
  "message": "Check on the sourdough starter",
  "at": "2026-03-09T18:00:00Z"
}
```

**What the host can do:**
- Create a cron job or one-shot timer through its scheduler
- Write to a heartbeat checklist file if approximate timing is acceptable
- Respond with a job ID so the persona can confirm or cancel later

**Example response:**
```json
{ "status": "resolved", "response": { "jobId": "job-8f3a", "scheduledAt": "2026-03-09T18:00:00Z" } }
```

---

### `file_io`

The persona needs to read or write a file outside its own skill pack directory.

**Payload:**
```json
{ "operation": "read", "path": "~/Documents/journal.md", "reason": "User asked me to summarize their notes" }
```

**What the host can do:**
- Proxy the read/write operation with appropriate permission checks
- Respond with the file content (for `read`) or a success/error acknowledgement (for `write`)
- Reject if the path is outside the allowed workspace

**Example response:**
```json
{ "status": "resolved", "response": { "operation": "read", "content": "..." } }
```

---

### `resource_limit`

The persona is approaching or has exceeded a resource constraint — API cost, token budget, memory, rate limit.

**Payload:**
```json
{ "resource": "api_cost", "current": 4.80, "limit": 5.00, "suggestion": "switch_to_cheaper_model" }
```

**What the host can do:**
- Switch the active model for this session to a cheaper option
- Alert the operator
- Respond with the new configuration so the persona can adjust its behavior

**Example response:**
```json
{ "status": "resolved", "response": { "action": "model_switched", "model": "claude-haiku-3-5" } }
```

---

### `agent_communication`

The persona wants to communicate with another agent. Three distinct intents are supported,
each with a different payload shape:

#### Intent: `send` — one-shot message (no persistent connection needed)

Used after `openpersona social send` has been called but the persona wants the host to be
aware the message was attempted (logging, audit trail).

```json
{
  "intent": "send",
  "target_agent_id": "agent-alice-001",
  "reason": "Delegating summarization task",
  "priority": "medium"
}
```

**What the host can do:** Log the outbound message; no active connection needed.

---

#### Intent: `connect` — request a persistent transport (WebSocket / SSE)

Used when the persona's `social.contacts.preferred_transport` is `"websocket"` and it wants
the host to establish a long-lived channel to a peer.

```json
{
  "intent": "connect",
  "target_agent_id": "agent-alice-001",
  "transport": "websocket",
  "endpoint": "wss://alice-bot.example.com/a2a/ws",
  "reason": "Need real-time collaboration for ongoing task",
  "priority": "high"
}
```

**Transport negotiation contract:**

The host should respond via `signal-responses.json` with **one of**:

```json
{
  "status": "resolved",
  "response": {
    "transport": "websocket",
    "channel_id": "ws-session-abc123",
    "note": "Messages from peer will arrive as pendingCommands of type agent_message"
  }
}
```

```json
{
  "status": "rejected",
  "response": {
    "reason": "websocket_unsupported",
    "fallback": "http",
    "note": "Use openpersona social send for HTTP delivery instead"
  }
}
```

The persona reads the response at the start of the next turn. If `status === "rejected"`,
the persona degrades gracefully (e.g., falls back to inbox-based delivery).

**Runner responsibilities when `transport: "websocket"` is requested:**
1. Establish a WebSocket connection to `endpoint`
2. Bridge incoming peer messages into `pendingCommands` as `{ type: "agent_message", payload: <msg>, source: target_agent_id }`
3. Route outbound messages from the persona (emitted via `agent_communication` with `intent: "send"`) through the open socket
4. Write `channel_id` to the response so the persona can reference it in future signals

If the runner does not support WebSocket proxying, it **must** respond with `status: "rejected"` and `fallback: "http"` so the persona does not wait indefinitely.

---

#### Intent: `receive` — declare readiness to receive inbound messages

Used when the persona wants the host to start routing inbound A2A messages to its
`pendingCommands` queue (Phase C inbox polling).

```json
{
  "intent": "receive",
  "reason": "Enable inbound agent messages",
  "priority": "low"
}
```

**What the host can do:**
- Start polling the ACN gateway inbox for this persona's `agent_id`
- Write received messages into the persona's `state.json.pendingCommands` as `agent_message` entries

**Example response:**
```json
{ "status": "resolved", "response": { "polling": true, "interval_seconds": 30 } }
```

---

**OpenClaw native mapping (updated):**

| Signal `agent_communication` intent | OpenClaw native action |
|-------------------------------------|----------------------|
| `send` | `sessions_send` tool |
| `connect` (websocket) | `websocket_proxy` plugin → bridge to `pendingCommands` |
| `receive` | `inbox_poller` plugin → poll ACN, write `pendingCommands` |

---

## Host Implementation Guide

### Minimal Reference Implementation (any runner)

A simple polling script that any host can run alongside its agent loop:

```js
// signal-handler.js — framework-agnostic reference implementation
const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve feedback dir — mirror the same logic as state-sync.js
// Explicit env wins: OPENCLAW_HOME → OPENPERSONA_HOME → ~/.openclaw → ~/.openpersona
function resolveFeedbackDir() {
  if (process.env.OPENCLAW_HOME) {
    return path.join(process.env.OPENCLAW_HOME, 'feedback');
  }
  if (process.env.OPENPERSONA_HOME) {
    return path.join(process.env.OPENPERSONA_HOME, 'feedback');
  }
  const clawHome = path.join(os.homedir(), '.openclaw');
  const opHome   = path.join(os.homedir(), '.openpersona');
  return fs.existsSync(clawHome)
    ? path.join(clawHome, 'feedback')
    : path.join(opHome, 'feedback');
}
const FEEDBACK_DIR = resolveFeedbackDir();

const SIGNALS_PATH = path.join(FEEDBACK_DIR, 'signals.json');
const RESPONSES_PATH = path.join(FEEDBACK_DIR, 'signal-responses.json');

function readJson(p) {
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function writeResponse(entry) {
  const responses = readJson(RESPONSES_PATH);
  responses.push({ ...entry, timestamp: new Date().toISOString() });
  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
  fs.writeFileSync(RESPONSES_PATH, JSON.stringify(responses, null, 2));
}

function isAnswered(signal, responses) {
  return responses.some(r =>
    r.type === signal.type && r.slug === signal.slug && !r.processed
  );
}

async function dispatch(signal) {
  switch (signal.type) {
    case 'capability_gap':
      // TODO: install skill via host's package manager, then queue pendingCommand
      writeResponse({ type: signal.type, slug: signal.slug, status: 'acknowledged',
        response: { message: `Capability gap noted: ${signal.payload.capability}` } });
      break;

    case 'scheduling':
      // TODO: create a job via host's scheduler
      writeResponse({ type: signal.type, slug: signal.slug, status: 'acknowledged',
        response: { message: 'Scheduling noted — implement host scheduler here.' } });
      break;

    case 'agent_communication':
      // TODO: route to target via host's inter-agent channel
      writeResponse({ type: signal.type, slug: signal.slug, status: 'acknowledged',
        response: { message: `Message routing to ${signal.payload.to} — implement here.` } });
      break;

    default:
      writeResponse({ type: signal.type, slug: signal.slug, status: 'acknowledged',
        response: { message: 'Signal received.' } });
  }
}

async function poll() {
  const signals = readJson(SIGNALS_PATH);
  const responses = readJson(RESPONSES_PATH);
  const pending = signals.filter(s => !isAnswered(s, responses));
  for (const signal of pending) {
    console.log('[signal-handler] Processing:', signal.type, signal.slug);
    await dispatch(signal);
  }
}

setInterval(poll, 10_000);
poll();
```

---

### Integration Points by Runner

Each runner has its own natural hook point for handling signals. The pattern is always the same:
**after a turn ends, scan for new signals; before the next turn starts, inject any responses**.

| Runner | After-turn hook | Before-turn injection |
|--------|----------------|----------------------|
| **OpenClaw** | `agent_end` plugin hook | `before_prompt_build` → `prependContext` |
| **Claude Code** | Post-turn script via hooks | Inject into `CLAUDE.md` or context file |
| **Cursor** | Background script / file watcher | Append to `AGENTS.md` or workspace context |
| **Codex** | Post-turn lifecycle script | Inject into `AGENTS.md` |
| **Custom runner** | Wrap agent loop | Prepend to system prompt on next invocation |

The two-file design is deliberate: any runner that can read/write files can participate, with no
SDK dependency and no changes to the runner's core.

---

### OpenClaw — Reference Implementation Detail

For OpenClaw specifically, the recommended path is a **plugin** using the `agent_end` and
`before_prompt_build` hooks:

```js
// In your OpenClaw plugin:

// agent_end — runs after every turn; persona has emitted its signals
async function agentEnd({ session }) {
  const signals = readNewSignals(session.personaSlug);
  for (const signal of signals) {
    await dispatchSignal(signal, session); // maps to OpenClaw native APIs below
  }
}

// before_prompt_build — runs before next turn; inject resolved responses
async function beforePromptBuild({ session }) {
  const pending = readPendingResponses(session.personaSlug);
  if (pending.length > 0) {
    return { prependContext: formatResponses(pending) };
  }
}
```

**Signal → OpenClaw native mapping:**

| Signal type | OpenClaw native action |
|-------------|----------------------|
| `capability_gap` | `openclaw skills install <name>` |
| `tool_missing` | `system.run` node → brew/npm install |
| `scheduling` | `openclaw cron add` (exact) or write `HEARTBEAT.md` (approximate) |
| `file_io` | `bash` tool with workspace permission |
| `resource_limit` | `sessions.patch` → model switch |
| `agent_communication` | `sessions_send` tool |

---

## Persona Configuration (`body.interface.signals`)

Personas can restrict their own signal emission via `persona.json`. This is the persona's
**interface declaration** — what it promises to ask of its host, and what it won't:

```json
{
  "body": {
    "interface": {
      "signals": {
        "enabled": true,
        "allowedTypes": ["capability_gap", "scheduling", "agent_communication"]
      }
    }
  }
}
```

- `enabled: false` — this persona never emits signals (fully passive mode)
- `allowedTypes` — explicit allowlist; omit to permit all six types

This lets companion and roleplay personas stay silent toward the host (default), while
autonomous agents declare the full signal surface they need.

---

## Co-Evolution Pattern

The Signal Protocol is designed to let a host **learn from its personas** over time:

```
Multiple personas emit capability_gap signals for "web_search"
                    ↓
Host logs demand across all installed personas
                    ↓
Host installs or enables the capability natively
                    ↓
Host writes responses; personas receive capability_unlock pendingCommands
                    ↓
All personas activate the capability on next session
```

A persona pack carries not just a personality — it carries a **demand signal for the host's
own capability growth**. The host that responds to its personas becomes progressively more
capable, shaped by the aggregate needs of the personas it runs.

This is the reverse-influence loop: personas act on their host, not just the other way around.
