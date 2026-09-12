import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["OVERCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["OVERCODE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("OVERCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OVERCODE_AUTO_HEAP_SNAPSHOT: truthy("OVERCODE_AUTO_HEAP_SNAPSHOT"),
  OVERCODE_GIT_BASH_PATH: process.env["OVERCODE_GIT_BASH_PATH"],
  OVERCODE_CONFIG: process.env["OVERCODE_CONFIG"],
  OVERCODE_CONFIG_CONTENT: process.env["OVERCODE_CONFIG_CONTENT"],
  OVERCODE_DISABLE_AUTOUPDATE: truthy("OVERCODE_DISABLE_AUTOUPDATE"),
  OVERCODE_ALWAYS_NOTIFY_UPDATE: truthy("OVERCODE_ALWAYS_NOTIFY_UPDATE"),
  OVERCODE_DISABLE_PRUNE: truthy("OVERCODE_DISABLE_PRUNE"),
  OVERCODE_DISABLE_TERMINAL_TITLE: truthy("OVERCODE_DISABLE_TERMINAL_TITLE"),
  OVERCODE_SHOW_TTFD: truthy("OVERCODE_SHOW_TTFD"),
  OVERCODE_DISABLE_AUTOCOMPACT: truthy("OVERCODE_DISABLE_AUTOCOMPACT"),
  OVERCODE_DISABLE_MODELS_FETCH: truthy("OVERCODE_DISABLE_MODELS_FETCH"),
  OVERCODE_DISABLE_MOUSE: truthy("OVERCODE_DISABLE_MOUSE"),
  OVERCODE_FAKE_VCS: process.env["OVERCODE_FAKE_VCS"],
  OVERCODE_SERVER_PASSWORD: process.env["OVERCODE_SERVER_PASSWORD"],
  OVERCODE_SERVER_USERNAME: process.env["OVERCODE_SERVER_USERNAME"],
  OVERCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OVERCODE_DISABLE_FFF"),

  // Experimental
  OVERCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("OVERCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OVERCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("OVERCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OVERCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OVERCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OVERCODE_MODELS_URL: process.env["OVERCODE_MODELS_URL"],
  OVERCODE_MODELS_PATH: process.env["OVERCODE_MODELS_PATH"],
  OVERCODE_DB: process.env["OVERCODE_DB"],

  OVERCODE_WORKSPACE_ID: process.env["OVERCODE_WORKSPACE_ID"],
  OVERCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OVERCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OVERCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OVERCODE_DISABLE_PROJECT_CONFIG")
  },
  get OVERCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OVERCODE_EXPERIMENTAL_REFERENCES")
  },
  get OVERCODE_TUI_CONFIG() {
    return process.env["OVERCODE_TUI_CONFIG"]
  },
  get OVERCODE_CONFIG_DIR() {
    return process.env["OVERCODE_CONFIG_DIR"]
  },
  get OVERCODE_PURE() {
    return truthy("OVERCODE_PURE")
  },
  get OVERCODE_PERMISSION() {
    return process.env["OVERCODE_PERMISSION"]
  },
  get OVERCODE_PLUGIN_META_FILE() {
    return process.env["OVERCODE_PLUGIN_META_FILE"]
  },
  get OVERCODE_CLIENT() {
    return process.env["OVERCODE_CLIENT"] ?? "cli"
  },
}
