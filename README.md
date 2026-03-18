# OpenEmber Plugins

OpenEmber is a multi-user AI assistant built on [OpenClaw](https://github.com/nicepkg/openclaw). This monorepo contains the plugin source code for the OpenEmber runtime.

## Project Structure

```
openember-plugins/
  openember-memory/        # Long-term memory plugin with multi-user isolation
    src/                   # TypeScript source
    dist/                  # Compiled output (after build)
    openclaw.plugin.json   # OpenClaw plugin manifest
    package.json
  package.json             # Workspace root
```

## Plugins

| Plugin | Description |
|--------|-------------|
| [openember-memory](./openember-memory/) | OpenViking-backed long-term memory with per-user isolation. Fork of the official `memory-openviking` plugin with multi-user support added. |

## Build

```bash
npm install
npm run build
```

This runs `tsc` in each workspace package.

## Deploy

After building, copy the plugin into the OpenClaw extensions directory:

```bash
cp -r openember-memory/dist   /path/to/openember/extensions/openember-memory/dist
cp    openember-memory/package.json /path/to/openember/extensions/openember-memory/
cp    openember-memory/openclaw.plugin.json /path/to/openember/extensions/openember-memory/
```

Then configure the plugin in `openclaw.json` (see the [memory plugin README](./openember-memory/README.md) for configuration details).

## Requirements

- Node.js >= 20
- OpenClaw >= 2026.2.15
- An OpenViking server (local or remote) for the memory plugin

## License

Private.
