// Phone E2E helper for Overcode Mobile (dev tool, never shipped).
//
// One-command adb workflows so debugging the phone doesn't mean hand-typing
// adb invocations. Coordinates are in 450-wide preview pixels (the size of
// the screenshots this tool saves) and are scaled to the device automatically.
//
// Usage (from packages/mobile):
//   bun run script/phone.ts devices              list attached devices
//   bun run script/phone.ts install              reinstall debug APK (wipes old signature + pairing)
//   bun run script/phone.ts launch               open the app
//   bun run script/phone.ts shot [name]          screencap -> pull -> shrink, prints png path
//   bun run script/phone.ts tap <x> <y>          tap in preview coords
//   bun run script/phone.ts type <text>          type into the focused field
//   bun run script/phone.ts clear [n=12]         send n deletes to the focused field
//   bun run script/phone.ts pair <code>          focus field, clear, type code, submit via IME check
//   bun run script/phone.ts back|home            navigation keys
//   bun run script/phone.ts stayon [on|off]      keep screen on while plugged in
//   bun run script/phone.ts crashes              show recent FATAL/JS errors from logcat
//
// Full pairing flow:
//   1. bun run script/fake-connector.ts      (in mobile-relay; prints PAIRING_CODE)
//   2. bun run script/phone.ts pair <code>   (types + submits, then shot)
//   3. bun run script/phone.ts shot          (verify workspace)

import { $ } from "bun";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE = "ai.overcode.mobile";
const PREVIEW_WIDTH = 450;

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
for (const candidate of adbCandidates()) {
  const found = Bun.which(candidate) ?? (await Bun.file(candidate).exists() ? candidate : undefined);
  if (found) {
    adbBin = found;
    break;
  }
}
if (!adbBin) {
  console.error("adb not found (checked PATH, platform-tools, Android SDK)");
  process.exit(1);
}

async function adb(...args: string[]): Promise<string> {
  const result = await $`${adbBin} ${args}`.quiet().nothrow();
  return result.text();
}

async function deviceSize(): Promise<{ width: number; height: number }> {
  const out = await adb("shell", "wm", "size");
  const match = /(\d+)x(\d+)/.exec(out);
  if (!match) throw new Error(`cannot parse wm size: ${out}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function toDevice(x: number, y: number): Promise<[number, number]> {
  const size = await deviceSize();
  const scale = size.width / PREVIEW_WIDTH;
  return [Math.round(x * scale), Math.round(y * scale)];
}

async function shot(name = `shot-${Date.now()}`): Promise<string> {
  const remote = `/sdcard/oc-${name}.png`;
  const local = join(tmpdir(), `oc-${name}.png`);
  const small = join(tmpdir(), `oc-${name}-small.png`);
  await adb("shell", "screencap", "-p", remote);
  await adb("pull", remote, local);
  // Shrink via a temp script file so this tool has zero extra deps.
  const shrinkFile = join(tmpdir(), `oc-shrink-${Date.now()}.py`);
  await Bun.write(
    shrinkFile,
    `from PIL import Image\nimg = Image.open(${JSON.stringify(local)})\nimg.thumbnail((480, 1000))\nimg.save(${JSON.stringify(small)})\nprint("ok")\n`,
  );
  const result = await $`py -3 ${shrinkFile}`.quiet().nothrow();
  await Bun.file(shrinkFile).unlink().catch(() => undefined);
  if (result.exitCode !== 0 || !(await Bun.file(small).exists())) {
    console.log(local);
    return local;
  }
  console.log(small);
  return small;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "devices": {
    console.log(await adb("devices", "-l"));
    break;
  }
  case "install": {
    const apk =
      "android\\app\\build\\outputs\\apk\\debug\\app-debug.apk";
    await adb("uninstall", PACKAGE);
    console.log(await adb("install", apk));
    break;
  }
  case "launch": {
    console.log(await adb("shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"));
    break;
  }
  case "shot": {
    await shot(rest[0]);
    break;
  }
  case "tap": {
    const [x, y] = rest.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("usage: phone.ts tap <x> <y>  (450-wide preview coords)");
    const [dx, dy] = await toDevice(x, y);
    await adb("shell", "input", "tap", String(dx), String(dy));
    console.log(`tapped device (${dx}, ${dy})`);
    break;
  }
  case "type": {
    const text = rest.join(" ");
    if (!text) throw new Error("usage: phone.ts type <text>");
    await adb("shell", "input", "text", text.replaceAll(" ", "%s"));
    console.log(`typed ${text.length} chars`);
    break;
  }
  case "clear": {
    const count = Number(rest[0] ?? "12");
    for (let i = 0; i < count; i += 1) await adb("shell", "input", "keyevent", "KEYCODE_DEL");
    console.log("cleared");
    break;
  }
  case "pair": {
    const code = (rest[0] ?? "").replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) throw new Error("usage: phone.ts pair <6-digit-code>");
    // Focus the code field (pairing screen), clear it, type, submit with the
    // keyboard checkmark (IME action) — more reliable than tapping the button,
    // which sits close to the keyboard toolbar.
    await adb("shell", "input", "tap", ...(await toDevice(225, 585)).map(String));
    await Bun.sleep(2000);
    for (let i = 0; i < 12; i += 1) await adb("shell", "input", "keyevent", "KEYCODE_DEL");
    await adb("shell", "input", "text", code);
    await Bun.sleep(2000);
    await adb("shell", "input", "tap", ...(await toDevice(410, 905)).map(String));
    await Bun.sleep(8000);
    await shot("pair-result");
    break;
  }
  case "back":
    await adb("shell", "input", "keyevent", "KEYCODE_BACK");
    break;
  case "home":
    await adb("shell", "input", "keyevent", "KEYCODE_HOME");
    break;
  case "stayon": {
    const value = rest[0] ?? "on";
    await adb("shell", "svc", "power", "stayon", value === "on" ? "true" : "false");
    console.log(await adb("shell", "settings", "get", "global", "stay_on_while_plugged_in"));
    break;
  }
  case "crashes": {
    const log = await adb("logcat", "-d");
    const hits = log
      .split("\n")
      .filter((line) => /AndroidRuntime|FATAL EXCEPTION|Uncaught|TypeError|ReferenceError|chromium.*Uncaught/i.test(line))
      .slice(-15);
    console.log(hits.length ? hits.join("\n") : "no crashes in logcat");
    break;
  }
  default:
    console.error("unknown command (devices|install|launch|shot|tap|type|clear|pair|back|home|stayon|crashes)");
    process.exit(1);
}
