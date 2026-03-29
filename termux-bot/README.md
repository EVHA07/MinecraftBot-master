# Termux Bot

Standalone Minecraft bot API for running on Termux without the main monorepo.

This folder is separate from the main workspace on purpose. It only keeps the
parts that are realistic to run on Android:

- Express API
- WebSocket status/log stream
- Mineflayer bot control
- Multi-bot support by `botId`

It does not include the Vite dashboard.

It now includes a lightweight built-in HTML control page served directly by Express.

## Requirements

- Termux
- Node.js
- npm

Install packages in Termux:

```sh
pkg update
pkg install nodejs
```

## Install

From inside `termux-bot/`:

```sh
npm install
```

## Run

```sh
npm start
```

Default server:

```text
http://127.0.0.1:8080
```

Open the control UI at:

```text
http://127.0.0.1:8080/
```

To expose it on your local network:

```sh
HOST=0.0.0.0 PORT=8080 npm start
```

## Optional Runtime Overrides

These environment variables are useful when the bot runtime is embedded into
another container or Android app:

- `BOT_RUNTIME_DIR`
- `BOT_DATA_DIR`
- `BOT_PUBLIC_DIR`
- `BOT_SESSION_FILE_NAME`
- `BOT_AUTO_RESTORE=false`
- `MAX_LOGS=400`

## API

- `GET /api/healthz`
- `POST /api/bot/connect`
- `POST /api/bot/disconnect`
- `POST /api/bot/chat`
- `GET /api/bot/status`
- `GET /api/bots/status`
- `GET /api/bots/saved`
- `GET /api/bot/logs`
- `GET /api/bots/logs`
- `POST /api/bots/disconnect-all`
- WebSocket: `/ws`

## Example Requests

Connect bot `bot-1`:

```sh
curl -X POST http://127.0.0.1:8080/api/bot/connect \
  -H 'Content-Type: application/json' \
  -d '{"botId":"bot-1","host":"server-a-ip","port":25565,"username":"BotSatu"}'
```

Connect bot `bot-2` to another server:

```sh
curl -X POST http://127.0.0.1:8080/api/bot/connect \
  -H 'Content-Type: application/json' \
  -d '{"botId":"bot-2","host":"server-b-ip","port":25565,"username":"BotDua"}'
```

Send chat from `bot-1`:

```sh
curl -X POST http://127.0.0.1:8080/api/bot/chat \
  -H 'Content-Type: application/json' \
  -d '{"botId":"bot-1","message":"halo"}'
```

Read status for one bot:

```sh
curl "http://127.0.0.1:8080/api/bot/status?botId=bot-1"
```

Read all bot statuses:

```sh
curl http://127.0.0.1:8080/api/bots/status
```

Read saved bot profiles:

```sh
curl http://127.0.0.1:8080/api/bots/saved
```

Disconnect all connected bots:

```sh
curl -X POST http://127.0.0.1:8080/api/bots/disconnect-all
```

## Notes

- The bot uses `auth: "offline"` right now.
- Saved bot profiles are stored in `.data/bot-sessions.json` inside this folder.
- Saved bot profiles stay available even after disconnect, so you can reconnect them from the UI.
- Termux is fine for personal use and testing, but not ideal for 24/7 hosting.
