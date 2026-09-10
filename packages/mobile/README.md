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

On launch, reconnect, foreground return, and periodically while open, the app checks the update manifest at `https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-rebrand/packages/mobile/update.json`. When its version is newer than the bundled app, Overcode Mobile automatically starts downloading the APK and opens Android's normal install confirmation. Android requires the user to approve the install; the app cannot silently replace itself.

When a GitHub release is published, `.github/workflows/overcode-mobile-release.yml` builds a consistently signed APK and uploads it as `Overcode-Mobile.apk`. Update `packages/mobile/update.json` with the matching version in the release source. Set `VITE_OVERCODE_MOBILE_UPDATE_URL` during `build:web`/`build:apk` to use another manifest URL.

## Relay override

Desktop builds use the production relay by default. Set `OVERCODE_RELAY_URL` before launching the desktop app to use another compatible relay during development.
