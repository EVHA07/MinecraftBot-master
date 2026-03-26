import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketServer } from "./lib/wsServer";
import { loadSession, connectBot } from "./lib/bot";

const rawPort = process.env["API_PORT"] ?? process.env["PORT"] ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
attachWebSocketServer(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");

  const session = loadSession();
  if (session) {
    logger.info({ host: session.host, port: session.port, username: session.username }, "Restoring bot session…");
    try {
      connectBot(session);
    } catch (err) {
      logger.warn({ err }, "Failed to restore bot session");
    }
  }
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
