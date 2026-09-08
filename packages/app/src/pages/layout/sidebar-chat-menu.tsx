import { Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePins } from "@/context/pins"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { sessionTitle } from "@/utils/session-title"
import { collectSessionDescendants, errorMessage } from "./helpers"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/utils/session-export"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { showToast } from "@/utils/toast"

export const useChatRowActions = () => {
  const language = useLanguage()
  const layout = useLayout()
  const pins = usePins()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const settings = useSettings()
  const tabs = useTabs()
  const dialog = useDialog()

  const updateCachedTitle = (session: Session, title: string) => {
    const [, setChild] = serverSync().child(session.directory)
    setChild("session", (list) => (list ?? []).map((item) => (item.id === session.id ? { ...item, title } : item)))
  }

  const renameChat = async (session: Session, title: string) => {
    const next = title.trim()
    if (!next || next === sessionTitle(session.title)) return true
    updateCachedTitle(session, next)
    const previous = serverSync().session.get(session.id)
    if (previous) serverSync().session.remember({ ...previous, title: next })
    await serverSDK()
      .api.session.rename({ sessionID: session.id, title: next })
      .catch((err) => {
        updateCachedTitle(session, session.title)
        const current = serverSync().session.get(session.id)
        if (current) serverSync().session.remember({ ...current, title: session.title })
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return null
      })
    return true
  }

  const duplicateChat = async (session: Session) => {
    const forked = await serverSDK()
      .api.session.fork({ sessionID: session.id })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })
    if (!forked) return
    const tab = tabs.addSessionTab({ server: server.key, sessionId: forked.id })
    tabs.select(tab)
  }

  const exportChat = (session: Session) => {
    void (async () => {
      try {
        const data = await fetchSessionExport({ sessionID: session.id, client: serverSDK().client })
        const filename = sessionExportFilename(data.info)
        downloadSessionExport(filename, data)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("toast.session.export.success.title"),
          description: language.t("toast.session.export.success.description", { filename }),
        })
      } catch (err) {
        showToast({
          variant: "error",
          title: language.t("toast.session.export.failed.title"),
          description: err instanceof Error ? err.message : language.t("toast.session.export.failed.description"),
        })
      }
    })()
  }

  const deleteChat = async (session: Session) => {
    const id = session.id
    const key = server.key
    const [childStore] = serverSync().child(session.directory)
    const removedIDs = collectSessionDescendants(childStore.session ?? [], id)
    const removed = await serverSDK()
      .api.session.remove({ sessionID: id, directory: session.directory })
      .then(() => true)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })
    if (!removed) return
    layout.discardSessions({ scope: serverSDK().scope, directory: session.directory, sessionIDs: removedIDs })
    for (const removedID of removedIDs) pins.unpinChat({ server: key, sessionID: removedID })
    const openIndexes = tabs.store
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => tab.type === "session" && tab.server === key && removedIDs.has(tab.sessionId))
      .map(({ index }) => index)
      .sort((a, b) => b - a)
    for (const index of openIndexes) tabs.closeTab(index)
    for (const removedID of removedIDs) tabs.removeSessionTab({ server: key, sessionId: removedID })
    const [, setChild] = serverSync().child(session.directory)
    setChild("session", (list) => (list ?? []).filter((item) => !removedIDs.has(item.id)))
    notifySessionTabsRemoved({ directory: session.directory, sessionIDs: [...removedIDs] })
  }

  const confirmDeleteChat = (session: Session) => {
    const name = () => sessionTitle(serverSync().session.get(session.id)?.title) ?? language.t("command.session.new")
    const handleDelete = async () => {
      await deleteChat(session)
      dialog.close()
    }

    void dialog.show(() => (
      <Show
        when={settings.general.newLayoutDesigns()}
        fallback={
          <Dialog title={language.t("session.delete.title")} fit>
            <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
              <div class="flex flex-col gap-1">
                <span class="text-14-regular text-text-strong">
                  {language.t("session.delete.confirm", { name: name() })}
                </span>
              </div>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
                <Button variant="primary" size="large" onClick={handleDelete}>
                  {language.t("session.delete.button")}
                </Button>
              </div>
            </div>
          </Dialog>
        }
      >
        <DialogV2 fit>
          <DialogHeader hideClose>
            <DialogTitleGroup
              title={language.t("session.delete.title")}
              description={language.t("session.delete.confirm", { name: name() })}
            />
          </DialogHeader>
          <DialogFooter>
            <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 variant="danger" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </ButtonV2>
          </DialogFooter>
        </DialogV2>
      </Show>
    ))
  }

  return { renameChat, duplicateChat, exportChat, deleteChat, confirmDeleteChat }
}
