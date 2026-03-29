import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = process.env.BOT_RUNTIME_DIR
  ? path.resolve(process.env.BOT_RUNTIME_DIR)
  : __dirname;
const dataDir = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(runtimeRoot, ".data");
const publicDir = process.env.BOT_PUBLIC_DIR
  ? path.resolve(process.env.BOT_PUBLIC_DIR)
  : path.join(runtimeRoot, "public");
const sessionFile = path.join(
  dataDir,
  process.env.BOT_SESSION_FILE_NAME ?? "bot-sessions.json",
);
const port = Number(process.env.PORT ?? "8080");
const host = process.env.HOST ?? "0.0.0.0";
const maxLogs = Math.max(50, Number(process.env.MAX_LOGS ?? "400") || 400);
const disconnectForceEndMs = Math.max(
  250,
  Number(process.env.BOT_DISCONNECT_FORCE_END_MS ?? "1200") || 1200,
);
const shouldRestoreSessions =
  String(process.env.BOT_AUTO_RESTORE ?? "true").toLowerCase() !== "false";

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

const server = createServer(handleHttpRequest);
const wss = new WebSocketServer({ server, path: "/ws" });

let logIdCounter = 1;
const logs = [];
const listeners = new Set();
const bots = new Map();
const sessions = new Map();
let mineflayerModulePromise = null;

async function getMineflayer() {
  if (mineflayerModulePromise) {
    return mineflayerModulePromise;
  }

  mineflayerModulePromise = import("mineflayer")
    .then((module) => module.default ?? module)
    .catch((err) => {
      mineflayerModulePromise = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load mineflayer: ${message}`);
    });

  return mineflayerModulePromise;
}

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true });
}

function normalizeBotId(value) {
  if (typeof value !== "string") return "default";
  const trimmed = value.trim();
  return trimmed === "" ? "default" : trimmed;
}

function saveSessions() {
  try {
    ensureDataDir();
    const payload = Array.from(sessions.values());
    writeFileSync(sessionFile, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    logger.warn({ err }, "Failed to save sessions");
  }
}

function loadSessions() {
  try {
    if (!existsSync(sessionFile)) return [];
    const parsed = JSON.parse(readFileSync(sessionFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn({ err }, "Failed to load sessions");
    return [];
  }
}

function upsertSession(session) {
  sessions.set(session.botId, session);
  saveSessions();
}

function removeSession(botId) {
  const normalizedBotId = normalizeBotId(botId);
  const deleted = sessions.delete(normalizedBotId);
  if (deleted) {
    saveSessions();
  }
  return deleted;
}

function getSavedBots() {
  return Array.from(sessions.values())
    .sort((left, right) => left.botId.localeCompare(right.botId))
    .map((session) => ({
      ...session,
      connected: Boolean(bots.get(session.botId) && !bots.get(session.botId).disconnecting),
      status: getStatus(session.botId),
    }));
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function broadcast(type, botId, data) {
  for (const listener of listeners) {
    try {
      listener({ type, botId, data });
    } catch (err) {
      logger.warn({ err }, "Broadcast listener failed");
    }
  }
}

function addLog(botId, type, message) {
  const entry = {
    id: logIdCounter++,
    timestamp: new Date().toISOString(),
    botId,
    type,
    message,
  };

  logs.push(entry);
  if (logs.length > maxLogs) logs.shift();
  broadcast("log", botId, entry);
  return entry;
}

function createEmptyStatus(botId) {
  return {
    botId,
    connected: false,
    username: null,
    host: null,
    port: null,
    health: null,
    food: null,
    position: null,
    gameMode: null,
    version: null,
  };
}

function getStatus(botId) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry || entry.disconnecting) {
    return createEmptyStatus(normalizedBotId);
  }

  const position = entry.bot.entity?.position;
  return {
    botId: normalizedBotId,
    connected: true,
    username: entry.bot.username ?? null,
    host: entry.host,
    port: entry.port,
    health: entry.bot.health ?? null,
    food: entry.bot.food ?? null,
    position: position
      ? {
          x: Math.round(position.x * 100) / 100,
          y: Math.round(position.y * 100) / 100,
          z: Math.round(position.z * 100) / 100,
        }
      : null,
    gameMode:
      entry.bot.game?.gameMode !== undefined
        ? String(entry.bot.game.gameMode)
        : null,
    version: entry.bot.version ?? null,
  };
}

function clearDisconnectTimer(entry) {
  if (!entry?.disconnectTimer) return;
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
}

function finalizeDisconnect(botId, reason, options = {}) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (options.expectedEntry && entry !== options.expectedEntry) {
    return false;
  }
  if (!entry) return false;

  clearDisconnectTimer(entry);
  bots.delete(normalizedBotId);

  if (options.logMessage) {
    addLog(normalizedBotId, options.logType ?? "system", options.logMessage);
  }

  broadcast("disconnected", normalizedBotId, {
    reason: options.broadcastReason ?? reason ?? "unknown",
  });
  broadcast("status", normalizedBotId, getStatus(normalizedBotId));
  return true;
}

function isExpectedDisconnectError(entry, err) {
  if (!entry?.disconnecting || !(err instanceof Error)) {
    return false;
  }

  const message = err.message.toLowerCase();
  return (
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("connection reset")
  );
}

function getAllStatuses() {
  return Array.from(bots.keys())
    .sort()
    .map((botId) => getStatus(botId));
}

function getLogs(limit = 100, botId = null) {
  const normalizedLimit = Math.min(Number(limit) || 100, maxLogs);
  const filtered = botId
    ? logs.filter((entry) => entry.botId === normalizeBotId(botId))
    : logs;
  return filtered.slice(-normalizedLimit);
}

function normalizeServerReason(reason) {
  if (reason == null) {
    return "Server closed the connection.";
  }

  const raw = typeof reason === "string" ? reason : JSON.stringify(reason);
  const lowered = raw.toLowerCase();

  if (
    lowered.includes("multiplayer.disconnect.unverified_username") ||
    lowered.includes("unverified_username")
  ) {
    return "This server only accepts verified usernames. Disable premium/cracked verification on the server or proxy.";
  }

  if (
    lowered.includes("multiplayer.disconnect.incompatible") ||
    lowered.includes("outdated client") ||
    lowered.includes("outdated server")
  ) {
    return "The bot version is not compatible with the server version.";
  }

  if (lowered.includes("disconnect.loginfailedinfo")) {
    return "The server rejected the bot login flow.";
  }

  if (lowered.includes("disconnect.timeout")) {
    return "The connection to the server timed out.";
  }

  if (lowered.includes("socketclosed") || lowered.includes("socket close")) {
    return "The server closed the connection.";
  }

  return raw;
}

function resolveDisconnectReason(entry, reason) {
  const normalizedReason = normalizeServerReason(reason ?? "unknown");
  if (
    entry?.lastDisconnectReason &&
    (normalizedReason === "The server closed the connection." || normalizedReason === "unknown")
  ) {
    return entry.lastDisconnectReason;
  }
  return normalizedReason;
}

function validateConnectBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const nextHost = typeof body.host === "string" ? body.host.trim() : "";
  const nextPort = Number(body.port);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const version = body.version;

  if (nextHost === "") {
    return { error: "Field 'host' is required" };
  }

  if (Number.isNaN(nextPort) || nextPort < 1 || nextPort > 65535) {
    return { error: "Field 'port' must be a number between 1 and 65535" };
  }

  if (username === "") {
    return { error: "Field 'username' is required" };
  }

  if (username.length > 16) {
    return { error: "Field 'username' must be 16 characters or fewer" };
  }

  if (version != null && typeof version !== "string") {
    return { error: "Field 'version' must be a string when provided" };
  }

  return {
    value: {
      botId,
      host: nextHost,
      port: nextPort,
      username,
      version: typeof version === "string" ? version.trim() || null : null,
    },
  };
}

function validateChatBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (message === "") {
    return { error: "Field 'message' is required" };
  }

  return {
    value: {
      botId,
      message,
    },
  };
}

async function connectBot(options) {
  const existingEntry = bots.get(options.botId);
  if (existingEntry) {
    if (existingEntry.disconnecting) {
      finalizeDisconnect(options.botId, "Reconnecting", {
        expectedEntry: existingEntry,
        logMessage: "Reconnect requested.",
        broadcastReason: "Reconnecting",
      });
    } else {
      throw new Error(`Bot '${options.botId}' is already connected`);
    }
  }

  const mineflayer = await getMineflayer();
  const botInstance = mineflayer.createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    auth: "offline",
    ...(options.version ? { version: options.version } : {}),
  });

  const entry = {
    botId: options.botId,
    bot: botInstance,
    host: options.host,
    port: options.port,
    disconnecting: false,
    disconnectTimer: null,
    lastDisconnectReason: null,
  };

  bots.set(options.botId, entry);
  upsertSession(options);

  addLog(
    options.botId,
    "system",
    `Connecting to ${options.host}:${options.port} as ${options.username}...`,
  );
  broadcast("status", options.botId, getStatus(options.botId));

  botInstance.once("login", () => {
    addLog(options.botId, "system", `Logged in as ${botInstance.username}`);
    broadcast("connected", options.botId, getStatus(options.botId));
    broadcast("status", options.botId, getStatus(options.botId));
  });

  botInstance.on("spawn", () => {
    addLog(options.botId, "system", "Bot spawned in world");
    broadcast("status", options.botId, getStatus(options.botId));
  });

  botInstance.on("chat", (username, message) => {
    if (username === botInstance.username) return;
    addLog(options.botId, "chat", `<${username}> ${message}`);
  });

  botInstance.on("whisper", (username, message) => {
    addLog(options.botId, "chat", `[whisper] <${username}> ${message}`);
  });

  botInstance.on("playerJoined", (player) => {
    addLog(options.botId, "join", `${player.username} joined the game`);
  });

  botInstance.on("playerLeft", (player) => {
    addLog(options.botId, "leave", `${player.username} left the game`);
  });

  botInstance.on("death", () => {
    addLog(options.botId, "death", `${botInstance.username} died`);
    broadcast("status", options.botId, getStatus(options.botId));
  });

  botInstance.on("health", () => {
    broadcast("status", options.botId, getStatus(options.botId));
  });

  botInstance.on("move", () => {
    broadcast("status", options.botId, getStatus(options.botId));
  });

  botInstance.on("kicked", (reason) => {
    let message = "Kicked from server";

    try {
      const parsed = JSON.parse(reason);
      message = parsed.text ?? parsed.translate ?? reason;
    } catch {
      message = String(reason);
    }

    message = normalizeServerReason(message);
    entry.lastDisconnectReason = message;

    finalizeDisconnect(options.botId, message, {
      expectedEntry: entry,
      logType: "error",
      logMessage: `Kicked: ${message}`,
      broadcastReason: message,
    });
  });

  botInstance.on("error", (err) => {
    const currentEntry = bots.get(options.botId);
    if (isExpectedDisconnectError(currentEntry, err)) {
      logger.info(
        { err, botId: options.botId },
        "Ignoring expected disconnect socket reset",
      );
      return;
    }

    addLog(options.botId, "error", `Error: ${err.message}`);
    logger.error({ err, botId: options.botId }, "Mineflayer bot error");
  });

  botInstance.on("end", (reason) => {
    const currentEntry = bots.get(options.botId);
    const normalizedReason = resolveDisconnectReason(currentEntry, reason);
    finalizeDisconnect(options.botId, normalizedReason, {
      expectedEntry: entry,
      logMessage: `Disconnected: ${normalizedReason}`,
      broadcastReason: normalizedReason,
    });
  });
}

function disconnectBot(botId) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  if (entry.disconnecting) {
    return;
  }

  entry.disconnecting = true;
  addLog(normalizedBotId, "system", "Disconnecting...");
  broadcast("status", normalizedBotId, getStatus(normalizedBotId));

  const gracefulDisconnect =
    typeof entry.bot.quit === "function"
      ? entry.bot.quit.bind(entry.bot)
      : typeof entry.bot.end === "function"
        ? entry.bot.end.bind(entry.bot)
        : null;

  try {
    if (!gracefulDisconnect) {
      throw new Error("Bot does not expose quit/end disconnect methods");
    }
    gracefulDisconnect("Disconnecting");
  } catch (error) {
    logger.warn({ err: error, botId: normalizedBotId }, "Graceful quit failed");
    finalizeDisconnect(normalizedBotId, "Disconnecting", {
      expectedEntry: entry,
      logMessage: "Disconnected.",
      broadcastReason: "Disconnecting",
    });
    return;
  }

  entry.disconnectTimer = setTimeout(() => {
    const currentEntry = bots.get(normalizedBotId);
    if (currentEntry !== entry || !currentEntry.disconnecting) {
      return;
    }

    logger.warn({ botId: normalizedBotId }, "Disconnect timed out, forcing close");

    try {
      currentEntry.bot.end?.("Disconnecting");
    } catch (error) {
      logger.warn({ err: error, botId: normalizedBotId }, "Force disconnect failed");
    }

    setTimeout(() => {
      const latestEntry = bots.get(normalizedBotId);
      if (latestEntry !== entry || !latestEntry.disconnecting) {
        return;
      }

      finalizeDisconnect(normalizedBotId, "Disconnecting", {
        expectedEntry: entry,
        logMessage: "Disconnected.",
        broadcastReason: "Disconnecting",
      });
    }, 250).unref();
  }, disconnectForceEndMs);
  entry.disconnectTimer.unref?.();
}

function disconnectAllBots() {
  const botIds = Array.from(bots.keys());
  for (const botId of botIds) {
    disconnectBot(botId);
  }
  return botIds;
}

function sendChat(botId, message) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  entry.bot.chat(message);
  addLog(normalizedBotId, "chat", `<${entry.bot.username}> ${message}`);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    ...corsHeaders(),
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function safeStaticPath(urlPathname) {
  const normalized = decodeURIComponent(urlPathname.split("?")[0]);
  const target = normalized === "/" ? "/index.html" : normalized;
  const resolved = path.resolve(publicDir, `.${target}`);
  const publicRoot = path.resolve(publicDir);
  return resolved.startsWith(publicRoot) ? resolved : null;
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function serveStatic(req, res, pathname) {
  const filePath = safeStaticPath(pathname);
  if (!filePath || !existsSync(filePath)) {
    notFound(res);
    return true;
  }

  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      ...corsHeaders(),
    });
    res.end(body);
  } catch (error) {
    logger.error({ err: error, filePath }, "Failed to serve static file");
    sendJson(res, 500, { error: "Failed to serve file" });
  }

  return true;
}

async function handleApiRequest(req, res, pathname, query) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/connect") {
    const parsed = validateConnectBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      await connectBot(parsed.value);
      sendJson(res, 200, getStatus(parsed.value.botId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, message.includes("already connected") ? 409 : 400, {
        error: message,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/disconnect") {
    const body = await parseJsonBody(req);
    const botId = normalizeBotId(body?.botId ?? query.get("botId"));

    try {
      disconnectBot(botId);
      sendJson(res, 200, { ok: true, botId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/remove-saved") {
    const body = await parseJsonBody(req);
    const botId = normalizeBotId(body?.botId ?? query.get("botId"));

    if (bots.has(botId) && !bots.get(botId)?.disconnecting) {
      sendJson(res, 409, {
        error: `Bot '${botId}' is still connected. Disconnect it first.`,
      });
      return;
    }

    if (!removeSession(botId)) {
      sendJson(res, 404, {
        error: `Saved session '${botId}' was not found.`,
      });
      return;
    }

    addLog(botId, "system", "Saved session deleted.");
    sendJson(res, 200, { ok: true, botId });
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/chat") {
    const parsed = validateChatBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      sendChat(parsed.value.botId, parsed.value.message);
      sendJson(res, 200, { ok: true, botId: parsed.value.botId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/bot/status") {
    sendJson(res, 200, getStatus(query.get("botId")));
    return;
  }

  if (req.method === "GET" && pathname === "/api/bots/status") {
    sendJson(res, 200, getAllStatuses());
    return;
  }

  if (req.method === "GET" && pathname === "/api/bots/saved") {
    sendJson(res, 200, getSavedBots());
    return;
  }

  if (req.method === "GET" && pathname === "/api/bot/logs") {
    sendJson(res, 200, getLogs(query.get("limit") ?? 100, query.get("botId") ?? null));
    return;
  }

  if (req.method === "GET" && pathname === "/api/bots/logs") {
    sendJson(res, 200, getLogs(query.get("limit") ?? 100));
    return;
  }

  if (req.method === "POST" && pathname === "/api/bots/disconnect-all") {
    try {
      const botIds = disconnectAllBots();
      sendJson(res, 200, { ok: true, botIds });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
    }
    return;
  }

  notFound(res);
}

async function handleHttpRequest(req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith("/api/")) {
      await handleApiRequest(req, res, pathname, url.searchParams);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, method: req.method, pathname }, "Unhandled request error");
    sendJson(res, 500, { error: message });
  } finally {
    logger.info({
      method: req.method,
      pathname,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    }, "HTTP request");
  }
}

wss.on("connection", (ws) => {
  logger.info("WebSocket client connected");

  try {
    ws.send(
      JSON.stringify({
        type: "statusSnapshot",
        data: getAllStatuses(),
      }),
    );
  } catch {
    // Ignore initial send errors.
  }

  const unsubscribe = subscribe((event) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(event));
    } catch (err) {
      logger.warn({ err }, "Failed to send WebSocket message");
    }
  });

  ws.on("close", () => {
    unsubscribe();
    logger.info("WebSocket client disconnected");
  });

  ws.on("error", (err) => {
    unsubscribe();
    logger.warn({ err }, "WebSocket client error");
  });
});

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Shutting down multi-bot server");

  try {
    disconnectAllBots();
  } catch (err) {
    logger.warn({ err }, "Failed to disconnect bots during shutdown");
  }

  setTimeout(() => {
    server.close(() => {
      process.exit(0);
    });
  }, 250);

  setTimeout(() => {
    process.exit(0);
  }, 2_500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function restoreSavedSessions() {
  const savedSessions = loadSessions();
  for (const session of savedSessions) {
    const parsed = validateConnectBody(session);
    if (parsed.error) {
      logger.warn({ session, error: parsed.error }, "Skipping invalid session");
      continue;
    }

    upsertSession(parsed.value);

    if (!shouldRestoreSessions) continue;

    logger.info(
      {
        botId: parsed.value.botId,
        host: parsed.value.host,
        port: parsed.value.port,
        username: parsed.value.username,
      },
      "Restoring previous bot session",
    );

    try {
      await connectBot(parsed.value);
    } catch (err) {
      logger.warn(
        { err, botId: parsed.value.botId },
        "Failed to restore previous bot session",
      );
      addLog(
        parsed.value.botId,
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

server.listen(port, host, () => {
  logger.info({ host, port }, "Termux multi-bot server listening");
  void restoreSavedSessions();
});
