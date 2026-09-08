import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"

export type PinnedChat = {
  server: string
  sessionID: string
}

export type PinsStore = {
  chats: PinnedChat[]
  projects: string[]
}

export const chatPinKey = (pin: PinnedChat) => `${pin.server}\n${pin.sessionID}`

const sameChat = (a: PinnedChat, b: PinnedChat) => a.server === b.server && a.sessionID === b.sessionID

const sameProject = (a: string, b: string) => pathKey(a) === pathKey(b)

export const toggleChatPin = (list: PinnedChat[], pin: PinnedChat) =>
  list.some((item) => sameChat(item, pin))
    ? list.filter((item) => !sameChat(item, pin))
    : [pin, ...list]

export const toggleProjectPin = (list: string[], worktree: string) =>
  list.some((item) => sameProject(item, worktree))
    ? list.filter((item) => !sameProject(item, worktree))
    : [worktree, ...list]

export const { use: usePins, provider: PinsProvider } = createSimpleContext({
  name: "Pins",
  gate: false,
  init: () => {
    const [store, setStore] = persisted(
      Persist.global("pins", ["pins.v1"]),
      createStore<PinsStore>({ chats: [], projects: [] }),
    )

    const chats = createMemo(() => store.chats)
    const projects = createMemo(() => store.projects)

    return {
      chats,
      projects,
      isChatPinned: (pin: PinnedChat) => store.chats.some((item) => sameChat(item, pin)),
      isProjectPinned: (worktree: string) => store.projects.some((item) => sameProject(item, worktree)),
      toggleChat: (pin: PinnedChat) => setStore("chats", (list) => toggleChatPin(list, pin)),
      toggleProject: (worktree: string) => setStore("projects", (list) => toggleProjectPin(list, worktree)),
      unpinChat: (pin: PinnedChat) => setStore("chats", (list) => list.filter((item) => !sameChat(item, pin))),
      unpinProject: (worktree: string) =>
        setStore("projects", (list) => list.filter((item) => !sameProject(item, worktree))),
    }
  },
})
