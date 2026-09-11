<h1 align="center">Overcode</h1>
<p align="center">The open source AI coding agent, with a custom desktop.</p>
<p align="center">
  <a href="https://github.com/ConnorSawaya/overcode/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/ConnorSawaya/overcode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

> **Overcode is a community fork of [opencode](https://github.com/anomalyco/opencode)**
> (MIT licensed, © 2025 opencode). It is not built by, or affiliated with, the OpenCode team.

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![Overcode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/ConnorSawaya/overcode/releases)

---

### Installation

Download the desktop app from this repo's [releases page](https://github.com/ConnorSawaya/overcode/releases),
or run the terminal UI from source:

```bash
git clone https://github.com/ConnorSawaya/overcode.git
cd overcode
bun install
bun run --cwd packages/opencode src/index.ts
```

### Desktop App (Overcode)

Overcode ships as a desktop application with a custom sidebar, dictation input, and session panels.
Download it from this repo's [releases page](https://github.com/ConnorSawaya/overcode/releases).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `overcode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `overcode-desktop-mac-x64.dmg`     |
| Windows               | `overcode-desktop-win-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

> [!TIP]
> The terminal UI runs from source with `bun` (see above); the desktop app updates itself from the releases page.

### Agents

Overcode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure Overcode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to Overcode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### License & Attribution

Overcode is a fork of [opencode](https://github.com/anomalyco/opencode), licensed under the
[MIT License](./LICENSE) (© 2025 opencode, © 2026 Overcode).
Overcode is not affiliated with the OpenCode team — please report Overcode-specific issues
[here](https://github.com/ConnorSawaya/overcode/issues) instead of upstream.

---

**Overcode** — [repo](https://github.com/ConnorSawaya/overcode) | [issues](https://github.com/ConnorSawaya/overcode/issues)
