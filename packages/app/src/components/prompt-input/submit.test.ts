import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import type { ComputerUsePlatform, ComputerUseState } from "@/computer-use"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let computerStartGate: Promise<void> | undefined
let computerStarted = Promise.withResolvers<void>()
let computerStopGate: Promise<void> | undefined
let computerStartError: Error | undefined
let computerStartResult: ComputerUseState | undefined
let computerAdmissionState: ComputerUseState | undefined
let computerStopResult: ComputerUseState | undefined
const computerGrantID = "4b642151-b115-4c31-99f4-f0632eb44d4a"
let computerState: ComputerUseState = { available: true, phase: "idle", color: "#38BDF8" }
let serverUrl = "http://localhost:4096"
let promptResets = 0
let queueCalls = 0
let promptError: Error | undefined
let sessionWorking = false
const sessionStatuses: { sessionID: string; type: string }[] = []
const computerStarts: { sessionID: string; url: string; directory?: string }[] = []
const computerStops: (string | undefined)[] = []
const interrupted: string[] = []
const events: string[] = []
const toasts: { title?: string; description?: string }[] = []
const computerPlatform: ComputerUsePlatform = {
  state: async () => {
    if (computerAdmissionState && computerStarts.length > 0) computerState = computerAdmissionState
    return computerState
  },
  start: async (sessionID, url, directory) => {
    computerStarts.push({ sessionID, url, directory })
    computerStarted.resolve()
    await computerStartGate
    if (computerStartError) throw computerStartError
    computerState = computerStartResult ?? {
      available: true,
      phase: "active",
      color: "#38BDF8",
      sessionID,
      grantID: computerGrantID,
    }
    return computerState
  },
  stop: async (sessionID) => {
    computerStops.push(sessionID)
    events.push("stop")
    await computerStopGate
    computerState = computerStopResult ?? { available: true, phase: "idle", color: "#38BDF8" }
    return computerState
  },
  setColor: async (color) => ({ ...computerState, color }),
  onState: () => () => undefined,
}
let computerCapability: ComputerUsePlatform | undefined = computerPlatform

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => {
    promptResets++
  },
  set: () => undefined,
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          if (promptError) throw promptError
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
        interrupt: async (input: { sessionID: string }) => {
          interrupted.push(input.sessionID)
          events.push("interrupt")
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  mock.module("@/utils/toast", () => ({
    showToast: (toast: { title?: string; description?: string }) => {
      toasts.push(toast)
      return 0
    },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        get url() {
          return serverUrl
        },
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: (field: string, sessionID: string, value: { type?: string }) => {
          if (field !== "session_status" || !value.type) return
          sessionStatuses.push({ sessionID, type: value.type })
          if (sessionID === params.id) sessionWorking = value.type !== "idle"
        },
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      platform: "desktop",
      computerUse: computerCapability,
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  computerStartGate = undefined
  computerStarted = Promise.withResolvers<void>()
  computerStopGate = undefined
  computerStartError = undefined
  computerStartResult = undefined
  computerAdmissionState = undefined
  computerStopResult = undefined
  computerState = { available: true, phase: "idle", color: "#38BDF8" }
  computerCapability = computerPlatform
  serverUrl = "http://localhost:4096"
  promptResets = 0
  queueCalls = 0
  promptError = undefined
  sessionWorking = false
  sessionStatuses.length = 0
  computerStarts.length = 0
  computerStops.length = 0
  interrupted.length = 0
  events.length = 0
  toasts.length = 0
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("computer-use submission", () => {
  const event = () => ({ preventDefault: () => undefined }) as unknown as Event
  const text = (content: string) => {
    promptValue = [{ type: "text", content, start: 0, end: content.length }]
  }
  const setup = (options: Partial<Parameters<typeof createPromptSubmit>[0]> = {}) =>
    createPromptSubmit({
      prompt,
      info: () => (params.id ? { id: params.id } : undefined),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => sessionWorking,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: () => {
        queueCalls++
        return true
      },
      ...options,
    })

  test("bare command explains usage without consent, queueing or session creation", async () => {
    text("/computer-use")
    await setup().handleSubmit(event())
    expect(computerStarts).toEqual([])
    expect(createdSessions).toEqual([])
    expect(sentPrompts).toEqual([])
    expect(promptResets).toBe(0)
    expect(queueCalls).toBe(0)
    expect(toasts).toContainEqual({ title: "computerUse.title", description: "computerUse.usage" })
  })

  test("off stops immediately even busy, without a model or current session", async () => {
    sessionWorking = true
    text("/computer-use off")
    await setup({ model: { current: () => undefined } as unknown as ModelSelection }).handleSubmit(event())
    expect(computerStops).toEqual([undefined])
    expect(computerStarts).toEqual([])
    expect(createdSessions).toEqual([])
    expect(queueCalls).toBe(0)
    expect(sentPrompts).toEqual([])
    expect(promptResets).toBe(1)
  })

  test("off reports stopping instead of claiming the stop has finished", async () => {
    sessionWorking = true
    computerStopResult = { available: true, phase: "stopping", color: "#38BDF8" }
    text("/computer-use off")
    await setup().handleSubmit(event())
    expect(computerStops).toEqual([undefined])
    expect(promptResets).toBe(1)
    expect(toasts).toEqual([{ title: "computerUse.settings.stoppingStatus" }])
    expect(computerStarts).toEqual([])
    expect(promptInputs).toEqual([])
  })

  test("missing desktop capability retains the draft", async () => {
    computerCapability = undefined
    text("/computer-use open Settings")
    await setup().handleSubmit(event())
    expect(computerStarts).toEqual([])
    expect(createdSessions).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("a busy chat refuses consent without queueing, clearing the draft or stopping its existing grant", async () => {
    params.id = "session-current"
    sessionWorking = true
    computerState = {
      available: true,
      phase: "active",
      color: "#38BDF8",
      sessionID: params.id,
      grantID: computerGrantID,
    }
    text("/computer-use open Settings")
    await setup().handleSubmit(event())
    expect(computerStarts).toEqual([])
    expect(computerStops).toEqual([])
    expect(promptInputs).toEqual([])
    expect(queueCalls).toBe(0)
    expect(promptResets).toBe(0)
    expect(optimistic).toEqual([])
    expect(toasts).toContainEqual({ title: "computerUse.title", description: "computerUse.busy" })
    expect(computerState.phase).toBe("active")
  })

  test.each(["starting", "active", "stopping"] as const)(
    "does not acquire or revoke a pre-existing %s grant",
    async (phase) => {
      params.id = "session-current"
      computerState = { available: true, phase, color: "#38BDF8", sessionID: params.id, grantID: computerGrantID }
      text("/computer-use click")
      await setup().handleSubmit(event())
      expect(computerStarts).toEqual([])
      expect(computerStops).toEqual([])
      expect(promptInputs).toEqual([])
      expect(promptResets).toBe(0)
      expect(toasts).toContainEqual({
        title: "computerUse.title",
        description: phase === "stopping" ? "computerUse.settings.stoppingStatus" : "computerUse.inUse",
      })
      expect(computerState.phase).toBe(phase)
    },
  )

  test("active consent submits one ordinary prompt to the current session, not the queue or command API", async () => {
    params.id = "session-current"
    commands.push({ name: "computer-use" })
    text("/computer-use open Settings")
    await setup().handleSubmit(event())
    expect(computerStarts).toEqual([
      { sessionID: "session-current", url: "http://localhost:4096", directory: "/repo/main" },
    ])
    expect(promptInputs).toHaveLength(1)
    const parts = (promptInputs[0] as { legacyParts: { type: string; text: string; synthetic?: boolean }[] })
      .legacyParts
    expect(parts.filter((part) => !part.synthetic).map((part) => part.text)).toEqual(["/computer-use open Settings"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-current",
      directory: "/repo/main",
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
      legacyParts: [
        expect.objectContaining({
          type: "text",
          synthetic: true,
          text: expect.stringContaining(`"grantID": "${computerGrantID}"`),
        }),
        expect.objectContaining({ type: "text", text: "/computer-use open Settings", synthetic: undefined }),
      ],
    })
    expect(queueCalls).toBe(0)
    expect(sentCommands).toEqual([])
    expect(sentShell).toEqual([])
    expect(createdSessions).toEqual([])
    expect(promptResets).toBe(1)
    expect(sessionStatuses).toEqual([{ sessionID: "session-current", type: "busy" }])
  })

  test("new session consent uses the created ID and selected server before handing off the draft", async () => {
    search.draftId = "draft-computer"
    serverUrl = "http://127.0.0.1:44556"
    const consent = Promise.withResolvers<void>()
    computerStartGate = consent.promise
    text("/computer-use open Settings")
    const running = setup({ newSessionWorktree: () => selected }).handleSubmit(event())
    await computerStarted.promise
    selected = "/repo/worktree-b"
    expect(computerStarts).toEqual([{ sessionID: "session-1", url: serverUrl, directory: "/repo/worktree-a" }])
    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(promotedDrafts).toEqual([])
    expect(promptResets).toBe(0)
    consent.resolve()
    await running
    expect(promptInputs).toHaveLength(1)
    expect(promptInputs[0]).toMatchObject({ sessionID: "session-1", directory: "/repo/worktree-a" })
    expect(promotedDrafts).toEqual([{ draftID: "draft-computer", server: "project-server", sessionId: "session-1" }])
  })

  test.each(["idle", "starting", "stopping", "error"] as const)(
    "%s is not consent and retains the draft",
    async (phase) => {
      params.id = "session-current"
      computerStartResult = { available: true, phase, color: "#38BDF8", sessionID: "session-current" }
      text("/computer-use open Settings")
      await setup().handleSubmit(event())
      expect(promptInputs).toEqual([])
      expect(queueCalls).toBe(0)
      expect(promptResets).toBe(0)
    },
  )

  test("wrong-session grant is rejected", async () => {
    params.id = "session-current"
    computerStartResult = {
      available: true,
      phase: "active",
      color: "#38BDF8",
      sessionID: "another-session",
      grantID: computerGrantID,
    }
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(promptInputs).toEqual([])
    expect(computerStops).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("availability loss after activation revokes the newly acquired grant without submitting", async () => {
    params.id = "session-current"
    computerStartResult = {
      available: false,
      phase: "active",
      color: "#38BDF8",
      sessionID: params.id,
      grantID: computerGrantID,
    }
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(computerStops).toEqual(["session-current"])
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
  })

  test.each([undefined, ""])("an active response without a usable grantID is revoked: %s", async (grantID) => {
    params.id = "session-current"
    computerStartResult = { available: true, phase: "active", color: "#38BDF8", sessionID: params.id, grantID }
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(computerStops).toEqual(["session-current"])
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
    expect(computerState.phase).toBe("idle")
  })

  test("admission rejects a replacement grant for the same session without revoking the replacement", async () => {
    params.id = "session-current"
    computerAdmissionState = {
      available: true,
      phase: "active",
      color: "#38BDF8",
      sessionID: params.id,
      grantID: "c542fbfa-95d8-4e36-8d7f-0e9d6338d4a4",
    }
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(computerStarts).toHaveLength(1)
    expect(promptInputs).toEqual([])
    expect(optimistic).toEqual([])
    expect(computerStops).toEqual([])
    expect(computerState.grantID).toBe(computerAdmissionState.grantID)
    expect(promptResets).toBe(0)
  })

  test("a false sendFollowupDraft result revokes the acquired grant and retains the draft", async () => {
    params.id = "session-current"
    computerAdmissionState = {
      available: false,
      phase: "active",
      color: "#38BDF8",
      sessionID: params.id,
      grantID: computerGrantID,
    }
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(computerStarts).toHaveLength(1)
    expect(computerStops).toEqual(["session-current"])
    expect(computerState.phase).toBe("idle")
    expect(promptInputs).toEqual([])
    expect(optimistic).toEqual([])
    expect(sessionStatuses).toEqual([])
    expect(promptResets).toBe(0)
    expect(toasts).toContainEqual({ title: "computerUse.title", description: "computerUse.notGranted" })
  })

  test.each(["server", "session"])(
    "changing %s during consent revokes and never sends to the changed destination",
    async (destination) => {
      params.id = "session-current"
      const consent = Promise.withResolvers<void>()
      computerStartGate = consent.promise
      text("/computer-use click")
      const running = setup().handleSubmit(event())
      await computerStarted.promise
      if (destination === "server") serverUrl = "https://remote.example.test"
      else params.id = "session-other"
      consent.resolve()
      await running
      expect(promptInputs).toEqual([])
      expect(computerStops).toEqual(["session-current"])
      expect(promptResets).toBe(0)
    },
  )

  test("changing destination during session creation never requests consent", async () => {
    const create = Promise.withResolvers<void>()
    createSessionGate = create.promise
    text("/computer-use click")
    const running = setup().handleSubmit(event())
    serverUrl = "https://remote.example.test"
    create.resolve()
    await running
    expect(computerStarts).toEqual([])
    expect(promptInputs).toEqual([])
    expect(promotedDrafts).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("off cancels an outstanding consent request and duplicate submit does not open another dialog", async () => {
    params.id = "session-current"
    const consent = Promise.withResolvers<void>()
    computerStartGate = consent.promise
    text("/computer-use click")
    const submit = setup()
    const running = submit.handleSubmit(event())
    await computerStarted.promise
    await submit.handleSubmit(event())
    expect(computerStarts).toHaveLength(1)
    text("/computer-use off")
    await submit.handleSubmit(event())
    expect(computerStops).toEqual([undefined])
    consent.resolve()
    await running
    expect(promptInputs).toEqual([])
    expect(queueCalls).toBe(0)
  })

  test("prompt failure revokes and never clears the input", async () => {
    params.id = "session-current"
    promptError = new Error("request failed")
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(computerStops).toEqual(["session-current"])
    expect(promptResets).toBe(0)
  })

  test("native rejection keeps the original draft and sends no prompt", async () => {
    params.id = "session-current"
    computerStartError = new Error("local sidecar required")
    text("/computer-use click")
    await setup().handleSubmit(event())
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
    expect(computerStops).toEqual([])
    expect(toasts).toContainEqual({ title: "computerUse.title", description: "computerUse.failed" })
  })

  test("a competing native start rejection cannot revoke the winner's same-session grant", async () => {
    params.id = "session-current"
    const consent = Promise.withResolvers<void>()
    computerStartGate = consent.promise
    text("/computer-use click")
    const running = setup().handleSubmit(event())
    await computerStarted.promise
    computerState = {
      available: true,
      phase: "active",
      color: "#38BDF8",
      sessionID: params.id,
      grantID: computerGrantID,
    }
    computerStartError = new Error("computer_already_in_use")
    consent.resolve()
    await running
    expect(computerStops).toEqual([])
    expect(computerState.phase).toBe("active")
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("becoming busy during consent revokes the new grant without admitting or displaying a task", async () => {
    params.id = "session-current"
    const consent = Promise.withResolvers<void>()
    computerStartGate = consent.promise
    text("/computer-use click")
    const running = setup().handleSubmit(event())
    await computerStarted.promise
    sessionWorking = true
    consent.resolve()
    await running
    expect(computerStops).toEqual(["session-current"])
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
    expect(optimistic).toEqual([])
    expect(sessionStatuses).toEqual([])
    expect(toasts).toContainEqual({ title: "computerUse.title", description: "computerUse.busy" })
  })

  test("becoming busy during session creation refuses native start", async () => {
    const create = Promise.withResolvers<void>()
    createSessionGate = create.promise
    text("/computer-use click")
    const running = setup().handleSubmit(event())
    sessionWorking = true
    create.resolve()
    await running
    expect(computerStarts).toEqual([])
    expect(computerStops).toEqual([])
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("revocation while preparing attachments is checked again before the prompt API", async () => {
    params.id = "session-current"
    text("/computer-use use the attached instructions")
    promptValue.push({
      type: "pasted_text",
      id: "paste-1",
      title: "task",
      charCount: 4,
      lineCount: 1,
      blob: { id: "blob-1", url: "blob:fixture" },
    })
    await setup({
      loadPastedText: async () => {
        computerState = { available: true, phase: "idle", color: "#38BDF8" }
        return "task"
      },
    }).handleSubmit(event())
    expect(computerStarts).toHaveLength(1)
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("editing the draft while consent is open cancels the old submission instead of clearing the new text", async () => {
    params.id = "session-current"
    const consent = Promise.withResolvers<void>()
    computerStartGate = consent.promise
    text("/computer-use click")
    const running = setup().handleSubmit(event())
    await computerStarted.promise
    text("keep this edited draft")
    consent.resolve()
    await running
    expect(promptInputs).toEqual([])
    expect(promptResets).toBe(0)
  })

  test("normal abort stops the captured session before API interruption, even when navigation changes", async () => {
    params.id = "session-current"
    const stop = Promise.withResolvers<void>()
    computerStopGate = stop.promise
    const running = setup().abort()
    expect(events).toEqual(["stop"])
    params.id = "session-other"
    stop.resolve()
    await running
    expect(events).toEqual(["stop", "interrupt"])
    expect(computerStops).toEqual(["session-current"])
    expect(interrupted).toEqual(["session-current"])
  })
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})
