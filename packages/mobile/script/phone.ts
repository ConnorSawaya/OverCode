// Phone E2E CLI for Overcode Mobile (dev tool, never shipped).
//
// Thin wrapper over ./phone-lib.ts. See that file for the shared logic
// (also used by ./mcp.ts so agents drive the phone the same way).
//
// Usage (from packages/mobile):
//   bun run script/phone.ts devices              list attached devices
//   bun run script/phone.ts install              reinstall debug APK (wipes old signature + pairing)
//   bun run script/phone.ts launch               open the app
//   bun run script/phone.ts shot [name]          screencap -> pull -> shrink, prints png path
//   bun run script/phone.ts tap <x> <y>          tap in preview coords (450-wide screenshots)
//   bun run script/phone.ts type <text>          type into the focused field
//   bun run script/phone.ts clear [n=12]         send n deletes to the focused field
//   bun run script/phone.ts pair <code>          focus field, clear, type code, submit, screenshot
//   bun run script/phone.ts auto [--relay URL] [--timeout-ms 45000] [--proxy URL]
//                                                 mint code + pair + verify, one command
//   bun run script/phone.ts back|home            navigation keys
//   bun run script/phone.ts stayon [on|off]      keep screen on while plugged in
//   bun run script/phone.ts crashes              recent FATAL/JS errors from logcat
//   bun run script/phone.ts transport            diagnose USB vs WiFi reachability
//
// OCPHONE_SERIAL pins a device when several are attached.

import {
  PACKAGE,
  adb,
  autoPair,
  crashLog,
  enterPairingCode,
  shot,
  toDevice,
  transportStatus,
} from "./phone-lib";

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "devices": {
    console.log(await adb("devices", "-l"));
    break;
  }
  case "transport": {
    console.log(await transportStatus());
    break;
  }
  case "install": {
    const apk = "android\\app\\build\\outputs\\apk\\debug\\app-debug.apk";
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
    await enterPairingCode(code);
    await shot("pair-result");
    break;
  }
  case "auto": {
    const relayIndex = rest.indexOf("--relay");
    const relay = relayIndex >= 0 ? rest[relayIndex + 1] : undefined;
    const proxyIndex = rest.indexOf("--proxy");
    const proxy = proxyIndex >= 0 ? rest[proxyIndex + 1] : undefined;
    const timeoutIndex = rest.indexOf("--timeout-ms");
    const timeoutMs = timeoutIndex >= 0 ? Number(rest[timeoutIndex + 1]) : 45000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("usage: phone.ts auto [--relay URL] [--timeout-ms 45000]");
    await autoPair(relay, timeoutMs, proxy);
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
    console.log(await crashLog());
    break;
  }
  default:
    console.error("unknown command (devices|install|launch|shot|tap|type|clear|pair|auto|back|home|stayon|crashes|transport)");
    process.exit(1);
}
