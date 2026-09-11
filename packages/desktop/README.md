# Overcode Desktop

The Overcode Desktop app, built with Electron. The OpenCode-compatible protocol
and server names remain unchanged internally.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Desktop updates

Packaged Overcode builds check the GitHub-hosted `update.json` on launch and
again every six hours. When a newer version is found, the installer downloads
in the background and Overcode asks to restart and install it.

To publish a Windows release, run the **Overcode Desktop Release** GitHub
Actions workflow with a semantic version such as `1.18.32`. It creates the
versioned `overcode-desktop-v1.18.32` release, uploads the installer, and
updates this manifest on `overcode-unified`. Keep release assets versioned;
the feed must not use GitHub's global `latest` alias because mobile and desktop
releases share the repository.

Android and Windows both require the normal platform install confirmation;
the updater never silently replaces an installation. Set
`OVERCODE_UPDATE_URL` to use another HTTPS manifest URL. Packaged builds
otherwise accept only the repository's pinned GitHub manifest and releases;
set `OVERCODE_ALLOW_CUSTOM_UPDATES=true` together with `OVERCODE_UPDATE_URL`
only for a development HTTPS feed.
