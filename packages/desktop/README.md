# Overcode Desktop

The Overcode Desktop app, built with Electron.

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

Packaged Overcode builds check `update.json` on launch. To publish a release,
upload the installer artifacts using the names from `packages/desktop/update.json`
and update that manifest's `version`. Set `OVERCODE_UPDATE_URL` to use another
manifest URL.
