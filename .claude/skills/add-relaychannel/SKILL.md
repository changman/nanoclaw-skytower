---
name: add-relaychannel
description: Add Relay as a channel. Connects NanoClaw to a web UI relay server via Socket.io, enabling chat from a browser. Supports multiple relay instances. Triggers on "add relay", "relay channel", "web UI channel", or relay setup requests.
---

# Add Relay Channel

This skill adds the Relay channel to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/relay.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### What is the Relay channel?

Relay connects NanoClaw to a web UI relay server via Socket.io. Each relay instance has:
- `url` — the relay server URL
- `agentId` — the agent ID registered on the relay server
- `token` — authentication token in `agentId:rawToken` format
- `name` — display name (optional)

Multiple relay instances can run simultaneously via `RELAY_CHANNELS` JSON array.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `skytower` remote is missing, add it:

```bash
git remote add skytower git@github.com:changman/nanoclaw-skytower.git
```

### Merge the skill branch

```bash
git fetch skytower skytower-relay
git merge skytower/skytower-relay --no-edit || {
  git checkout --theirs package-lock.json 2>/dev/null
  git add package-lock.json
  git merge --continue --no-edit
}
```

This merges in:
- `src/channels/relay.ts` — RelayChannel implementation (multi-instance, auto-registration, per-conversation IPC isolation)
- `import './relay.js'` appended to `src/channels/index.ts`
- `src/config.ts` — `RELAY_URL`, `RELAY_AGENT_ID`, `RELAY_AGENT_TOKEN`, `RELAY_CHANNELS` exports
- `socket.io-client` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Collect relay server information

Ask the user for their relay server details:

> I need the relay server connection info. Please provide:
>
> 1. **Relay server URL** (e.g. `https://relay.example.com`)
> 2. **Agent ID** — the agent ID registered on the relay server
> 3. **Token** — authentication token in `agentId:rawToken` format

Wait for the user to provide these values.

### Single instance vs. multiple instances

AskUserQuestion: Do you want to configure a single relay instance or multiple?

1. **Single** — one relay server
2. **Multiple** — connect to more than one relay server simultaneously

#### Single instance

Add to `.env`:

```bash
RELAY_CHANNELS='[{"url":"<url>","agentId":"<agentId>","token":"<agentId>:<rawToken>","name":"<name>"}]'
```

#### Multiple instances

Build a JSON array. For each additional instance, collect the same fields (url, agentId, token, name).

Add to `.env`:

```bash
RELAY_CHANNELS='[
  {"url":"<url1>","agentId":"<agentId1>","token":"<agentId1>:<rawToken1>","name":"<name1>"},
  {"url":"<url2>","agentId":"<agentId2>","token":"<agentId2>:<rawToken2>","name":"<name2>"}
]'
```

### Sync to container environment

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

## Phase 4: Register groups

Relay groups are auto-registered when a user sends their first message — no manual registration needed. Each user gets a JID in the format `relay:{agentId}:c{conversationId}`.

If you want to pre-register a group (e.g. to set it as main):

```bash
npx tsx setup/index.ts --step register -- --jid "relay:<agentId>:c<conversationId>" --name "<name>" --folder "relay_<name>" --channel relay --no-trigger-required --is-main
```

## Phase 5: Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Open your relay web UI and send a message. NanoClaw should respond within a few seconds.
>
> Check logs if needed:
> ```bash
> tail -f logs/nanoclaw.log
> ```

Look for log lines like:
- `relay connected` — socket connected successfully
- `relay:inbound` — message received from relay server

## Troubleshooting

### Relay not connecting

Check:
1. `RELAY_CHANNELS` is set in `.env` AND synced to `data/env/env`
2. Token format is `agentId:rawToken` (colon-separated)
3. Relay server is reachable: `curl -s <url>/health`
4. Service is running: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)

### Not responding to messages

1. Check `RELAY_CHANNELS` JSON is valid: `echo $RELAY_CHANNELS | jq .`
2. Check logs: `tail -f logs/nanoclaw.log`
3. Verify agent is auto-registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'relay:%'"`

### Multiple instances conflict

Each instance must have a unique `agentId`. Check for duplicate agentIds in `RELAY_CHANNELS`.

## Removal

To remove Relay integration:

1. Delete `src/channels/relay.ts`
2. Remove `import './relay.js'` from `src/channels/index.ts`
3. Remove `RELAY_CHANNELS`, `RELAY_URL`, `RELAY_AGENT_ID`, `RELAY_AGENT_TOKEN` from `.env`
4. Remove relay registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'relay:%'"`
5. Uninstall: `npm uninstall socket.io-client`
6. Rebuild: `npm run build && systemctl --user restart nanoclaw` (Linux) or `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
