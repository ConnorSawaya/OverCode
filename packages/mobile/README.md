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
