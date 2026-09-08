import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"

type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  t: (key: string, params?: Record<string, string>) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell", { example: input.example })
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { example: input.example })
}

export function promptDesignPlaceholder(
  mode: PromptPlaceholderInput["mode"],
  placeholder: string,
  t: PromptPlaceholderInput["t"],
) {
  if (mode === "shell") return placeholder
  return t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" })
}

const BASE_PROMPT_PLACEHOLDER_PHRASES = [
  "Do anything",
  "Build anything",
  "Fix a bug",
  "Explain some code",
  "Refactor a function",
  "Add a feature",
  "Explore a codebase",
  "Plan the next step",
  "Find the problem",
  "Review a change",
  "Write a test",
  "Run a check",
  "Search the project",
  "Trace the bug",
  "Clean up code",
  "Improve performance",
  "Add error handling",
  "Make it accessible",
  "Make it responsive",
  "Try a new idea",
  "Create a component",
  "Design a workflow",
  "Update the docs",
  "Summarize this file",
  "Compare two approaches",
  "Rename a symbol",
  "Move some code",
  "Simplify this logic",
  "Spot a vulnerability",
  "Check the dependencies",
  "Debug a failing test",
  "Inspect the logs",
  "Find dead code",
  "Generate a script",
  "Write a migration",
  "Model some data",
  "Add an API route",
  "Connect a provider",
  "Configure a project",
  "Automate a task",
  "Build a prototype",
  "Sketch an interface",
  "Polish the UI",
  "Improve the copy",
  "Choose a color",
  "Try a new theme",
  "Add keyboard shortcuts",
  "Make it faster",
  "Make it clearer",
  "Make it safer",
  "Explain this error",
  "Decode a stack trace",
  "Understand this repo",
  "Find a file",
  "Open a session",
  "Continue working",
  "Pick up where you left off",
  "Plan a refactor",
  "Review a pull request",
  "Check a diff",
  "Resolve a conflict",
  "Clean up a branch",
  "Write a commit message",
  "Prepare a release",
  "Ship an update",
  "Add a setting",
  "Build a command",
  "Create a tool",
  "Add a skill",
  "Connect an MCP server",
  "Inspect server output",
  "Search the web",
  "Read a document",
  "Summarize a thread",
  "Draft a response",
  "Brainstorm a solution",
  "Break down a task",
  "Turn ideas into steps",
  "Find the fastest path",
  "Validate an assumption",
  "Test an edge case",
  "Handle a failure",
  "Improve a workflow",
  "Organize a project",
  "Rename a project",
  "Find recent chats",
  "Load more sessions",
  "Compare file versions",
  "Explain a design",
  "Make a plan",
  "Switch agents",
  "Change the model",
  "Attach a file",
  "Add context",
  "Use the browser",
  "Open the terminal",
  "Check the status",
  "Ask a question",
  "Start something new",
  "Let's make it work",
] as const

// Keep the animation feeling fresh without maintaining another enormous hand-written
// list. Ten useful actions crossed with fifty common targets gives us 500 additional
// phrases while keeping every entry deterministic and readable.
const EXTRA_PROMPT_ACTIONS = [
  "Build",
  "Fix",
  "Review",
  "Explain",
  "Improve",
  "Test",
  "Refactor",
  "Plan",
  "Document",
  "Explore",
] as const

const EXTRA_PROMPT_TARGETS = [
  "the authentication flow",
  "the API client",
  "the settings page",
  "the sidebar layout",
  "the browser tool",
  "the dictation input",
  "the database query",
  "the WebSocket stream",
  "the session manager",
  "the file uploader",
  "the project dashboard",
  "the command palette",
  "the permissions flow",
  "the model selector",
  "the agent runner",
  "the terminal panel",
  "the error boundary",
  "the loading state",
  "the empty state",
  "the responsive layout",
  "the dark theme",
  "the light theme",
  "the keyboard shortcuts",
  "the notification system",
  "the search experience",
  "the session history",
  "the chat composer",
  "the message queue",
  "the tool output",
  "the permission prompt",
  "the project picker",
  "the account switcher",
  "the browser profile",
  "the background image",
  "the window sizing",
  "the resize handle",
  "the popup window",
  "the MCP connection",
  "the skills hub",
  "the local server",
  "the build script",
  "the test suite",
  "the release workflow",
  "the logging pipeline",
  "the cache layer",
  "the persistence layer",
  "the reconnect logic",
  "the cancellation flow",
  "the queued prompts",
  "the unread indicators",
] as const

const EXTRA_PROMPT_PLACEHOLDER_PHRASES = EXTRA_PROMPT_ACTIONS.flatMap((action) =>
  EXTRA_PROMPT_TARGETS.map((target) => `${action} ${target}`),
)

export const PROMPT_PLACEHOLDER_PHRASES = [...BASE_PROMPT_PLACEHOLDER_PHRASES, ...EXTRA_PROMPT_PLACEHOLDER_PHRASES] as const

type PromptPlaceholderAnimationInput = {
  enabled: Accessor<boolean>
  fallback: Accessor<string>
}

export function createPromptPlaceholderAnimation(input: PromptPlaceholderAnimationInput): Accessor<string> {
  const [value, setValue] = createSignal("")
  const [phraseIndex, setPhraseIndex] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  let phase: "typing" | "pause" | "deleting" | "gap" = "typing"

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  const reducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true

  const tick = () => {
    if (!input.enabled()) return
    const phrase = PROMPT_PLACEHOLDER_PHRASES[phraseIndex()]
    const current = value()

    if (reducedMotion()) {
      setValue(phrase)
      return
    }

    if (phase === "typing") {
      if (current.length < phrase.length) {
        setValue(phrase.slice(0, current.length + 1))
        timer = setTimeout(tick, 52)
        return
      }
      phase = "pause"
      timer = setTimeout(tick, 1150)
      return
    }

    if (phase === "pause") {
      phase = "deleting"
      timer = setTimeout(tick, 0)
      return
    }

    if (phase === "deleting") {
      if (current.length > 0) {
        setValue(current.slice(0, -1))
        timer = setTimeout(tick, 70)
        return
      }
      phase = "gap"
      timer = setTimeout(tick, 220)
      return
    }

    phase = "typing"
    setPhraseIndex((index) => (index + 1) % PROMPT_PLACEHOLDER_PHRASES.length)
    timer = setTimeout(tick, 0)
  }

  createEffect(() => {
    const enabled = input.enabled()
    clearTimer()
    phase = "typing"
    if (!enabled) {
      setValue("")
      return
    }
    timer = setTimeout(tick, 0)
  })

  onCleanup(clearTimer)

  return createMemo(() => (input.enabled() ? value() : input.fallback()))
}
