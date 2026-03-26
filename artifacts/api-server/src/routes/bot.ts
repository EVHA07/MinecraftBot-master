import { Router, type IRouter } from "express";
import {
  ConnectBotBody,
  ConnectBotResponse,
  DisconnectBotResponse,
  SendBotChatBody,
  SendBotChatResponse,
  GetBotStatusResponse,
  GetBotLogsQueryParams,
  GetBotLogsResponse,
} from "@workspace/api-zod";
import {
  connectBot,
  disconnectBot,
  sendChat,
  getStatus,
  getLogs,
} from "../lib/bot";

const router: IRouter = Router();

router.post("/bot/connect", async (req, res): Promise<void> => {
  const parsed = ConnectBotBody.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path?.join(".") ?? "unknown";
    const msg = firstIssue?.message ?? "Invalid request body";
    res.status(400).json({ error: `Validation error on '${field}': ${msg}` });
    return;
  }

  try {
    connectBot(parsed.data);
    res.json(ConnectBotResponse.parse(getStatus()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already connected")) {
      res.status(409).json({ error: message });
    } else {
      res.status(400).json({ error: message });
    }
  }
});

router.post("/bot/disconnect", async (_req, res): Promise<void> => {
  try {
    disconnectBot();
    res.json(DisconnectBotResponse.parse(getStatus()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

router.post("/bot/chat", async (req, res): Promise<void> => {
  const parsed = SendBotChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    sendChat(parsed.data.message);
    res.json(SendBotChatResponse.parse({ ok: true }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

router.get("/bot/status", async (_req, res): Promise<void> => {
  res.json(GetBotStatusResponse.parse(getStatus()));
});

router.get("/bot/logs", async (req, res): Promise<void> => {
  const params = GetBotLogsQueryParams.safeParse(req.query);
  const limit = params.success ? (params.data.limit ?? 100) : 100;
  res.json(GetBotLogsResponse.parse(getLogs(limit)));
});

export default router;
