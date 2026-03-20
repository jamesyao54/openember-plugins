# Deployment Guide

## Prerequisites

- Node.js >= 20
- OpenClaw >= 2026.3.13 installed and configured
- An OpenViking server (local or remote)
- A running OpenEmber gateway instance

## 1. Build

```bash
cd openember-plugins
npm install
npm run build
```

## 2. Copy to Extensions

Copy the compiled dist and plugin manifest into the gateway's extensions directory:

```bash
GATEWAY_DIR=/path/to/openember  # e.g. /Users/james/Documents/AI/code/openember

# Create extension directory if it doesn't exist
mkdir -p "$GATEWAY_DIR/extensions/openember-memory"

# Copy files
cp -R openember-memory/dist           "$GATEWAY_DIR/extensions/openember-memory/dist"
cp    openember-memory/openclaw.plugin.json "$GATEWAY_DIR/extensions/openember-memory/"
cp    openember-memory/package.json    "$GATEWAY_DIR/extensions/openember-memory/"
```

## 3. Configure

### openclaw.json (runtime config)

Add or update the `openember-memory` entry under `plugins.entries`:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openember-memory"],
    "slots": {
      "contextEngine": "openember-memory"
    },
    "entries": {
      "openember-memory": {
        "config": {
          "mode": "remote",
          "baseUrl": "http://your-openviking-host:1023",
          "apiKey": "your-api-key",
          "autoRecall": true,
          "autoCapture": true,
          "recallLimit": 6,
          "timeoutMs": 120000,
          "userProfiles": {
            "enabled": true,
            "dataDir": "/absolute/path/to/users",
            "autoCreateProfile": true,
            "injectProfile": true
          }
        }
      }
    }
  }
}
```

### openclaw.yaml (declarative config)

```yaml
plugins:
  enabled: true
  slots:
    memory: openember-memory
  entries:
    openember-memory:
      source: ./extensions/openember-memory
      config:
        baseUrl: "http://your-openviking-host:1023"
        apiKey: "your-api-key"
        userProfiles:
          enabled: true
          dataDir: /absolute/path/to/users
          autoCreateProfile: true
          injectProfile: true
```

### Config Reference

#### Memory (Core)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | `"local" \| "remote"` | `"local"` | `local` starts OpenViking as child process; `remote` uses existing server |
| `baseUrl` | string | `http://127.0.0.1:1933` | OpenViking server URL (remote mode) |
| `apiKey` | string | | API key for OpenViking |
| `agentId` | string | `"default"` | Agent identifier sent to OpenViking |
| `autoRecall` | boolean | `true` | Inject relevant memories into prompt context |
| `autoCapture` | boolean | `true` | Extract memories from conversation after each turn |
| `recallLimit` | number | `6` | Max memories to inject |
| `recallScoreThreshold` | number | `0.01` | Minimum score for recalled memories |
| `timeoutMs` | number | `15000` | HTTP request timeout |
| `captureMode` | `"semantic" \| "keyword"` | `"semantic"` | Capture strategy |
| `captureMaxLength` | number | `24000` | Max text length for capture |

#### User Profiles

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `userProfiles.enabled` | boolean | `false` | Enable the user profiles system |
| `userProfiles.dataDir` | string | `~/.openember/users` | **Absolute path** to directory for `identity-map.json` and `profiles.json` |
| `userProfiles.tokenTtlMs` | number | `600000` (10min) | How long a `/bind` token stays valid |
| `userProfiles.autoCreateProfile` | boolean | `true` | Auto-create profile on first message from unknown user |
| `userProfiles.injectProfile` | boolean | `true` | Inject `<user-profile>` block into agent system context |

> **Important**: `dataDir` must be an **absolute path**. Relative paths will resolve against `process.cwd()` at startup, which may not be the project directory.

## 4. Create Data Directory

```bash
mkdir -p /absolute/path/to/users
```

The plugin will auto-create `identity-map.json` and `profiles.json` on first write.

## 5. Restart Gateway

The gateway auto-restarts on SIGTERM:

```bash
kill $(pgrep -f openclaw-gateway)
```

Or if using `openclaw` CLI:

```bash
openclaw restart
```

## 6. Verify

After restart, check the gateway log:

```bash
tail -20 /path/to/openember/logs/gateway.log
```

You should see:

```
openember-memory: user profiles enabled (dataDir=/absolute/path/to/users)
user-profiles: registered commands, tools, and hooks
openember-memory: registered context-engine
openember-memory: initialized (url: http://..., targetUri: viking://user/memories)
```

Confirm the command count increased (e.g. from 47 to 50 — `/bind`, `/verify`, `/profile`).

## 7. Test

### Auto-create
Send a message from Discord. Check the data files:

```bash
cat /path/to/users/identity-map.json
# Should show: {"discord:<your-discord-id>": "<canonical-id>"}

cat /path/to/users/profiles.json
# Should show a profile entry with your canonical ID
```

### Profile Injection
Check the gateway log for `before_prompt_build` entries:

```bash
grep "before_prompt_build" /path/to/openember/logs/gateway.log | tail -5
# userId should be a 12-char hex canonical ID, not a raw Discord numeric ID
```

### Commands
In Discord:
- `/profile` — view your profile
- `/bind` — get a 6-char code to link another channel
- `/verify <code>` — link identity from another channel

### Agent Profile Updates
The agent will automatically call `user_profile_update` when it learns stable facts about a user (name, language, timezone, etc.). Check:

```bash
cat /path/to/users/profiles.json | python3 -m json.tool
```

## Disabling User Profiles

Set `enabled: false` or remove the `userProfiles` section entirely. The plugin will behave exactly as before — raw channel IDs for memory isolation, no commands/tools/hooks registered.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EACCES: permission denied, open '/users/...'` | `dataDir` is relative, resolved to wrong path | Use absolute path |
| `command registration failed: Command handler must be a function` | Old plugin code deployed | Rebuild and redeploy `dist/` |
| Same user gets two profiles (different providers) | `channelId` was a numeric Discord channel ID | Update to latest code (fixed in identity-resolve.ts) |
| `/profile` returns "No profile found" | Command context lacks session info | Update to latest code (uses `ctx.channel` + `ctx.senderId`) |
| `<user-profile>` appears in recall queries | Old text-utils without profile strip | Update to latest code (strips `<user-profile>` blocks) |
| Agent never calls `user_profile_update` | No instruction in profile block | Update to latest code (instruction added to `<user-profile>`) |

## File Layout (Runtime)

```
openember/
  extensions/
    openember-memory/
      dist/                    # Compiled plugin JS
        user-profiles/         # User profiles module
      openclaw.plugin.json     # Plugin manifest
      package.json
  users/                       # User profiles data (dataDir)
    identity-map.json          # {"provider:externalId": "canonicalId"}
    profiles.json              # {"canonicalId": {profile object}}
  openclaw.json                # Runtime config
  openclaw.yaml                # Declarative config
  logs/
    gateway.log                # Gateway stdout log
    gateway.err.log            # Gateway stderr log
```
