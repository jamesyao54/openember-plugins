# openember-memory

OpenViking-backed long-term memory plugin for OpenClaw, with multi-user memory isolation.

## Overview

This plugin is a fork of the official [`memory-openviking`](https://github.com/nicepkg/OpenViking/tree/main/examples/openclaw-memory-plugin) plugin from the OpenViking project. The upstream plugin provides long-term memory for OpenClaw agents via an OpenViking server -- it handles auto-recall (injecting relevant memories before each agent turn), auto-capture (extracting memories after each conversation), and manual tools (`memory_recall`, `memory_store`, `memory_forget`).

The key addition in this fork is **multi-user memory isolation**. In multi-user chat scenarios -- Discord bots, Telegram bots, Feishu bots, etc. -- multiple users interact with the same agent. Without isolation, all users' memories are stored in and recalled from a single shared space, causing cross-contamination: User A's personal preferences leaking into User B's context.

This fork ensures each user gets a private memory space while still sharing agent-level common memories.

**Compatible with OpenViking v0.2.8+ and OpenClaw v0.2.9+ (context-engine architecture).**

## Why Fork

The official plugin assumes a single-user environment (like Claude Code's CLI, where one human operates one agent). It uses a single `OpenVikingClient` instance shared across all requests, and all memory operations target the same `viking://user/memories` namespace.

In OpenClaw's gateway mode with channel integrations (Discord, Telegram, Feishu), the picture changes:

- Multiple users send messages to the same agent concurrently.
- The hooks fire for every user's request, but the shared client has no concept of "which user is this for."
- All memories -- from all users -- end up in the same `viking://user/{space}/memories` path.

This means User A asking "remember that I prefer dark mode" would be recalled for User B's next question. The fork solves this by routing each user's memory operations to an isolated namespace.

## Architecture -- Context Engine (v0.2.9)

Starting from OpenClaw v0.2.9, the plugin system introduced a new `context-engine` kind that replaces the legacy `memory` kind. This plugin has been upgraded to this architecture:

### Plugin Kind

```json
// openclaw.plugin.json
"kind": "context-engine"    // was: "memory"

// openclaw.json
"slots": {
  "contextEngine": "openember-memory"   // was: "memory"
}
```

### Hook Migration

| Old (v0.2.6) | New (v0.2.9) | Purpose |
|--------------|--------------|---------|
| `before_agent_start` | `before_prompt_build` | Auto-recall: inject relevant memories into context |
| `agent_end` (auto-capture logic) | `ContextEngine.afterTurn()` | Auto-capture: extract memories from new messages |
| -- | `session_start` / `session_end` | Track agentId per session for multi-agent support |
| -- | `before_reset` / `after_compaction` | Reserved hooks (no-op) |

### ContextEngine Interface

The plugin registers a `ContextEngine` via `api.registerContextEngine()` with these methods:

| Method | Behavior |
|--------|----------|
| `ingest()` | No-op (OpenViking handles ingestion via sessions) |
| `ingestBatch()` | No-op |
| `assemble()` | Pass-through (context assembly handled by `before_prompt_build` hook) |
| `afterTurn()` | **Auto-capture with multi-user isolation** -- resolves userId from messages, creates a user-routed client, captures new messages using `prePromptMessageCount` as the starting index |
| `compact()` | No-op (delegates to legacy compact engine) |

### Key Improvements Over v0.2.6

- **No more `lastProcessedMsgCount` state**: `afterTurn()` uses `prePromptMessageCount` from OpenClaw to determine which messages are new, eliminating the stateful counter that caused first-run capture issues.
- **Client init timeout**: `getClient()` wraps the client promise with a 5-second timeout to prevent hooks from hanging on a dead client.
- **Multi-agent session tracking**: A `sessionAgentIds` map tracks agentId per session, allowing the shared client to switch agentId dynamically via `setAgentId()`.

## Architecture -- Multi-User Isolation

### Isolation Model

Each user gets their own memory spaces on the OpenViking server. The isolation is implemented via two mechanisms working together:

1. **`X-OpenViking-User` and `X-OpenViking-Account` headers**: Sent on every HTTP request. `X-OpenViking-User` is the sanitized userId (colons replaced with underscores, e.g. `discord_123456`); `X-OpenViking-Account` is `"default"` (single-tenant). v0.2.8 requires both headers for ROOT key requests to data APIs. The server uses these to derive two spaces:
   - `user_space = userId` -- for user-private memories (profile, preferences, entities, events)
   - `agent_space = md5(userId + ":" + agentId)[:12]` -- for agent-scoped memories (cases, patterns)

2. **Client-computed target URIs**: The find API does not auto-route based on headers when `target_uri` is provided, so the client computes the correct URIs:
   - `viking://user/{sanitizedUserId}/memories` -- user scope
   - `viking://agent/{md5(userId + ":" + agentId)[:12]}/memories` -- agent scope

This ensures:

- **Different users on the same agent** have isolated memories in both scopes.
- **Same user on different agents** shares user-scope memories (profile, preferences), but agent-scope memories (cases, patterns) are isolated per agent.
- **Without userId** (anonymous): searches default spaces only.

### URI Routing

**With a resolved userId (e.g. `discord_1112318905768231003`):**

```
capture (afterTurn / memory_store):
  X-OpenViking-User: discord_1112318905768231003
  X-OpenViking-Agent: ember
  → server writes profile/preferences/entities/events to viking://user/discord_1112318905768231003/memories/
  → server writes cases/patterns to viking://agent/{md5("discord_1112318905768231003"+"ember")[:12]}/memories/

recall (before_prompt_build / memory_recall):
  Two parallel searches with client-computed URIs:
    1. viking://user/discord_1112318905768231003/memories → user's private memories
    2. viking://agent/{agentSpaceHash}/memories → user's agent-scoped cases/patterns
  Results are merged and deduplicated.
```

### Multi-Scope Search

When a userId is available, recall performs a parallel two-scope search (`searchMemories`):

1. **User scope**: `viking://user/{sanitizedUserId}/memories` -- profile, preferences, entities, events.
2. **Agent scope**: `viking://agent/{agentSpaceName(userId, agentId)}/memories` -- cases, patterns.

Results from both scopes are merged, deduplicated by URI, and filtered to leaf-level memories (level 2) before ranking and injection.

## Architecture -- User ID Resolution

The plugin must determine which user is making the current request. This is handled by `user-resolve.ts` with a three-level fallback strategy:

### Level 1: Private Chat (sessionKey)

In direct/private messages, OpenClaw's `sessionKey` encodes the peer identity:

```
sessionKey = "agent:ember:direct:discord:123456"
                                  └─────────────┘
                                  peerId = "discord:123456"
```

Regex: `/^agent:[^:]+:direct:(.+)$/`

This is the most reliable source -- it comes from OpenClaw's session management, not from user-controlled input.

### Level 2: Group Chat (prompt metadata)

In group chats, the sessionKey identifies the group, not the sender. OpenClaw injects sender metadata into the prompt as JSON blocks:

```
Sender (untrusted metadata): ```json
{"userId": "discord:123456", "nickname": "Alice"}
```​

or:

```
Conversation info (untrusted metadata): ```json
{"sender_id": "discord:123456", "group_id": "..."}
```​
```

The plugin parses these blocks and extracts `userId`, `senderId`, `sender_id`, `sender`, `user_id`, or `id` fields.

### Level 3: Fallback

If neither method produces a userId, it returns `null`. The plugin then operates in anonymous mode: memories are stored/recalled from agent shared space only.

### Tool Context vs Hook Context

The plugin uses two different resolution paths depending on the call site:

- **Tools** (`memory_recall`, `memory_store`, `memory_forget`): Use `ctx.requesterSenderId` from the tool context, falling back to `resolveUserId(sessionKey)`. The `requesterSenderId` field is the most stable identifier in group chat because it comes directly from OpenClaw's request tracking.

- **Hooks** (`before_prompt_build`): Use `resolveUserId(sessionKey, prompt)` for the recall hook (has access to prompt text).

- **ContextEngine** (`afterTurn`): Use `resolveUserIdFromMessages(sessionId, messages)` which walks raw message objects in reverse to find sender metadata, since the sanitized prompt text may have metadata stripped.

## Differences from Official Plugin

### New Files

| File | Purpose |
|------|---------|
| `user-resolve.ts` | userId resolution from sessionKey and prompt metadata (three-level fallback) |
| `context-engine.ts` | ContextEngine implementation with `afterTurn()` auto-capture and multi-user isolation |
| `test/unit.test.mjs` | Unit tests for all modules (40 tests covering text-utils, client, config, user-resolve, memory-ranking, context-engine) |

### Modified Files

**`client.ts`** -- Major changes:

- Added `userId` private field and `setUserId()` / `setAgentId()` / `getAgentId()` methods for per-request identity switching.
- Added `X-OpenViking-User` and `X-OpenViking-Account` header injection in the `request()` method.
- Added `sanitizeUserId()` and `agentSpaceName()` exports for client-side URI computation. `agentSpaceName` matches OpenViking v0.2.8 server logic: `md5(userId + ":" + agentId)[:12]`.
- Removed `resolveScopeSpace()`, `getRuntimeIdentity()`, and `ls()` -- the upstream uses server-side directory listing to discover the user's space directory; this fork computes URIs client-side instead.

**`index.ts`** -- Major rewrite for context-engine architecture:

- Changed plugin `kind` from `"memory"` to `"context-engine"`.
- Inlined `OpenClawPluginApi` type with `registerContextEngine?` method (avoids stale SDK type imports).
- Added `session_start` / `session_end` / `before_reset` / `after_compaction` hooks.
- Renamed `before_agent_start` hook to `before_prompt_build`.
- Added `withTimeout()` wrapper on `getClient()` with 5-second init timeout.
- Added `sessionAgentIds` map for multi-agent session tracking with `rememberSessionAgentId()` / `resolveSessionAgentId()` helpers.
- Moved auto-capture logic from `agent_end` hook to `ContextEngine.afterTurn()` (in `context-engine.ts`).
- `agent_end` hook now only tracks agentId (no capture logic).
- Registers ContextEngine via `api.registerContextEngine()` with graceful fallback if unavailable.
- Tool registration uses the **tool factory pattern** for per-request user context.
- Added `createConfiguredClient()` helper for per-operation client creation.
- Auto-recall hook skips health precheck for remote mode.

**`text-utils.ts`** -- Added v0.2.9 functions:

- `CAPTURE_LIMIT` constant (24,000 chars max per capture session).
- `normalizeCaptureDedupeText()` for capture deduplication.
- `pickRecentUniqueTexts()` for selecting recent unique texts within a character limit.

**`config.ts`** -- Minor addition:

- Added `DEFAULT_MEMORY_OPENVIKING_DATA_DIR` export (`~/.openviking`).

**`openclaw.plugin.json`** -- Kind change:

- `"kind": "memory"` → `"kind": "context-engine"`.

### Unchanged Files

| File | Purpose |
|------|---------|
| `user-resolve.ts` | Multi-user identity resolution (our unique addition, not in upstream) |
| `memory-ranking.ts` | Memory scoring, deduplication, and ranking |
| `process-manager.ts` | Local OpenViking server process management, health checks |

## Configuration

Add the plugin to your `openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "slots": {
      "contextEngine": "openember-memory"
    },
    "entries": {
      "openember-memory": {
        "config": {
          "mode": "remote",
          "baseUrl": "http://your-openviking-server:1023",
          "apiKey": "your-api-key",
          "autoRecall": true,
          "autoCapture": true,
          "recallLimit": 6,
          "timeoutMs": 120000
        }
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `"local"` \| `"remote"` | `"local"` | `local` spawns an OpenViking child process; `remote` connects to an existing server |
| `baseUrl` | string | `http://127.0.0.1:1933` | OpenViking server URL (used in remote mode) |
| `apiKey` | string | `""` | API key for OpenViking server authentication |
| `agentId` | string | `"default"` | Agent identifier sent as `X-OpenViking-Agent` header |
| `targetUri` | string | `viking://user/memories` | Default search scope URI |
| `timeoutMs` | number | `15000` | HTTP request timeout in milliseconds |
| `autoRecall` | boolean | `true` | Inject relevant memories into context before each agent turn |
| `autoCapture` | boolean | `true` | Extract memories from conversation after each agent turn |
| `captureMode` | `"semantic"` \| `"keyword"` | `"semantic"` | `semantic` captures all eligible text; `keyword` requires trigger patterns |
| `captureMaxLength` | number | `24000` | Maximum text length for auto-capture |
| `recallLimit` | number | `6` | Maximum memories injected per recall |
| `recallScoreThreshold` | number | `0.01` | Minimum relevance score for recalled memories |
| `configPath` | string | `~/.openviking/ov.conf` | Path to OpenViking config file (local mode only) |
| `port` | number | `1933` | Port for local OpenViking server (local mode only) |
| `ingestReplyAssist` | boolean | `true` | Add reply instruction when transcript-like ingestion is detected |

### Environment Variables

- `OPENVIKING_API_KEY` -- fallback API key if `apiKey` is not set in config
- `OPENVIKING_BASE_URL` / `OPENVIKING_URL` -- fallback base URL for remote mode

Config values support `${ENV_VAR}` syntax for environment variable interpolation.

## Testing

Run unit tests (requires `npm run build` first):

```bash
npm run build
node --test test/unit.test.mjs
```

40 tests covering:
- `text-utils`: capture decisions, text extraction, deduplication, sanitization
- `client`: userId sanitization, agentSpaceName hashing, URI validation, agentId get/set
- `config`: schema defaults, remote mode parsing, data dir export
- `user-resolve`: sessionKey parsing, metadata block extraction, userId resolution priority
- `memory-ranking`: score clamping, deduplication, filtering
- `context-engine`: ingest/assemble no-ops, afterTurn capture with userId isolation, skip conditions

## Known Limitations

- **No cross-platform user unification.** A user who chats via Discord (userId `discord:123`) and Feishu (userId `ou_xxx`) is treated as two separate users with independent memory spaces, even if they are the same person. There is no identity linking layer.

- **OpenViking extract latency.** The memory extraction step (`/api/v1/sessions/{id}/extract`) calls the LLM to analyze conversation text and produce structured memories. On remote servers, this can take 10-70 seconds depending on text length and server load. Set `timeoutMs` to at least `120000` (2 minutes) for remote deployments.

- **Group chat userId resolution depends on OpenClaw's metadata format.** The plugin parses `Sender (untrusted metadata): ```json ... ``` ` and `Conversation info (untrusted metadata): ```json ... ``` ` blocks from the prompt. If OpenClaw changes this format upstream, the regex-based parsing will break silently (falling back to anonymous/shared memory).

- **Auto-recall timeout is fixed at 5 seconds.** The `AUTO_RECALL_TIMEOUT_MS` constant is not configurable. On slow networks or under heavy server load, auto-recall may time out and be silently skipped. Manual `memory_recall` tool calls use the full `timeoutMs` and are not affected.

- **Requires OpenClaw v0.2.9+ for context-engine.** If `api.registerContextEngine` is not available (older OpenClaw), the plugin logs a warning and auto-capture via `afterTurn()` is disabled. Auto-recall via `before_prompt_build` still works.

## Source Files

| File | Description |
|------|-------------|
| `src/index.ts` | Plugin entry point. Registers tools (via factory), hooks (`before_prompt_build` for auto-recall, `session_start/end` for agentId tracking), ContextEngine (for auto-capture via `afterTurn`), and the service lifecycle. |
| `src/context-engine.ts` | ContextEngine implementation. Handles `afterTurn()` auto-capture with multi-user isolation: resolves userId from messages, creates user-routed clients, uses `prePromptMessageCount` for new message indexing. |
| `src/client.ts` | HTTP client for the OpenViking API. Handles `X-OpenViking-User`/`X-OpenViking-Account` header injection, `getAgentId()`/`setAgentId()` for multi-agent support, and all CRUD operations (find, read, create/delete session, extract). |
| `src/user-resolve.ts` | Multi-user identity resolution. Three-level fallback: sessionKey peer extraction, prompt metadata parsing, null fallback. |
| `src/config.ts` | Configuration schema definition, validation, and defaults. Supports environment variable interpolation. |
| `src/memory-ranking.ts` | Memory post-processing: score clamping, deduplication, ranking by relevance, selection for context injection. |
| `src/text-utils.ts` | Text extraction from message arrays, capture decision logic (length/content filtering), transcript-like ingestion detection, capture deduplication utilities. |
| `src/process-manager.ts` | Local OpenViking server process management: Python command resolution, port preparation, health check polling, timeout utilities. |
| `openclaw.plugin.json` | OpenClaw plugin manifest declaring the plugin id, kind (`context-engine`), config schema, and UI hints. |
| `test/unit.test.mjs` | Unit tests (40 tests) using Node.js built-in test runner. |
