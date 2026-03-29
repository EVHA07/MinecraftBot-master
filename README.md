# Minecraft Bot

Minecraft Bot is a Mineflayer-based multi-session bot runtime with a local control UI.

This repository currently serves two purposes:

- the standalone `termux-bot/` runtime that can run directly on Termux or be embedded into an Android app
- the original workspace apps under `artifacts/` for local web/API development

The Android app UI/controller can live in a separate Android Studio project, while this repository provides the runtime, API, chat flow, saved-session logic, and Android runtime packaging script.

## Main Features

- Mineflayer runtime with `auth: "offline"`
- Multi-bot support by `botId`
- Connect, reconnect, disconnect, and disconnect-all actions
- Saved sessions that remain available after disconnect
- Bot chat API and log stream
- Built-in lightweight HTML control page in `termux-bot/public/`
- Runtime packaging script for bundling `termux-bot` into an Android app

## Repository Layout

```text
.
|-- artifacts/
|   |-- api-server/
|   |-- minecraft-bot/
|   `-- mockup-sandbox/
|-- lib/
|-- scripts/
|   `-- prepare-android-runtime.mjs
|-- termux-bot/
|   |-- public/
|   |-- server.mjs
|   |-- package.json
|   `-- README.md
|-- package.json
|-- pnpm-workspace.yaml
`-- README.md
```

## Recommended Path

If you only want the bot runtime used by the Android app or Termux setup, focus on:

- [termux-bot/README.md](termux-bot/README.md)
- [scripts/prepare-android-runtime.mjs](scripts/prepare-android-runtime.mjs)

If you want the original local workspace with API server + Vite dashboard, use the root `pnpm` workspace commands described below.

## Termux Bot Runtime

The `termux-bot/` folder is the runtime currently aligned with the Android app flow.

It provides:

- `GET /api/healthz`
- `POST /api/bot/connect`
- `POST /api/bot/disconnect`
- `POST /api/bot/chat`
- `GET /api/bots/status`
- `GET /api/bots/saved`
- `GET /api/bots/logs`
- `POST /api/bots/disconnect-all`
- WebSocket endpoint at `/ws`

Quick start:

```powershell
cd termux-bot
npm install
npm start
```

Default local URL:

```text
http://127.0.0.1:8080/
```

Notes:

- sessions are stored in `termux-bot/.data/bot-sessions.json`
- the runtime is intended for offline-mode or otherwise compatible servers
- this setup is good for personal use and testing, but not ideal for 24/7 hosting

## Android Runtime Packaging

This repository includes a helper script that copies `termux-bot/` into an Android app asset runtime directory.

Requirements before running it:

- install dependencies inside `termux-bot/`
- make sure `termux-bot/node_modules` exists

Example:

```powershell
cd termux-bot
npm install
cd ..
node .\scripts\prepare-android-runtime.mjs "C:\path\to\AndroidProject\app\src\main\assets\runtime"
```

What the script does:

- copies `termux-bot/` into the target runtime asset directory
- skips `.data`, `.pnpm-store`, `pnpm-lock.yaml`, and the local Termux README
- writes `manifest.properties` with a fresh runtime version and default runtime port `38080`

## Workspace Apps

The repository still contains the original workspace apps:

- `artifacts/api-server`: Express API for the original Mineflayer dashboard flow
- `artifacts/minecraft-bot`: React + Vite dashboard

Use this path if you want the original local web development experience.

Requirements:

- Node.js 24
- pnpm 10

Install `pnpm` on Windows PowerShell:

```powershell
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

Fallback:

```powershell
npm install -g pnpm
pnpm -v
```

Workspace quick start:

```powershell
pnpm install
pnpm run dev
```

Local workspace URLs:

- API server: `http://127.0.0.1:8080`
- Web dashboard: `http://127.0.0.1:23418/minecraft-bot/`

Available workspace commands:

```powershell
pnpm run dev
pnpm run dev:api
pnpm run dev:web
pnpm run typecheck
pnpm run build
```

## Troubleshooting

### `pnpm` is not recognized

```powershell
corepack enable
corepack prepare pnpm@10 --activate
```

### `termux-bot/node_modules` is missing

Run:

```powershell
cd termux-bot
npm install
```

### Android runtime packaging fails

Make sure the destination folder points to an Android app runtime asset directory, for example:

```text
app/src/main/assets/runtime
```

### Bot cannot join a server

The runtime currently uses offline authentication. Servers that require verified usernames or premium account enforcement will reject the bot.

### Workspace dashboard loads but API does not respond

Check that:

- the API server is running
- the web dashboard proxy still points to the correct API port
- local ports are not already in use
