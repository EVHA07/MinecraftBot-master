# MinecraftBot Workspace

Monorepo for a local Minecraft bot dashboard and API server.

The project has two main apps:

- `artifacts/api-server`: Express API that manages the Mineflayer bot
- `artifacts/minecraft-bot`: React + Vite dashboard for connect, status, logs, and chat

## Requirements

- Node.js 24
- pnpm 10

If `pnpm` is not installed yet, on Windows PowerShell run:

```powershell
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

Fallback if Corepack does not work:

```powershell
npm install -g pnpm
pnpm -v
```

## Quick Start

From the project root:

```powershell
pnpm install
pnpm run dev
```

Then open:

```text
http://127.0.0.1:23418/minecraft-bot/
```

The root `dev` command starts both services together:

- API server: `http://127.0.0.1:8080`
- Web dashboard: `http://127.0.0.1:23418/minecraft-bot/`

The Vite dev server proxies `/api` and `/ws` to the API server automatically during local development.

## Environment

You can copy `.env.example` to `.env` and adjust values if needed:

```powershell
Copy-Item .env.example .env
```

Default variables:

```env
API_PORT=8080
WEB_PORT=23418
WEB_BASE_PATH=/minecraft-bot/
VITE_API_PROXY_TARGET=http://127.0.0.1:8080
```

Priority order is:

1. Shell environment variables
2. `.env.local`
3. `.env`
4. Built-in defaults

## Available Commands

```powershell
pnpm run dev
pnpm run dev:api
pnpm run dev:web
pnpm run typecheck
pnpm run build
```

What they do:

- `pnpm run dev`: starts API and dashboard together
- `pnpm run dev:api`: starts only the API server
- `pnpm run dev:web`: starts only the Vite dashboard
- `pnpm run typecheck`: runs TypeScript project-reference typecheck across the workspace
- `pnpm run build`: typechecks first, then builds packages that expose a build script

## API Endpoints

Base API URL in local development:

```text
http://127.0.0.1:8080/api
```

Main endpoints:

- `GET /healthz`
- `POST /bot/connect`
- `POST /bot/disconnect`
- `POST /bot/chat`
- `GET /bot/status`
- `GET /bot/logs`

WebSocket endpoint:

```text
ws://127.0.0.1:8080/ws
```

## Using the Bot

The dashboard lets you:

- connect the bot to a Minecraft server
- monitor health, food, position, game mode, and version
- watch live logs and chat events
- send chat messages from the bot
- disconnect and reconnect from the UI

Important note:

- the bot currently uses Mineflayer with `auth: "offline"`, so it is intended for offline-mode or compatible servers

The bot also stores the last session in:

```text
artifacts/api-server/.data/bot-session.json
```

## Project Structure

```text
.
|-- artifacts/
|   |-- api-server/
|   |-- minecraft-bot/
|   `-- mockup-sandbox/
|-- lib/
|   |-- api-client-react/
|   |-- api-spec/
|   |-- api-zod/
|   `-- db/
|-- scripts/
|-- package.json
|-- pnpm-workspace.yaml
`-- tsconfig.json
```

## Troubleshooting

### `pnpm` is not recognized

Install it with Corepack:

```powershell
corepack enable
corepack prepare pnpm@10 --activate
```

### `PORT` already in use

Change the ports in `.env`:

```env
API_PORT=8081
WEB_PORT=23419
VITE_API_PROXY_TARGET=http://127.0.0.1:8081
```

### Dashboard loads but API does not work

Make sure the API server is running and that `VITE_API_PROXY_TARGET` matches `API_PORT`.

### Dependencies were installed but the app still fails

Run:

```powershell
pnpm run typecheck
```

If that passes, restart the dev servers with `pnpm run dev`.
