import http from "node:http";
import crypto from "node:crypto";
import type { Peer, BrokerMessage } from "./types.js";

const PORT = 7899;
const HOST = "127.0.0.1";
const PEER_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

const peers = new Map<string, Peer>();
const messages = new Map<string, BrokerMessage>();

const startedAt = Date.now();

function log(msg: string): void {
  process.stderr.write(`[broker] ${msg}\n`);
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Route handlers

function handleRegister(body: Record<string, unknown>, res: http.ServerResponse): void {
  const { id, pid, cwd, gitRoot, summary, models } = body;
  if (typeof id !== "string" || typeof pid !== "number" || typeof cwd !== "string") {
    jsonResponse(res, 400, { error: "Missing required fields: id, pid, cwd" });
    return;
  }
  const peer: Peer = {
    id,
    pid,
    cwd,
    gitRoot: typeof gitRoot === "string" ? gitRoot : undefined,
    summary: typeof summary === "string" ? summary : undefined,
    lastSeen: Date.now(),
    models: Array.isArray(models) ? models : undefined,
  };
  peers.set(id, peer);
  log(`registered peer ${id} (pid=${pid})`);
  jsonResponse(res, 200, { ok: true });
}

function handleUnregister(body: Record<string, unknown>, res: http.ServerResponse): void {
  const { id } = body;
  if (typeof id !== "string") {
    jsonResponse(res, 400, { error: "Missing required field: id" });
    return;
  }
  peers.delete(id);
  // Clean up messages for this peer
  for (const [msgId, msg] of messages) {
    if (msg.from === id || msg.to === id) messages.delete(msgId);
  }
  log(`unregistered peer ${id}`);
  jsonResponse(res, 200, { ok: true });
}

function handleGetPeers(url: URL, res: http.ServerResponse): void {
  const scope = url.searchParams.get("scope") ?? "machine";
  const cwd = url.searchParams.get("cwd");
  const gitRoot = url.searchParams.get("gitRoot");

  let result = Array.from(peers.values());

  if (scope === "directory" && cwd) {
    result = result.filter(p => p.cwd === cwd);
  } else if (scope === "repo" && gitRoot) {
    result = result.filter(p => p.gitRoot === gitRoot);
  }
  // scope=machine returns all peers

  jsonResponse(res, 200, { peers: result });
}

function handleSendMessage(body: Record<string, unknown>, res: http.ServerResponse): void {
  const { from, to, content } = body;
  if (typeof from !== "string" || typeof to !== "string" || typeof content !== "string") {
    jsonResponse(res, 400, { error: "Missing required fields: from, to, content" });
    return;
  }
  const msg: BrokerMessage = {
    id: crypto.randomUUID(),
    from,
    to,
    content,
    timestamp: Date.now(),
    delivered: false,
  };
  messages.set(msg.id, msg);
  log(`message ${msg.id} from=${from} to=${to}`);
  jsonResponse(res, 200, { id: msg.id });
}

function handlePollMessages(url: URL, res: http.ServerResponse): void {
  const peerId = url.searchParams.get("peerId");
  if (!peerId) {
    jsonResponse(res, 400, { error: "Missing query param: peerId" });
    return;
  }

  const result: BrokerMessage[] = [];
  for (const msg of messages.values()) {
    if (msg.to === peerId && !msg.delivered) {
      msg.delivered = true;
      result.push(msg);
    }
  }

  // Update lastSeen for the polling peer
  const peer = peers.get(peerId);
  if (peer) peer.lastSeen = Date.now();

  jsonResponse(res, 200, { messages: result });
}

function handleSetSummary(body: Record<string, unknown>, res: http.ServerResponse): void {
  const { id, summary } = body;
  if (typeof id !== "string" || typeof summary !== "string") {
    jsonResponse(res, 400, { error: "Missing required fields: id, summary" });
    return;
  }
  const peer = peers.get(id);
  if (!peer) {
    jsonResponse(res, 404, { error: `Peer not found: ${id}` });
    return;
  }
  peer.summary = summary;
  jsonResponse(res, 200, { ok: true });
}

function handleHealth(res: http.ServerResponse): void {
  jsonResponse(res, 200, {
    ok: true,
    peers: peers.size,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
}

// Dead peer cleanup

function cleanupDeadPeers(): void {
  const now = Date.now();
  const deadIds: string[] = [];

  for (const [id, peer] of peers) {
    if (now - peer.lastSeen > PEER_TTL_MS) {
      deadIds.push(id);
    }
  }

  for (const id of deadIds) {
    peers.delete(id);
    // Remove orphaned messages
    for (const [msgId, msg] of messages) {
      if (msg.from === id || msg.to === id) messages.delete(msgId);
    }
    log(`cleaned up dead peer ${id}`);
  }
}

// Server

export function startBroker(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const path = url.pathname;

    try {
      // GET routes
      if (method === "GET") {
        if (path === "/health") return handleHealth(res);
        if (path === "/peers") return handleGetPeers(url, res);
        if (path === "/pollMessages") return handlePollMessages(url, res);
        jsonResponse(res, 404, { error: "Not found" });
        return;
      }

      // POST routes
      if (method === "POST") {
        const raw = await readBody(req);
        const body = parseJson(raw);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          jsonResponse(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const obj = body as Record<string, unknown>;

        if (path === "/register") return handleRegister(obj, res);
        if (path === "/unregister") return handleUnregister(obj, res);
        if (path === "/sendMessage") return handleSendMessage(obj, res);
        if (path === "/setSummary") return handleSetSummary(obj, res);
        jsonResponse(res, 404, { error: "Not found" });
        return;
      }

      jsonResponse(res, 405, { error: "Method not allowed" });
    } catch (err) {
      log(`error: ${err}`);
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  });

  const cleanupTimer = setInterval(cleanupDeadPeers, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  server.listen(PORT, HOST, () => {
    log(`broker listening on http://${HOST}:${PORT}`);
  });

  return server;
}

// Entry point

const server = startBroker();
process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
