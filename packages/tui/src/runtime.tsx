import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return input
  // Keep displayed paths stable across platforms. The TUI treats these as
  // labels, not paths that are passed back to the filesystem, so using `/`
  // avoids leaking Windows separators into the shared UI.
  return "~/" + relative.split(path.sep).join("/")
}
