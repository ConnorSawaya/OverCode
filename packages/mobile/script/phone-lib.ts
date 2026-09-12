// Shared phone-driving library for Overcode Mobile E2E (dev tool, never shipped).
//
// Used by script/phone.ts (CLI) and script/mcp.ts (MCP server) so agents and
// humans drive the phone the same way. Coordinates are in 450-wide preview
// pixels (the size of saved screenshots) and are scaled to the device.
//
// Transports: USB adb today. Set OCPHONE_SERIAL to pin a device when several
// are attached. If the WiFi network isolates clients (no ping to the phone),
// wireless adb is impossible on that network — use USB, or join both ends to
// a phone hotspot instead. `transportStatus()` reports all of this.

import { $ } from "bun";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const PACKAGE = "ai.overcode.mobile";
export const PREVIEW_WIDTH = 450;

// adb subcommands that address the server itself, not a device.
const SERVER_COMMANDS = new Set(["devices", "connect", "disconnect", "pair", "version", "start-server", "kill-server"]);

function adbCandidates(): string[] {
  const fromPath = Bun.which("adb");
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return [
    ...(fromPath ? [fromPath] : []),
    "C:\\Users\\overcode\\platform-tools\\adb.exe",
    join(home, "platform-tools", "adb.exe"),
    join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk", "platform-tools", "adb.exe"),
  ].filter(Boolean) as string[];
}

let adbBin = "";
export async function adbPath(): Promise<string> {
  if (adbBin) return adbBin;
  for (const candidate of adbCandidates()) {
    const found = Bun.which(candidate) ?? ((await Bun.file(candidate).exists()) ? candidate : undefined);
    if (found) {
      adbBin = found;
      return adbBin;
    }
  }
  throw new Error("adb not found (checked PATH, platform-tools, Android SDK)");
}

// Every adb call carries a hard timeout so a wedged transport fails loudly
// instead of hanging the session. Override per-run with OCPHONE_ADB_TIMEOUT_MS.
function adbTimeoutMs(): number {
  const raw = Number(process.env.OCPHONE_ADB_TIMEOUT_MS ?? "60000");
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

export async function adb(...args: string[]): Promise<string> {
  const bin = await adbPath();
  const serial = process.env.OCPHONE_SERIAL;
  const full = serial && !SERVER_COMMANDS.has(args[0] ?? "") ? ["-s", serial, ...args] : args;
  // Bun.spawn (not Bun.$): `timeout` kills wedged transports, and the
  // promise shape below never rejects — callers get output or empty string.
  const proc = Bun.spawn([bin, ...full], { stdout: "pipe", stderr: "pipe", timeout: adbTimeoutMs() });
  const [out] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    proc.exited.then(
      () => undefined,
      () => undefined,
    ),
  ]);
  return out;
}

export async function deviceSize(): Promise<{ width: number; height: number }> {
  const out = await adb("shell", "wm", "size");
  const match = /(\d+)x(\d+)/.exec(out);
  if (!match) throw new Error(`cannot parse wm size: ${out}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function toDevice(x: number, y: number): Promise<[number, number]> {
  const size = await deviceSize();
  const scale = size.width / PREVIEW_WIDTH;
  return [Math.round(x * scale), Math.round(y * scale)];
}

async function shrinkPng(local: string, small: string): Promise<boolean> {
  const shrinkFile = join(tmpdir(), `oc-shrink-${Date.now()}.py`);
  await Bun.write(
    shrinkFile,
    `from PIL import Image\nimg = Image.open(${JSON.stringify(local)})\nimg.thumbnail((480, 1000))\nimg.save(${JSON.stringify(small)})\nprint("ok")\n`,
  );
  // `py -3` first (Windows launcher), plain `python` as fallback.
  let result = await $`py -3 ${shrinkFile}`.quiet().nothrow();
  if (result.exitCode !== 0) result = await $`python ${shrinkFile}`.quiet().nothrow();
  await Bun.file(shrinkFile).unlink().catch(() => undefined);
  return result.exitCode === 0 && (await Bun.file(small).exists());
}

export async function shot(name = `shot-${Date.now()}`): Promise<string> {
  const remote = `/sdcard/oc-${name}.png`;
  const local = join(tmpdir(), `oc-${name}.png`);
  const small = join(tmpdir(), `oc-${name}-small.png`);
  await adb("shell", "screencap", "-p", remote);
  await adb("pull", remote, local);
  if (await shrinkPng(local, small)) {
    console.log(small);
    return small;
  }
  console.log(local);
  return local;
}

export async function uiDump(): Promise<string> {
  const remote = `/sdcard/oc-ui-${Date.now()}.xml`;
  await adb("shell", "uiautomator", "dump", remote);
  const local = join(tmpdir(), `oc-ui-${Date.now()}.xml`);
  await adb("pull", remote, local);
  const text = await Bun.file(local).text().catch(() => "");
  await Bun.file(local).unlink().catch(() => undefined);
  return text;
}

export function eachNode(xml: string): Array<Record<string, string>> {
  const nodes: Array<Record<string, string>> = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!;
    nodes.push(attrs);
  }
  return nodes;
}

// True when an editable field currently shows the code (typed, not placeholder).
export function fieldContains(xml: string, code: string): boolean {
  return eachNode(xml).some(
    (node) =>
      (node["class"] === "android.widget.EditText" || node["focusable"] === "true") &&
      (node["text"] ?? "").replace(/\D/g, "").includes(code),
  );
}

// Center of an enabled node with the given visible text, in device pixels.
export function findButton(xml: string, text: string): [number, number] | undefined {
  for (const node of eachNode(xml)) {
    if (node["enabled"] === "false") continue;
    if ((node["text"] ?? "").trim() !== text) continue;
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(node["bounds"] ?? "");
    if (!bounds) continue;
    return [Math.round((Number(bounds[1]) + Number(bounds[3])) / 2), Math.round((Number(bounds[2]) + Number(bounds[4])) / 2)];
  }
  return undefined;
}

// Focus the pairing code field, clear it, type the code, and submit via the
// real Connect button (found in the UI tree). Retries focus+type up to 3x.
export async function enterPairingCode(code: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await adb("shell", "input", "tap", ...(await toDevice(225, 585)).map(String));
    await Bun.sleep(2000);
    for (let i = 0; i < 12; i += 1) await adb("shell", "input", "keyevent", "KEYCODE_DEL");
    await adb("shell", "input", "text", code);
    await Bun.sleep(2000);
    if (fieldContains(await uiDump(), code)) break;
    if (attempt === 3) throw new Error(`code field never showed ${code} after 3 attempts`);
  }
  const xml = await uiDump();
  const connect = findButton(xml, "Connect to PC");
  if (connect) {
    await adb("shell", "input", "tap", String(connect[0]), String(connect[1]));
  } else {
    // Fallback: keyboard checkmark position in preview coords.
    await adb("shell", "input", "tap", ...(await toDevice(410, 905)).map(String));
  }
}

export async function autoPair(relay: string | undefined, timeoutMs: number): Promise<void> {
  const connectorPath = fileURLToPath(new URL("../../mobile-relay/script/fake-connector.ts", import.meta.url));
  const connectorArgs = ["run", connectorPath];
  if (relay) connectorArgs.push("--relay", relay);
  const connector = Bun.spawn(["bun", ...connectorArgs], { stdout: "pipe", stderr: "pipe" });
  try {
    const before = await uiDump();
    if (findButton(before, "Add PC") && !findButton(before, "Connect to PC")) {
      // Workspace visible — already paired from an earlier run.
      const shotPath = await shot("auto-already-paired");
      console.log(`ALREADY PAIRED (workspace visible): ${shotPath}`);
      return;
    }
    const code = await readConnectorCode(connector, timeoutMs);
    console.log(`code: ${code}`);
    await enterPairingCode(code);
    await waitForPaired(connector, timeoutMs);
    console.log("PAIRED: relay confirmed device.paired");
    await shot("auto-pair-result");
  } finally {
    connector.kill();
    await connector.exited.catch(() => undefined);
  }
}

async function readConnectorCode(connector: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<string> {
  const reader = connector.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined)]);
    if (!next || next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const match = /PAIRING_CODE:(\d{6})/.exec(buffer);
    if (match) {
      reader.releaseLock();
      return match[1]!;
    }
    if (/PAIRING_FAILED|WS_ERROR/.test(buffer)) throw new Error(`connector failed: ${buffer.trim().split("\n").at(-1)}`);
  }
  reader.releaseLock();
  throw new Error(`timed out after ${timeoutMs}ms waiting for PAIRING_CODE`);
}

async function waitForPaired(connector: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<void> {
  const reader = connector.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined)]);
    if (!next || next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    if (buffer.includes("FRAME:device.paired")) {
      reader.releaseLock();
      return;
    }
  }
  reader.releaseLock();
  const tail = buffer.trim().split("\n").slice(-5).join("\n");
  throw new Error(`timed out after ${timeoutMs}ms waiting for device.paired. connector said:\n${tail}`);
}

export async function crashLog(): Promise<string> {
  const log = await adb("logcat", "-d");
  const hits = log
    .split("\n")
    .filter((line) => /AndroidRuntime|FATAL EXCEPTION|Uncaught|TypeError|ReferenceError|chromium.*Uncaught/i.test(line))
    .slice(-15);
  return hits.length ? hits.join("\n") : "no crashes in logcat";
}

// Diagnose how this PC can reach the phone. USB always works when plugged in;
// WiFi adb needs the phone reachable on the LAN (no client isolation).
export async function transportStatus(): Promise<string> {
  const lines: string[] = [];
  lines.push(`OCPHONE_SERIAL=${process.env.OCPHONE_SERIAL ?? "(unset — using first/only device)"}`);
  lines.push(`devices:\n${await adb("devices", "-l")}`.trimEnd());
  const route = await adb("shell", "ip", "route").catch(() => "");
  const ip = /src (\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1];
  lines.push(`phone wifi ip: ${ip ?? "unknown"}`);
  if (ip) {
    const ping = await $`ping -n 2 -w 2000 ${ip}`.quiet().nothrow().then(
      (r) => /TTL=/i.test(r.text()),
      () => false,
    );
    lines.push(
      ping
        ? `wifi reachable: YES — wireless adb possible (adb tcpip 5555 + adb connect ${ip}:5555)`
        : "wifi reachable: NO (client isolation or different AP) — USB required, or join both ends to a phone hotspot",
    );
  }
  return lines.join("\n");
}
