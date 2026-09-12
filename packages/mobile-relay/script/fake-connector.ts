// Fake Overcode connector for phone E2E tests (dev tool, never shipped).
//
// Opens a connector channel on the relay, mints a pairing code, and answers
// the HTTP frames a phone sends while bootstrapping (project catalog,
// health). Pair the phone with the printed code, then watch the frames.
//
// Usage:
//   bun run script/fake-connector.ts [--relay https://host] [--project '[]']
//
// The phone side is driven with: bun run script/phone.ts pair <code>

const args = process.argv.slice(2);
const relayArg = args.indexOf("--relay");
const projectArg = args.indexOf("--project");
const RELAY = (relayArg >= 0 ? args[relayArg + 1] : undefined) ?? "https://overcode-relay-production.up.railway.app";
const PROJECT_JSON =
  (projectArg >= 0 ? args[projectArg + 1] : undefined) ?? JSON.stringify([{ worktree: "/tmp/overcode-e2e" }]);
const WS = RELAY.replace(/^http/, "ws");

const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

const ws = new WebSocket(`${WS}/connector?token=${token}`);
ws.onmessage = (event) => {
  const frame = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
  if (frame?.type === "connector.ready") {
    void registerPairing();
    return;
  }
  if (frame?.type === "http.request") {
    let body = "{}";
    if (frame.path === "/project") body = PROJECT_JSON;
    if (frame.path === "/global/health") body = JSON.stringify({ healthy: true, version: "e2e" });
    ws.send(
      JSON.stringify({
        type: "http.response",
        id: frame.id,
        status: 200,
        headers: [["content-type", "application/json"]],
      }),
    );
    ws.send(JSON.stringify({ type: "http.chunk", id: frame.id, data: Buffer.from(body).toString("base64") }));
    ws.send(JSON.stringify({ type: "http.end", id: frame.id }));
    return;
  }
  console.log(`FRAME:${frame?.type ?? "?"} ${frame?.id ?? ""} ${frame?.path ?? ""}`);
};
ws.onerror = () => {
  console.error("WS_ERROR");
  process.exit(1);
};

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

process.on("SIGINT", () => {
  ws.close();
  process.exit(0);
});
