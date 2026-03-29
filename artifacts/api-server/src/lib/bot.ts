import mineflayer, { type Bot } from "mineflayer";
import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { logger } from "./logger";

export interface LogEntry {
  id: number;
  timestamp: string;
  type: string;
  message: string;
}

export interface BotState {
  connected: boolean;
  username: string | null;
  host: string | null;
  port: number | null;
  health: number | null;
  food: number | null;
  position: { x: number; y: number; z: number } | null;
  gameMode: string | null;
  version: string | null;
}

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  version?: string | null;
}

type BotEventListener = (event: { type: string; data: unknown }) => void;

let bot: Bot | null = null;
let currentHost: string | null = null;
let currentPort: number | null = null;

let logIdCounter = 1;
const MAX_LOGS = 200;
const logs: LogEntry[] = [];
const listeners: Set<BotEventListener> = new Set();

// Persist session in the workspace so it survives container restarts.
// process.cwd() is artifacts/api-server when the server runs.
const SESSION_FILE = join(process.cwd(), ".data", "bot-session.json");

function saveSession(options: ConnectOptions): void {
  try {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(options), "utf8");
  } catch (err) {
    logger.warn({ err }, "Failed to save bot session");
  }
}

function clearSession(): void {
  try {
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
  } catch (err) {
    logger.warn({ err }, "Failed to clear bot session");
  }
}

function clearActiveConnection(): void {
  bot = null;
  currentHost = null;
  currentPort = null;
  clearSession();
}

export function loadSession(): ConnectOptions | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const raw = readFileSync(SESSION_FILE, "utf8");
    return JSON.parse(raw) as ConnectOptions;
  } catch {
    return null;
  }
}

function addLog(type: string, message: string): LogEntry {
  const entry: LogEntry = {
    id: logIdCounter++,
    timestamp: new Date().toISOString(),
    type,
    message,
  };

  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  broadcast("log", entry);
  return entry;
}

function broadcast(type: string, data: unknown): void {
  for (const listener of listeners) {
    try {
      listener({ type, data });
    } catch (err) {
      logger.warn({ err }, "WebSocket listener error");
    }
  }
}

export function subscribe(listener: BotEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStatus(): BotState {
  if (!bot) {
    return {
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

  const pos = bot.entity?.position;
  return {
    connected: true,
    username: bot.username ?? null,
    host: currentHost,
    port: currentPort,
    health: bot.health ?? null,
    food: bot.food ?? null,
    position: pos
      ? {
          x: Math.round(pos.x * 100) / 100,
          y: Math.round(pos.y * 100) / 100,
          z: Math.round(pos.z * 100) / 100,
        }
      : null,
    gameMode:
      bot.game?.gameMode !== undefined ? String(bot.game.gameMode) : null,
    version: bot.version ?? null,
  };
}

export function getLogs(limit = 100): LogEntry[] {
  return logs.slice(-Math.min(limit, MAX_LOGS));
}

export function connectBot(options: ConnectOptions): void {
  if (bot) {
    throw new Error("Bot is already connected");
  }

  currentHost = options.host;
  currentPort = options.port;

  saveSession(options);
  addLog(
    "system",
    `Connecting to ${options.host}:${options.port} as ${options.username}...`,
  );

  const botOptions: mineflayer.BotOptions = {
    host: options.host,
    port: options.port,
    username: options.username,
    auth: "offline",
  };

  if (options.version) {
    botOptions.version = options.version;
  }

  bot = mineflayer.createBot(botOptions);
  const activeBot = bot;

  activeBot.once("login", () => {
    addLog("system", `Logged in as ${activeBot.username}`);
    broadcast("connected", getStatus());
    broadcast("status", getStatus());
  });

  activeBot.on("spawn", () => {
    addLog("system", "Bot spawned in world");
    broadcast("status", getStatus());
  });

  activeBot.on("chat", (username, message) => {
    if (username === activeBot.username) return;
    addLog("chat", `<${username}> ${message}`);
  });

  activeBot.on("whisper", (username, message) => {
    addLog("chat", `[whisper] <${username}> ${message}`);
  });

  activeBot.on("playerJoined", (player) => {
    addLog("join", `${player.username} joined the game`);
  });

  activeBot.on("playerLeft", (player) => {
    addLog("leave", `${player.username} left the game`);
  });

  activeBot.on("death", () => {
    addLog("death", `${activeBot.username} died`);
    broadcast("status", getStatus());
  });

  activeBot.on("health", () => {
    broadcast("status", getStatus());
  });

  activeBot.on("move", () => {
    broadcast("status", getStatus());
  });

  activeBot.on("kicked", (reason: string) => {
    if (bot !== activeBot) return;

    let msg = "Kicked from server";
    try {
      const parsed = JSON.parse(reason) as {
        text?: string;
        translate?: string;
      };
      msg = parsed.text ?? parsed.translate ?? reason;
    } catch {
      msg = reason;
    }

    addLog("error", `Kicked: ${msg}`);
    clearActiveConnection();
    broadcast("disconnected", { reason: msg });
    broadcast("status", getStatus());
  });

  activeBot.on("error", (err: Error) => {
    addLog("error", `Error: ${err.message}`);
    logger.error({ err }, "Mineflayer bot error");
  });

  activeBot.on("end", (reason: string) => {
    if (bot !== activeBot) return;

    addLog("system", `Disconnected: ${reason ?? "unknown"}`);
    clearActiveConnection();
    broadcast("disconnected", { reason });
    broadcast("status", getStatus());
  });
}

export function disconnectBot(): void {
  if (!bot) {
    return;
  }

  const activeBot = bot;
  addLog("system", "Disconnecting...");
  clearActiveConnection();
  broadcast("disconnected", {});
  broadcast("status", getStatus());
  activeBot.quit("Disconnecting");
}

export function sendChat(message: string): void {
  if (!bot) {
    throw new Error("Bot is not connected");
  }

  bot.chat(message);
  addLog("chat", `<${bot.username}> ${message}`);
}
