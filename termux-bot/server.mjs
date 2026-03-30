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
const movementActionMs = Math.max(
  150,
  Number(process.env.BOT_MOVE_ACTION_MS ?? "650") || 650,
);
const aiThinkIntervalMs = Math.max(
  120,
  Number(process.env.BOT_AI_THINK_INTERVAL_MS ?? "250") || 250,
);
const autoAttackCooldownMs = Math.max(
  200,
  Number(process.env.BOT_AUTO_ATTACK_COOLDOWN_MS ?? "900") || 900,
);
const autoAttackRange = Math.max(
  1.5,
  Number(process.env.BOT_AUTO_ATTACK_RANGE ?? "4.25") || 4.25,
);
const routineWanderIntervalMs = Math.max(
  500,
  Number(process.env.BOT_ROUTINE_WANDER_INTERVAL_MS ?? "1400") || 1400,
);
const routineSleepRetryMs = Math.max(
  1500,
  Number(process.env.BOT_ROUTINE_SLEEP_RETRY_MS ?? "4500") || 4500,
);
const routineBedSearchRange = Math.max(
  3,
  Number(process.env.BOT_ROUTINE_BED_SEARCH_RANGE ?? "12") || 12,
);
const routineDoorSearchRange = Math.max(
  2,
  Number(process.env.BOT_ROUTINE_DOOR_SEARCH_RANGE ?? "7") || 7,
);
const shouldRestoreSessions =
  String(process.env.BOT_AUTO_RESTORE ?? "true").toLowerCase() !== "false";
const movementControls = ["forward", "back", "left", "right", "jump", "sprint"];
const supportedMoveActions = new Set(["forward", "back", "left", "right", "stop"]);
const hostileMobNames = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "spider",
  "cave_spider",
  "creeper",
  "witch",
  "slime",
  "magma_cube",
  "blaze",
  "ghast",
  "phantom",
  "guardian",
  "elder_guardian",
  "silverfish",
  "endermite",
  "vex",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "piglin_brute",
  "hoglin",
  "zoglin",
  "warden",
  "wither_skeleton",
]);
const zombieMobNames = new Set(["zombie", "husk", "drowned", "zombie_villager"]);

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
    autoAttackEnabled: false,
    aiMode: null,
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
    autoAttackEnabled: Boolean(entry.autoAttackEnabled),
    aiMode: entry.aiMode ?? null,
  };
}

function clearDisconnectTimer(entry) {
  if (!entry?.disconnectTimer) return;
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
}

function clearMoveTimer(entry) {
  if (!entry?.moveTimer) return;
  clearTimeout(entry.moveTimer);
  entry.moveTimer = null;
}

function stopMovement(entry) {
  if (!entry?.bot?.setControlState) return;
  clearMoveTimer(entry);
  for (const control of movementControls) {
    entry.bot.setControlState(control, false);
  }
}

function getEntityName(entity) {
  return String(
    entity?.username ?? entity?.name ?? entity?.displayName ?? "",
  ).toLowerCase();
}

function hotbarIndexFromSlot(slot) {
  if (!Number.isInteger(slot)) {
    return null;
  }

  return slot >= 36 && slot <= 44 ? slot - 36 : null;
}

function isSelectedInventoryItem(item, selectedSlot) {
  if (!item || !Number.isInteger(selectedSlot)) {
    return false;
  }

  const hotbarIndex = hotbarIndexFromSlot(item.slot);
  if (Number.isInteger(hotbarIndex)) {
    return hotbarIndex === selectedSlot;
  }

  return item.slot === selectedSlot;
}

function mapInventoryItem(item, selectedSlot = null) {
  return {
    slot: item?.slot ?? null,
    name: item?.name ?? null,
    displayName: item?.displayName ?? item?.name ?? null,
    count: item?.count ?? null,
    stackSize: item?.stackSize ?? null,
    hotbarIndex: hotbarIndexFromSlot(item?.slot),
    selected: isSelectedInventoryItem(item, selectedSlot),
  };
}

function getInventory(botId) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry || entry.disconnecting) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  const selectedSlot =
    Number.isInteger(entry.bot.quickBarSlot)
      ? entry.bot.quickBarSlot
      : Number.isInteger(entry.bot.inventory?.selectedSlot)
        ? entry.bot.inventory.selectedSlot
        : null;
  const items = entry.bot.inventory?.items?.() ?? [];
  return {
    botId: normalizedBotId,
    selectedSlot,
    heldItem: entry.bot.heldItem ? mapInventoryItem(entry.bot.heldItem, selectedSlot) : null,
    items: items
      .map((item) => mapInventoryItem(item, selectedSlot))
      .sort((left, right) => (left.slot ?? Number.MAX_SAFE_INTEGER) - (right.slot ?? Number.MAX_SAFE_INTEGER)),
  };
}

function getInventoryEntry(botId) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry || entry.disconnecting) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  return {
    botId: normalizedBotId,
    entry,
  };
}

function getInventorySlotItem(entry, slot) {
  if (!Number.isInteger(slot)) {
    return null;
  }

  return entry.bot.inventory?.slots?.[slot] ?? null;
}

function resolveEquipDestination(item, requestedDestination = null) {
  const normalizedDestination =
    typeof requestedDestination === "string"
      ? requestedDestination.trim().toLowerCase()
      : null;
  const supportedDestinations = new Set([
    "hand",
    "off-hand",
    "head",
    "torso",
    "legs",
    "feet",
  ]);

  if (normalizedDestination) {
    if (!supportedDestinations.has(normalizedDestination)) {
      throw new Error(
        "Field 'destination' must be one of: hand, off-hand, head, torso, legs, feet",
      );
    }
    return normalizedDestination;
  }

  const normalizedName = String(item?.name ?? "").toLowerCase();
  if (
    normalizedName.endsWith("_helmet") ||
    normalizedName.endsWith("_skull") ||
    normalizedName.endsWith("_head") ||
    normalizedName === "turtle_helmet" ||
    normalizedName === "carved_pumpkin"
  ) {
    return "head";
  }
  if (normalizedName.endsWith("_chestplate") || normalizedName === "elytra") {
    return "torso";
  }
  if (normalizedName.endsWith("_leggings")) {
    return "legs";
  }
  if (normalizedName.endsWith("_boots")) {
    return "feet";
  }

  return "hand";
}

function findNearestMatchingEntity(bot, predicate) {
  return bot.nearestEntity((entity) => {
    try {
      return predicate(entity);
    } catch {
      return false;
    }
  });
}

function findApproachPlayerTarget(entry) {
  const requestedTarget = entry.aiTargetUsername?.toLowerCase() ?? null;
  if (requestedTarget) {
    const player = Object.values(entry.bot.players ?? {}).find((candidate) => {
      const username = String(candidate?.username ?? "").toLowerCase();
      return username === requestedTarget;
    });
    if (player?.entity) {
      return player.entity;
    }
  }

  return findNearestMatchingEntity(entry.bot, (entity) => {
    if (entity?.type !== "player") {
      return false;
    }

    const entityName = getEntityName(entity);
    if (!entityName || entityName === String(entry.bot.username ?? "").toLowerCase()) {
      return false;
    }

    return true;
  });
}

function findZombieTarget(entry) {
  return findNearestMatchingEntity(entry.bot, (entity) => {
    return entity?.type === "mob" && zombieMobNames.has(getEntityName(entity));
  });
}

function applyChaseMovement(entry, target, stopDistance) {
  const selfPosition = entry.bot.entity?.position;
  const targetPosition = target?.position;
  if (!selfPosition || !targetPosition) {
    stopMovement(entry);
    return null;
  }

  const distance = targetPosition.distanceTo(selfPosition);
  const aimY = Math.max(0.8, Number(target?.height) || 1.2);
  void Promise.resolve(
    entry.bot.lookAt(targetPosition.offset(0, aimY, 0), true),
  ).catch(() => {});

  entry.bot.setControlState("left", false);
  entry.bot.setControlState("right", false);
  entry.bot.setControlState("back", false);

  const shouldAdvance = distance > stopDistance;
  entry.bot.setControlState("forward", shouldAdvance);
  entry.bot.setControlState("sprint", distance > stopDistance + 1.5);
  entry.bot.setControlState("jump", shouldAdvance && targetPosition.y - selfPosition.y > 0.75);
  return distance;
}

function isNightTime(bot) {
  const timeOfDay = Number(bot?.time?.timeOfDay);
  if (Number.isNaN(timeOfDay)) {
    return false;
  }

  return timeOfDay >= 12541 && timeOfDay <= 23458;
}

function createBlockTarget(block) {
  if (!block?.position?.offset) {
    return null;
  }

  return {
    position: block.position.offset(0.5, 0, 0.5),
    height: 1.1,
  };
}

function findNearbyBed(entry) {
  if (typeof entry.bot.findBlock !== "function" || typeof entry.bot.isABed !== "function") {
    return null;
  }

  return entry.bot.findBlock({
    matching: (block) => {
      try {
        return Boolean(block) && entry.bot.isABed(block);
      } catch {
        return false;
      }
    },
    maxDistance: routineBedSearchRange,
  });
}

function findNearbyOpenDoor(entry) {
  if (typeof entry.bot.findBlock !== "function") {
    return null;
  }

  return entry.bot.findBlock({
    matching: (block) => {
      if (!block?.name) {
        return false;
      }

      const lowerName = String(block.name).toLowerCase();
      if (!lowerName.includes("door") && !lowerName.includes("gate")) {
        return false;
      }

      try {
        const properties = block.getProperties?.() ?? {};
        return properties.open === true;
      } catch {
        return false;
      }
    },
    maxDistance: routineDoorSearchRange,
  });
}

function maybeWakeFromBed(entry) {
  if (!entry.bot.isSleeping || typeof entry.bot.wake !== "function") {
    return false;
  }

  if (!entry.bot.time?.isDay) {
    return true;
  }

  void Promise.resolve(entry.bot.wake()).catch((error) => {
    logger.debug({ err: error, botId: entry.botId }, "Routine wake failed");
  });
  return true;
}

function maybeSleepInNearestBed(entry, now) {
  if (entry.bot.isSleeping) {
    stopMovement(entry);
    return true;
  }

  if (!isNightTime(entry.bot)) {
    return false;
  }

  const bedBlock = findNearbyBed(entry);
  if (!bedBlock) {
    return false;
  }

  const selfPosition = entry.bot.entity?.position;
  const bedTarget = createBlockTarget(bedBlock);
  if (!selfPosition || !bedTarget?.position) {
    return false;
  }

  const distance = selfPosition.distanceTo(bedTarget.position);
  if (distance > 3.1) {
    applyChaseMovement(entry, bedTarget, 2.1);
    return true;
  }

  if (now - entry.lastSleepAttemptAt < routineSleepRetryMs) {
    stopMovement(entry);
    return true;
  }

  entry.lastSleepAttemptAt = now;
  stopMovement(entry);
  void Promise.resolve(entry.bot.sleep(bedBlock)).then(() => {
    addLog(entry.botId, "system", "Routine AI: sleeping in the nearest bed.");
    broadcast("status", entry.botId, getStatus(entry.botId));
  }).catch((error) => {
    logger.debug({ err: error, botId: entry.botId }, "Routine sleep attempt failed");
  });
  return true;
}

function applyRoutineWander(entry, now) {
  if (entry.routineMoveUntil > now) {
    return;
  }

  stopMovement(entry);
  entry.routineMoveUntil = now + routineWanderIntervalMs;

  const roll = Math.random();
  if (roll < 0.2) {
    return;
  }

  entry.bot.setControlState("forward", true);
  if (roll < 0.45) {
    entry.bot.setControlState("left", true);
  } else if (roll < 0.7) {
    entry.bot.setControlState("right", true);
  } else if (roll > 0.9) {
    entry.bot.setControlState("jump", true);
  }
}

function applyRoutineAi(entry, now) {
  if (maybeWakeFromBed(entry)) {
    return;
  }

  if (maybeSleepInNearestBed(entry, now)) {
    return;
  }

  const openDoor = findNearbyOpenDoor(entry);
  if (openDoor) {
    const target = createBlockTarget(openDoor);
    if (target) {
      applyChaseMovement(entry, target, 1.4);
      return;
    }
  }

  applyRoutineWander(entry, now);
}

function stopAi(entry) {
  if (!entry) return;
  entry.aiMode = null;
  entry.aiTargetUsername = null;
  entry.lastAiTickAt = 0;
  entry.routineMoveUntil = 0;
  entry.lastSleepAttemptAt = 0;
  stopMovement(entry);
}

function finalizeDisconnect(botId, reason, options = {}) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (options.expectedEntry && entry !== options.expectedEntry) {
    return false;
  }
  if (!entry) return false;

  clearDisconnectTimer(entry);
  stopMovement(entry);
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

  return {
    value: {
      botId,
      host: nextHost,
      port: nextPort,
      username,
      version: null,
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

function validateMoveBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const action =
    typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const rawDuration = body.durationMs;
  const durationMs =
    rawDuration == null ? movementActionMs : Number.parseInt(String(rawDuration), 10);

  if (!supportedMoveActions.has(action)) {
    return {
      error: "Field 'action' must be one of: forward, back, left, right, stop",
    };
  }

  if (
    action !== "stop" &&
    (Number.isNaN(durationMs) || durationMs < 150 || durationMs > 5000)
  ) {
    return { error: "Field 'durationMs' must be between 150 and 5000" };
  }

  return {
    value: {
      botId,
      action,
      durationMs: action === "stop" ? 0 : durationMs,
    },
  };
}

function validateAutoAttackBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  if (typeof body.enabled !== "boolean") {
    return { error: "Field 'enabled' must be a boolean" };
  }

  return {
    value: {
      botId,
      enabled: body.enabled,
    },
  };
}

function validateAiBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const action =
    typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const targetUsername =
    typeof body.targetUsername === "string" ? body.targetUsername.trim() : "";

  if (!["approach-player", "attack-zombies", "routine", "stop-ai"].includes(action)) {
    return {
      error: "Field 'action' must be one of: approach-player, attack-zombies, routine, stop-ai",
    };
  }

  if (targetUsername.length > 16) {
    return { error: "Field 'targetUsername' must be 16 characters or fewer" };
  }

  return {
    value: {
      botId,
      action,
      targetUsername: targetUsername || null,
    },
  };
}

function validateSelectHotbarBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const hotbarIndex = Number.parseInt(String(body.hotbarIndex), 10);

  if (Number.isNaN(hotbarIndex) || hotbarIndex < 0 || hotbarIndex > 8) {
    return { error: "Field 'hotbarIndex' must be a number between 0 and 8" };
  }

  return {
    value: {
      botId,
      hotbarIndex,
    },
  };
}

function validateEquipBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const slot = Number.parseInt(String(body.slot), 10);
  const destination =
    typeof body.destination === "string" && body.destination.trim() !== ""
      ? body.destination.trim().toLowerCase()
      : null;

  if (Number.isNaN(slot) || slot < 0) {
    return { error: "Field 'slot' must be a valid inventory slot number" };
  }

  return {
    value: {
      botId,
      slot,
      destination,
    },
  };
}

function validateDropBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const botId = normalizeBotId(body.botId);
  const slot = Number.parseInt(String(body.slot), 10);

  if (Number.isNaN(slot) || slot < 0) {
    return { error: "Field 'slot' must be a valid inventory slot number" };
  }

  return {
    value: {
      botId,
      slot,
    },
  };
}

function validateUpdateSavedBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const currentBotId = normalizeBotId(body.currentBotId);
  if (!currentBotId) {
    return { error: "Field 'currentBotId' is required" };
  }

  const parsedSession = validateConnectBody(body.session);
  if (parsedSession.error) {
    return parsedSession;
  }

  return {
    value: {
      currentBotId,
      session: parsedSession.value,
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
  });

  const entry = {
    botId: options.botId,
    bot: botInstance,
    host: options.host,
    port: options.port,
    disconnecting: false,
    disconnectTimer: null,
    moveTimer: null,
    lastDisconnectReason: null,
    autoAttackEnabled: false,
    lastAttackAt: 0,
    aiMode: "routine",
    aiTargetUsername: null,
    lastAiTickAt: 0,
    routineMoveUntil: 0,
    lastSleepAttemptAt: 0,
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
    addLog(
      options.botId,
      "system",
      "Routine AI enabled automatically for this session.",
    );
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

  botInstance.on("physicsTick", () => {
    if (entry.disconnecting) {
      return;
    }

    const selfPosition = entry.bot.entity?.position;
    if (!selfPosition) {
      return;
    }

    const now = Date.now();
    if (entry.aiMode && now >= entry.lastAiTickAt) {
      entry.lastAiTickAt = now + aiThinkIntervalMs;

      if (entry.aiMode === "approach-player") {
        const target = findApproachPlayerTarget(entry);
        if (target) {
          applyChaseMovement(entry, target, 2.35);
        } else {
          stopMovement(entry);
        }
      } else if (entry.aiMode === "attack-zombies") {
        const target = findZombieTarget(entry);
        if (target) {
          const distance = applyChaseMovement(entry, target, 2.9);
          if (
            distance != null &&
            distance <= 3.4 &&
            now - entry.lastAttackAt >= autoAttackCooldownMs
          ) {
            entry.lastAttackAt = now;
            void Promise.resolve(
              entry.bot.lookAt(
                target.position.offset(0, Math.max(0.8, Number(target.height) || 1.2), 0),
                true,
              ),
            ).catch(() => {});
            void Promise.resolve(entry.bot.attack(target)).catch((error) => {
              logger.debug(
                { err: error, botId: options.botId, target: target.name },
                "AI zombie attack failed",
              );
            });
          }
        } else {
          stopMovement(entry);
        }
      } else if (entry.aiMode === "routine") {
        applyRoutineAi(entry, now);
      }
    }

    if (!entry.autoAttackEnabled) {
      return;
    }

    if (now - entry.lastAttackAt < autoAttackCooldownMs) {
      return;
    }

    const target = entry.bot.nearestEntity((entity) => {
      if (!entity || entity.type !== "mob" || !entity.position) {
        return false;
      }

      const name = String(entity.name ?? entity.displayName ?? "").toLowerCase();
      if (!hostileMobNames.has(name)) {
        return false;
      }

      return entity.position.distanceTo(selfPosition) <= autoAttackRange;
    });

    if (!target) {
      return;
    }

    entry.lastAttackAt = now;
    void Promise.resolve(
      entry.bot.lookAt(
        target.position.offset(0, Math.max(0.8, Number(target.height) || 1.2), 0),
        true,
      ),
    ).catch(() => {});
    void Promise.resolve(entry.bot.attack(target)).catch((error) => {
      logger.debug(
        { err: error, botId: options.botId, target: target.name },
        "Auto attack failed",
      );
    });
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

function moveBot(botId, action, durationMs) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry || entry.disconnecting) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  if (entry.aiMode) {
    stopAi(entry);
  }

  stopMovement(entry);
  if (action === "stop") {
    addLog(normalizedBotId, "system", "Movement stopped.");
    broadcast("status", normalizedBotId, getStatus(normalizedBotId));
    return;
  }

  entry.bot.setControlState(action, true);
  addLog(normalizedBotId, "system", `Moving ${action}...`);
  broadcast("status", normalizedBotId, getStatus(normalizedBotId));

  entry.moveTimer = setTimeout(() => {
    const currentEntry = bots.get(normalizedBotId);
    if (currentEntry !== entry || currentEntry.disconnecting) {
      return;
    }

    stopMovement(currentEntry);
    addLog(normalizedBotId, "system", `Movement ${action} finished.`);
    broadcast("status", normalizedBotId, getStatus(normalizedBotId));
  }, durationMs);
  entry.moveTimer.unref?.();
}

function setAutoAttack(botId, enabled) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry || entry.disconnecting) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  entry.autoAttackEnabled = enabled;
  entry.lastAttackAt = 0;
  addLog(
    normalizedBotId,
    "system",
    enabled
      ? "Auto Attack enabled. The bot will attack nearby hostile mobs."
      : "Auto Attack disabled.",
  );
  broadcast("status", normalizedBotId, getStatus(normalizedBotId));
}

function setAiMode(botId, action, targetUsername = null) {
  const normalizedBotId = normalizeBotId(botId);
  const entry = bots.get(normalizedBotId);
  if (!entry || entry.disconnecting) {
    throw new Error(`Bot '${normalizedBotId}' is not connected`);
  }

  if (action === "stop-ai") {
    stopAi(entry);
    addLog(normalizedBotId, "system", "AI mode stopped.");
    broadcast("status", normalizedBotId, getStatus(normalizedBotId));
    return;
  }

  if (action === "approach-player") {
    entry.aiMode = "approach-player";
    entry.aiTargetUsername = targetUsername;
    entry.lastAiTickAt = 0;
    addLog(
      normalizedBotId,
      "system",
      targetUsername
        ? `AI mode: approach player '${targetUsername}'.`
        : "AI mode: approach the nearest player.",
    );
    broadcast("status", normalizedBotId, getStatus(normalizedBotId));
    return;
  }

  if (action === "attack-zombies") {
    entry.aiMode = "attack-zombies";
    entry.aiTargetUsername = null;
    entry.lastAiTickAt = 0;
    addLog(
      normalizedBotId,
      "system",
      "AI mode: attack nearby zombies automatically.",
    );
    broadcast("status", normalizedBotId, getStatus(normalizedBotId));
    return;
  }

  if (action === "routine") {
    entry.aiMode = "routine";
    entry.aiTargetUsername = null;
    entry.lastAiTickAt = 0;
    entry.routineMoveUntil = 0;
    entry.lastSleepAttemptAt = 0;
    addLog(
      normalizedBotId,
      "system",
      "AI mode: routine wandering, open-door interest, and night-bed sleep.",
    );
    broadcast("status", normalizedBotId, getStatus(normalizedBotId));
    return;
  }

  throw new Error(`Unsupported AI action '${action}'`);
}

async function selectHotbar(botId, hotbarIndex) {
  const { botId: normalizedBotId, entry } = getInventoryEntry(botId);
  if (typeof entry.bot.setQuickBarSlot === "function") {
    await Promise.resolve(entry.bot.setQuickBarSlot(hotbarIndex));
  } else if (Number.isInteger(entry.bot.quickBarSlot)) {
    entry.bot.quickBarSlot = hotbarIndex;
  } else {
    throw new Error("Quick bar selection is not supported by this bot runtime");
  }

  addLog(normalizedBotId, "system", `Selected hotbar slot ${hotbarIndex + 1}.`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return getInventory(normalizedBotId);
}

async function equipInventoryItem(botId, slot, destination = null) {
  const { botId: normalizedBotId, entry } = getInventoryEntry(botId);
  const item = getInventorySlotItem(entry, slot);
  if (!item) {
    throw new Error(`Inventory slot ${slot} is empty`);
  }

  if (typeof entry.bot.equip !== "function") {
    throw new Error("Equip is not supported by this bot runtime");
  }

  const resolvedDestination = resolveEquipDestination(item, destination);
  await entry.bot.equip(item, resolvedDestination);
  addLog(
    normalizedBotId,
    "system",
    `Equipped ${item.displayName ?? item.name ?? "item"} to ${resolvedDestination}.`,
  );
  return getInventory(normalizedBotId);
}

async function dropInventoryItem(botId, slot) {
  const { botId: normalizedBotId, entry } = getInventoryEntry(botId);
  const item = getInventorySlotItem(entry, slot);
  if (!item) {
    throw new Error(`Inventory slot ${slot} is empty`);
  }

  if (typeof entry.bot.tossStack === "function") {
    await entry.bot.tossStack(item);
  } else if (typeof entry.bot.toss === "function") {
    await entry.bot.toss(item.type, item.metadata ?? null, item.count ?? 1);
  } else {
    throw new Error("Drop is not supported by this bot runtime");
  }

  addLog(
    normalizedBotId,
    "system",
    `Dropped ${item.displayName ?? item.name ?? "item"} from slot ${slot}.`,
  );
  return getInventory(normalizedBotId);
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

  if (req.method === "POST" && pathname === "/api/bot/update-saved") {
    const parsed = validateUpdateSavedBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    const { currentBotId, session } = parsed.value;
    const connectedEntry = bots.get(currentBotId);
    if (connectedEntry && !connectedEntry.disconnecting) {
      sendJson(res, 409, {
        error: `Bot '${currentBotId}' is still connected. Disconnect it first.`,
      });
      return;
    }

    if (!sessions.has(currentBotId)) {
      sendJson(res, 404, {
        error: `Saved session '${currentBotId}' was not found.`,
      });
      return;
    }

    if (session.botId !== currentBotId) {
      const targetBotEntry = bots.get(session.botId);
      if (targetBotEntry && !targetBotEntry.disconnecting) {
        sendJson(res, 409, {
          error: `Bot '${session.botId}' is already connected.`,
        });
        return;
      }

      if (sessions.has(session.botId)) {
        sendJson(res, 409, {
          error: `Saved session '${session.botId}' already exists.`,
        });
        return;
      }
    }

    sessions.delete(currentBotId);
    upsertSession(session);
    addLog(
      session.botId,
      "system",
      session.botId === currentBotId
        ? "Saved session updated."
        : `Saved session renamed from ${currentBotId} to ${session.botId}.`,
    );
    sendJson(res, 200, {
      ok: true,
      previousBotId: currentBotId,
      session,
    });
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

  if (req.method === "POST" && pathname === "/api/bot/move") {
    const parsed = validateMoveBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      moveBot(parsed.value.botId, parsed.value.action, parsed.value.durationMs);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/auto-attack") {
    const parsed = validateAutoAttackBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      setAutoAttack(parsed.value.botId, parsed.value.enabled);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/ai") {
    const parsed = validateAiBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      setAiMode(
        parsed.value.botId,
        parsed.value.action,
        parsed.value.targetUsername,
      );
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/select-hotbar") {
    const parsed = validateSelectHotbarBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      sendJson(res, 200, await selectHotbar(parsed.value.botId, parsed.value.hotbarIndex));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/equip") {
    const parsed = validateEquipBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      sendJson(
        res,
        200,
        await equipInventoryItem(
          parsed.value.botId,
          parsed.value.slot,
          parsed.value.destination,
        ),
      );
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/bot/drop") {
    const parsed = validateDropBody(await parseJsonBody(req));
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      sendJson(res, 200, await dropInventoryItem(parsed.value.botId, parsed.value.slot));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/bot/status") {
    sendJson(res, 200, getStatus(query.get("botId")));
    return;
  }

  if (req.method === "GET" && pathname === "/api/bot/inventory") {
    try {
      sendJson(res, 200, getInventory(query.get("botId")));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
