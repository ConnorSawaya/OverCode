import type { SkillV2Info } from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, createResource, createSignal, For, Show, type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createStore } from "solid-js/store"
import { SettingsToolAdd } from "./tools-add"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const mcpStatusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  disabled: "mcp.status.disabled",
} as const

type SkillSource = {
  value: string
  type: "path" | "url"
}

export const SettingsToolsV2: Component<{
  directory: Accessor<string | undefined>
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [filter, setFilter] = createSignal("")
  const [source, setSource] = createSignal("")
  const [mcpPending, setMcpPending] = createSignal<string>()
  const [state, setState] = createStore({ pending: false, error: "" })

  const [skills, { refetch: refetchSkills }] = createResource<SkillV2Info[], string | undefined>(
    () => props.directory(),
    async (directory) => {
      if (!directory) return []
      const response = await serverSdk().client.app.skills({ directory })
      return response.data ?? []
    },
  )

  const mcpItems = createMemo(() => {
    const directory = props.directory()
    if (!directory) return []
    const [store] = serverSync().child(directory, { mcp: true })
    return Object.entries(store.mcp ?? {})
      .map(([name, status]) => ({ name, status }))
      .filter((item) => `${item.name} ${item.status.status}`.toLowerCase().includes(filter().trim().toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const skillItems = createMemo(() => {
    const query = filter().trim().toLowerCase()
    return (skills.latest ?? [])
      .filter((skill) => {
        if (!query) return true
        return `${skill.name} ${skill.description ?? ""} ${skill.location}`.toLowerCase().includes(query)
      })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const configuredSources = createMemo<SkillSource[]>(() => {
    const config = serverSync().data.config.skills
    return [
      ...(config?.paths ?? []).map((value) => ({ value, type: "path" as const })),
      ...(config?.urls ?? []).map((value) => ({ value, type: "url" as const })),
    ]
  })

  const statusText = (status: string) => {
    const key = mcpStatusLabels[status as keyof typeof mcpStatusLabels]
    if (key) return language.t(key)
    return status.replaceAll("_", " ")
  }

  const skillOrigin = (location: string) => {
    if (location === "<built-in>") return language.t("settings.tools.skill.builtIn")
    if (location.includes(".agents") || location.includes(".claude")) return language.t("settings.tools.skill.external")
    if (location.includes(".opencode")) return language.t("settings.tools.skill.project")
    return language.t("settings.tools.skill.local")
  }

  const toggleMcp = async (name: string) => {
    const directory = props.directory()
    if (!directory || mcpPending()) return
    setMcpPending(name)
    try {
      await serverSync().mcp.toggle(directory, name)
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setMcpPending(undefined)
    }
  }

  const refresh = async () => {
    const directory = props.directory()
    if (directory) {
      const response = await serverSdk().client.mcp.status({ directory })
      const [, set] = serverSync().child(directory)
      set("mcp", response.data ?? {})
    }
    await refetchSkills()
  }

  const removeSource = async (item: SkillSource) => {
    if (state.pending) return
    setState({ pending: true, error: "" })
    try {
      const current = serverSync().data.config.skills ?? {}
      const key = item.type === "url" ? "urls" : "paths"
      await serverSync().updateConfig({ skills: { ...current, [key]: (current[key] ?? []).filter((value) => value !== item.value) } })
      await refetchSkills()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("pending", false)
    }
  }

  const addSource = async () => {
    const value = source().trim()
    if (!value || state.pending || !props.directory()) return

    const current = serverSync().data.config.skills ?? {}
    const type = /^https?:\/\//i.test(value) ? "urls" : "paths"
    const values = current[type] ?? []
    const previousLocations = new Set((skills.latest ?? []).map((skill) => skill.location))

    setState({ pending: true, error: "" })
    try {
      await serverSync().updateConfig({
        skills: { ...current, [type]: values.includes(value) ? values : [...values, value] },
      })
      const discovered = await refetchSkills()
      if (!discovered?.length || (!values.includes(value) && !discovered.some((skill) => !previousLocations.has(skill.location)))) throw new Error(language.t("settings.tools.sourceNotFound"))
      setSource("")
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.tools.sources.added"),
        description: language.t("settings.tools.sources.addedDescription", { source: value }),
      })
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setState("pending", false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked settings-v2-tools-header">
        <div class="settings-v2-tab-header-row">
          <div class="settings-v2-tools-title-copy">
            <h2 class="settings-v2-tab-title">{language.t("settings.tools.title")}</h2>
            <p class="settings-v2-tab-description">{language.t("settings.tools.description")}</p>
          </div>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="reset" size="small" />}
            aria-label={language.t("settings.tools.refresh")}
            disabled={state.pending || skills.loading}
            onClick={() => void refresh().catch((error) => setState("error", String(error)))}
          />
        </div>
        <Show when={props.directory()}>
          <div class="settings-v2-tab-search">
            <TextInputV2
              type="search"
              appearance="base"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
              placeholder={language.t("settings.tools.searchAll")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.tools.searchAll")}
            />
          </div>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-v2-tools">
        <Show when={state.error}><p role="alert" class="settings-v2-tools-error">{state.error}</p></Show>
        <SettingsToolAdd directory={props.directory} onAdded={refresh} onSkill={(url) => setSource(url)} />
        <Show
          when={props.directory()}
          fallback={<div class="settings-v2-tools-context">{language.t("settings.tools.projectRequired")}</div>}
        >
          <div class="settings-v2-section">
            <div class="settings-v2-tools-section-header">
              <div>
                <h3 class="settings-v2-section-title">{language.t("settings.tools.mcp.title")}</h3>
                <p class="settings-v2-tools-section-description">{language.t("settings.tools.mcp.description")}</p>
              </div>
              <span class="settings-v2-tools-count">{mcpItems().length}</span>
            </div>
            <SettingsListV2>
              <Show
                when={mcpItems().length > 0}
                fallback={<div class="settings-v2-tool-empty">{language.t("settings.tools.mcp.empty")}</div>}
              >
                <For each={mcpItems()}>
                  {(item) => {
                    const status = () => item.status?.status ?? "failed"
                    const error = () => {
                      const current = item.status
                      return current && "error" in current ? current.error : undefined
                    }
                    return (
                      <div class="settings-v2-tool-row">
                        <div class="settings-v2-tool-lead">
                          <span class="settings-v2-tool-icon" data-status={status()}>
                            <Icon name="mcp" size="small" />
                          </span>
                          <div class="settings-v2-tool-copy">
                            <div class="settings-v2-tool-name-row">
                              <span class="settings-v2-tool-name">{item.name}</span>
                              <span class="settings-v2-tool-status" data-status={status()}>
                                <span class="settings-v2-tool-status-dot" />
                                {statusText(status())}
                              </span>
                            </div>
                            <Show when={error()}>
                              <span class="settings-v2-tool-meta">{error()}</span>
                            </Show>
                          </div>
                        </div>
                        <Show when={status() === "needs_auth" || status() === "failed"} fallback={<Switch
                          checked={status() === "connected"}
                          disabled={status() === "pending" || mcpPending() === item.name}
                          hideLabel
                          aria-label={`${item.name} ${statusText(status())}`}
                          onChange={() => void toggleMcp(item.name)}
                        />}>
                          <ButtonV2 size="small" variant="neutral" disabled={mcpPending() === item.name} onClick={() => void toggleMcp(item.name)}>
                            {language.t(status() === "needs_auth" ? "settings.tools.signIn" : "settings.tools.retry")}
                          </ButtonV2>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <div class="settings-v2-tools-section-header">
              <div>
                <h3 class="settings-v2-section-title">{language.t("settings.tools.skills.title")}</h3>
                <p class="settings-v2-tools-section-description">
                  {language.t("settings.tools.skills.description")}
                </p>
              </div>
              <span class="settings-v2-tools-count">{skillItems().length}</span>
            </div>
            <SettingsListV2>
              <Show
                when={!skills.loading}
                fallback={<div class="settings-v2-tool-empty">{language.t("settings.tools.skills.loading")}</div>}
              >
                <Show
                  when={!skills.error && skillItems().length > 0}
                  fallback={
                    <div class="settings-v2-tool-empty">
                      {skills.error ? language.t("settings.tools.skills.error") : language.t("settings.tools.skills.empty")}
                    </div>
                  }
                >
                  <For each={skillItems()}>
                    {(skill) => (
                      <div class="settings-v2-tool-row settings-v2-skill-row">
                        <div class="settings-v2-tool-lead">
                          <span class="settings-v2-tool-icon settings-v2-tool-icon--skill">
                            <Icon name="brain" size="small" />
                          </span>
                          <div class="settings-v2-tool-copy">
                            <div class="settings-v2-tool-name-row">
                              <span class="settings-v2-tool-name">{skill.name}</span>
                              <span class="settings-v2-tool-origin">{skillOrigin(skill.location)}</span>
                            </div>
                            <Show when={skill.description}>
                              <span class="settings-v2-tool-meta settings-v2-skill-description">
                                {skill.description}
                              </span>
                            </Show>
                            <span class="settings-v2-tool-path" title={skill.location}>
                              {skill.location}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </SettingsListV2>
          </div>
        </Show>

        <div class="settings-v2-tools-callout">
          <span class="settings-v2-tools-callout-icon">
            <Icon name="brain" size="small" />
          </span>
          <div>
            <h3 class="settings-v2-tools-callout-title">{language.t("settings.tools.assistant.title")}</h3>
            <p class="settings-v2-tools-callout-description">
              {language.t("settings.tools.assistant.description")}
            </p>
          </div>
        </div>

        <div class="settings-v2-section">
          <div class="settings-v2-tools-section-header">
            <div>
              <h3 class="settings-v2-section-title">{language.t("settings.tools.sources.title")}</h3>
              <p class="settings-v2-tools-section-description">{language.t("settings.tools.sources.help")}</p>
            </div>
          </div>
          <div class="settings-v2-tools-source-form">
            <TextInputV2
              data-component="skill-source-input"
              value={source()}
              onInput={(event) => setSource(event.currentTarget.value)}
              placeholder={language.t("settings.tools.sources.input")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.tools.sources.input")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addSource()
              }}
            />
            <Show when={platform.platform === "desktop"}>
              <ButtonV2 size="normal" variant="ghost" disabled={state.pending} onClick={async () => {
                if (platform.platform !== "desktop") return
                const picked = await platform.openDirectoryPickerDialog()
                const path = Array.isArray(picked) ? picked[0] : picked
                if (path) setSource(path)
              }}>{language.t("settings.tools.browseFolder")}</ButtonV2>
            </Show>
            <ButtonV2 size="normal" variant="neutral" icon="plus" disabled={!source().trim() || state.pending || !props.directory()} onClick={() => void addSource()}>
              {language.t(state.pending ? "settings.tools.installing" : "settings.tools.sources.add")}
            </ButtonV2>
          </div>
          <Show
            when={configuredSources().length > 0}
            fallback={<div class="settings-v2-tool-empty settings-v2-tool-empty--sources">{language.t("settings.tools.sources.empty")}</div>}
          >
            <SettingsListV2>
              <For each={configuredSources()}>
                {(item) => (
                  <div class="settings-v2-tool-row">
                    <div class="settings-v2-tool-lead">
                      <span class="settings-v2-tool-icon settings-v2-tool-icon--source">
                        <Icon name={item.type === "url" ? "link" : "folder"} size="small" />
                      </span>
                      <div class="settings-v2-tool-copy">
                        <span class="settings-v2-tool-name">{item.value}</span>
                        <span class="settings-v2-tool-meta">
                          {item.type === "url" ? language.t("settings.tools.sources.url") : language.t("settings.tools.sources.path")}
                        </span>
                      </div>
                    </div>
                    <ButtonV2 size="small" variant="ghost" disabled={state.pending} onClick={() => void removeSource(item)}>{language.t("settings.tools.removeSource")}</ButtonV2>
                  </div>
                )}
              </For>
            </SettingsListV2>
          </Show>
        </div>
      </div>
    </>
  )
}
