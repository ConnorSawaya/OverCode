# Overcode Mobile

Overcode Mobile is a Capacitor Android shell around the existing Overcode web client. The APK keeps no project, session, credential, or execution data locally; it connects to the paired Overcode desktop through the relay URL embedded in the pairing URI.

## Build the debug APK on Windows

Use a JDK 17 or 21 installation and an Android SDK with API 35:

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot"
$env:ANDROID_SDK_ROOT = "C:\Users\<you>\AppData\Local\Android\Sdk"
bun install
bun run build:apk
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

For a connected device or emulator:

```powershell
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The app requests camera access only when scanning a QR pairing code. Manual pairing remains available when camera access is unavailable.

## Mobile APK updates

On launch, reconnect, foreground return, and periodically while open, the app checks the update manifest at `https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-unified/packages/mobile/update.json`. When its version is newer than the bundled app, Overcode Mobile automatically starts downloading the APK and opens Android's normal install confirmation. Android requires the user to approve the install; the app cannot silently replace itself.

When a GitHub release is published, `.github/workflows/overcode-mobile-release.yml` builds a consistently signed APK and uploads it as `Overcode-Mobile.apk`. Update both the version and release-tag URL in `packages/mobile/update.json` for each release. Production builds accept only the pinned Overcode manifest and GitHub release APKs. For a development feed, set `VITE_OVERCODE_MOBILE_UPDATE_URL` and `VITE_OVERCODE_ALLOW_CUSTOM_UPDATES=true` during `build:web`/`build:apk`; custom feeds must still use HTTPS.

## Relay override

Desktop builds use the production relay by default. Set `OVERCODE_RELAY_URL` before launching the desktop app to use another compatible relay during development.

## Phone E2E tooling

Two dev scripts (never shipped) replace hand-typed adb sessions:

```bash
# terminal 1: fake connector (prints PAIRING_CODE, answers project/health)
bun run --cwd ../mobile-relay script/fake-connector.ts

# terminal 2: drive the plugged-in phone
bun run script/phone.ts devices   # list phones
bun run script/phone.ts install   # reinstall the debug APK
bun run script/phone.ts launch    # open the app
bun run script/phone.ts pair 123456  # type code + submit, then screenshot
bun run script/phone.ts shot      # screenshot, prints the png path
bun run script/phone.ts crashes   # recent native/JS crashes from logcat
```

`tap` takes 450-wide preview coordinates (as printed screenshots) and scales
them to the device, so copy positions straight from a screenshot.

Set `OCPHONE_SERIAL` to pin a device when several are attached.

### Talking to the phone without USB

`transport` tells you what is possible on the current network:

```bash
bun run script/phone.ts transport
```

- **USB** always works while plugged in.
- **WiFi adb** needs the phone pingable on the LAN. Many networks run client
  isolation (ours does), which blocks it — then either stay on USB or join
  both ends to a phone hotspot and retry.
- After any network change, re-run `transport` to confirm.

### MCP server (for agents)

`script/mcp.ts` is a dependency-free stdio MCP server wrapping the same
tooling, so agents drive the phone through tools instead of raw adb:

```json
{
  "mcpServers": {
    "overcode-phone": {
      "command": "bun",
      "args": ["run", "script/mcp.ts"],
      "cwd": "C:\\path\\to\\overcode\\packages\\mobile"
    }
  }
}
```

Tools: `devices`, `transport`, `launch`, `shot` (returns a png path — read
it), `tap`, `type_text`, `pair`, `auto_pair`, `back`, `home`, `stay_on`,
`crashes`.
