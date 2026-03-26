import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { Server } from "http";
import { subscribe, getStatus } from "./bot";
import { logger } from "./logger";

export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    logger.info("WebSocket client connected");

    // Send current status immediately on connect
    try {
      ws.send(JSON.stringify({ type: "status", data: getStatus() }));
    } catch {
      // ignore
    }

    // Subscribe to bot events
    const unsubscribe = subscribe((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(event));
        } catch (err) {
          logger.warn({ err }, "Failed to send WebSocket message");
        }
      }
    });

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
      unsubscribe();
    });

    ws.on("error", (err) => {
      logger.warn({ err }, "WebSocket error");
      unsubscribe();
    });
  });

  return wss;
}
