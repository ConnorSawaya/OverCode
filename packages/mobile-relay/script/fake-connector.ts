// Fake Overcode connector for phone E2E tests (dev tool, never shipped).
//
// Opens a connector channel on the relay, mints a pairing code, and answers
// the HTTP frames a phone sends while bootstrapping (project catalog,
// health). Pair the phone with the printed code, then watch the frames.
//
// With --proxy, every frame is forwarded to a real local backend instead of
// the canned responses, giving the phone a full server for E2E tests.
//
// The channel token persists in --token-file (default %TEMP%), so connector
// restarts are transparent to an already-paired phone: pair once, then the
// phone survives connector AND backend restarts. A fresh pairing code is
// minted on every (re)start; expired codes are harmless on a paired phone.
// The socket auto-reconnects with backoff; a CONNECTOR_ALIVE line is logged
// every 60s so silent death is detectable from the log mtime.
//
// Usage:
//   bun run script/fake-connector.ts [--relay https://host] [--project '[]']
//   bun run script/fake-connector.ts --proxy http://127.0.0.1:4096 [--token-file path]
//
// The phone side is driven with: bun run script/phone.ts pair <code>

import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const relayArg = args.indexOf("--relay");
const projectArg = args.indexOf("--project");
const proxyArg = args.indexOf("--proxy");
const tokenFileArg = args.indexOf("--token-file");
const RELAY = (relayArg >= 0 ? args[relayArg + 1] : undefined) ?? "https://overcode-relay-production.up.railway.app";
const PROJECT_JSON =
  (projectArg >= 0 ? args[projectArg + 1] : undefined) ?? JSON.stringify([{ worktree: "/tmp/overcode-e2e" }]);
const PROXY = proxyArg >= 0 ? args[proxyArg + 1] : undefined;
const TOKEN_FILE = (tokenFileArg >= 0 ? args[tokenFileArg + 1] : undefined) ?? join(tmpdir(), "oc-connector-token");
const WS = RELAY.replace(/^http/, "ws");
const RECONNECT_DELAY_MS = 2_000;
const HEARTBEAT_MS = 60_000;

function loadToken(): string {
  try {
    const saved = Bun.file(TOKEN_FILE);
    return saved.text().then((text) => {
      const trimmed = text.trim();
      if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
      throw new Error("bad token");
    });
  } catch {
    // Fall through to minting below; Bun.file().text() rejects handled by caller.
  }
  const fresh = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  return Bun.write(TOKEN_FILE, fresh).then(() => fresh);
}

const token = await loadToken().catch(async () => {
  const fresh = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await Bun.write(TOKEN_FILE, fresh);
  return fresh;
});
console.log(`TOKEN_FILE:${TOKEN_FILE}`);

const requests = new Map<string, AbortController>();
const terminalSockets = new Map<string, WebSocket>();

let ws: WebSocket | undefined;
let intentionalClose = false;
let readyOnce = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const startedAt = Date.now();

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function connect() {
  if (intentionalClose) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const socket = new WebSocket(`${WS}/connector?token=${token}`);
  ws = socket;
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    const frame = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
    if (frame?.type === "connector.ready") {
      if (!readyOnce) {
        readyOnce = true;
        void registerPairing();
      } else {
        console.log("RELAY_RECONNECTED (channel resumed, no re-pair needed)");
      }
      return;
    }
    if (frame?.type === "http.request") {
      void handleHttp(frame);
      return;
    }
    if (frame?.type === "http.cancel") {
      requests.get(frame.id)?.abort();
      return;
    }
    if (frame?.type === "ws.open") {
      void handleWebSocket(frame);
      return;
    }
    if (frame?.type === "ws.data") {
      const terminal = terminalSockets.get(frame.id);
      if (!terminal || terminal.readyState !== WebSocket.OPEN) return;
      terminal.send(frame.binary ? Buffer.from(frame.data, "base64") : Buffer.from(frame.data, "base64").toString());
      return;
    }
    if (frame?.type === "ws.close") {
      terminalSockets.get(frame.id)?.close(frame.code, frame.reason);
      terminalSockets.delete(frame.id);
      return;
    }
    console.log(`FRAME:${frame?.type ?? "?"} ${frame?.id ?? ""} ${frame?.path ?? ""}`);
  };
  socket.onerror = () => {
    console.error("RELAY_SOCKET_ERROR");
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = undefined;
    if (intentionalClose) return;
    for (const abort of requests.values()) abort.abort();
    console.error(`RELAY_CLOSED retrying in ${RECONNECT_DELAY_MS}ms`);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };
}

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "cookie",
  "proxy-authorization",
  "forwarded",
  "x-overcode-channel-token",
  "x-overcode-device-id",
]);
const BLOCKED_RESPONSE_HEADERS = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);

async function handleHttp(frame) {
  if (!PROXY) {
    let body = "{}";
    if (frame.path === "/project") body = PROJECT_JSON;
    if (frame.path === "/global/health") body = JSON.stringify({ healthy: true, version: "e2e" });
    send({
      type: "http.response",
      id: frame.id,
      status: 200,
      headers: [["content-type", "application/json"]],
    });
    send({ type: "http.chunk", id: frame.id, data: Buffer.from(body).toString("base64") });
    send({ type: "http.end", id: frame.id });
    return;
  }
  const abort = new AbortController();
  requests.set(frame.id, abort);
  try {
    const target = new URL(frame.path, PROXY);
    const headers = new Headers(frame.headers.filter(([name]) => !BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())));
    const response = await fetch(target, {
      method: frame.method,
      headers,
      body: frame.body ? Buffer.from(frame.body, "base64") : undefined,
      redirect: "manual",
      signal: abort.signal,
    });
    console.log(
      `HTTP:${frame.method} ${frame.path} => ${response.status} [${response.headers.get("content-type") ?? "none"}]`,
    );
    send({
      type: "http.response",
      id: frame.id,
      status: response.status,
      headers: [...response.headers.entries()].filter(([name]) => !BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())),
    });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value?.byteLength)
          send({ type: "http.chunk", id: frame.id, data: Buffer.from(next.value).toString("base64") });
      }
    }
    send({ type: "http.end", id: frame.id });
  } catch (error) {
    if (!abort.signal.aborted)
      send({ type: "http.end", id: frame.id, error: error instanceof Error ? error.message : "request_failed" });
  } finally {
    requests.delete(frame.id);
  }
}

async function handleWebSocket(frame) {
  if (!PROXY) return;
  try {
    const target = new URL(frame.path, PROXY);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target);
    socket.binaryType = "arraybuffer";
    terminalSockets.set(frame.id, socket);
    socket.onopen = () => send({ type: "ws.accept", id: frame.id });
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        send({ type: "ws.data", id: frame.id, data: Buffer.from(event.data).toString("base64"), binary: false });
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        send({
          type: "ws.data",
          id: frame.id,
          data: Buffer.from(event.data).toString("base64"),
          binary: true,
        });
      }
    };
    socket.onerror = () => send({ type: "ws.error", id: frame.id, message: "terminal_connection_failed" });
    socket.onclose = (event) => {
      terminalSockets.delete(frame.id);
      send({ type: "ws.close", id: frame.id, code: event.code === 1005 ? 0 : event.code, reason: event.reason });
    };
  } catch (error) {
    send({ type: "ws.error", id: frame.id, message: error instanceof Error ? error.message : "terminal_connection_failed" });
  }
}

async function registerPairing() {
  console.log("CONNECTOR_READY");
  const response = await fetch(`${RELAY}/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-overcode-channel-token": token },
    body: "{}",
  });
  if (!response.ok) {
    console.error(`PAIRING_FAILED:${response.status}`);
    process.exit(1);
  }
  const pairing = (await response.json()) as { code?: string; expiresAt?: number };
  console.log(`PAIRING_CODE:${pairing.code}`);
  console.log(`EXPIRES_AT:${pairing.expiresAt} (5 minute TTL — pair fast)`);
}

setInterval(() => {
  console.log(`CONNECTOR_ALIVE uptime=${Math.round((Date.now() - startedAt) / 1000)}s pending=${requests.size}`);
}, HEARTBEAT_MS);

function shutdown() {
  intentionalClose = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    ws?.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

connect();
