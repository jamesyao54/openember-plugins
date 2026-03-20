# OpenEmber Plugins

OpenEmber is a multi-user AI assistant built on [OpenClaw](https://github.com/nicepkg/openclaw). This monorepo contains the plugin source code for the OpenEmber runtime.

## Project Structure

```
openember-plugins/
  openember-memory/
    src/
      user-profiles/       # Cross-channel user identity & profiles module
        types.ts            # Data model types
        store.ts            # JSON file-backed ProfileStore
        identity-resolve.ts # Extract & resolve external identities
        bind-flow.ts        # /bind + /verify token flow
        migration.ts        # Memory namespace migration on identity merge
        index.ts            # Module entry — registers commands, tools, hooks
      config.ts             # Plugin config (incl. userProfiles section)
      index.ts              # Main plugin entry
      client.ts             # OpenViking HTTP client
      context-engine.ts     # ContextEngine (afterTurn auto-capture)
      user-resolve.ts       # Legacy userId resolution
      text-utils.ts         # Text sanitization & capture logic
      memory-ranking.ts     # Memory scoring & injection ranking
      process-manager.ts    # Local OpenViking process management
    test/
      unit.test.mjs         # Unit tests (existing modules)
      store.test.mjs        # ProfileStore unit tests
      identity-resolve.test.mjs
      bind-flow.test.mjs
      config.test.mjs
      integration.test.mjs  # End-to-end integration tests
    dist/                   # Compiled output (after build)
    openclaw.plugin.json    # OpenClaw plugin manifest
    package.json
  package.json              # Workspace root
```

## Plugins

| Plugin | Description |
|--------|-------------|
| [openember-memory](./openember-memory/) | OpenViking-backed long-term memory with per-user isolation and optional cross-channel user profiles. |

## Features

### Memory (Core)
- Auto-recall: injects relevant memories into agent context on each prompt
- Auto-capture: extracts memories from conversation after each turn
- Multi-user isolation via `X-OpenViking-User` header
- Tools: `memory_recall`, `memory_store`, `memory_forget`

### User Profiles (Optional, gated by `userProfiles.enabled`)
- Canonical user IDs that unify identities across Discord, Telegram, webchat, etc.
- Auto-create profile on first message from new user
- `/bind` + `/verify` commands for user-initiated cross-channel identity linking
- `/profile` command to view current profile
- `user_profile_update` tool for agent to save learned user facts
- `<user-profile>` block injected into agent system context
- Memory namespace migration when identities are merged

## Build

```bash
npm install
npm run build
```

## Test

```bash
cd openember-memory
npm test              # All tests (unit + integration)
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests only
```

## Deploy

See [deploy.md](./deploy.md) for detailed deployment instructions.

Quick deploy:

```bash
npm run build
cp -r openember-memory/dist   /path/to/openember/extensions/openember-memory/dist
cp    openember-memory/openclaw.plugin.json /path/to/openember/extensions/openember-memory/
```

## Requirements

- Node.js >= 20
- OpenClaw >= 2026.3.13
- An OpenViking server (local or remote) for the memory plugin

## License

Private.
