import { For, Show, createMemo } from "solid-js"
import { Icon as IconV2 } from "@overcode-ai/ui/v2/icon"
import { MenuV2 } from "@overcode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import type { MobileRemoteDevicesPlatform } from "@/context/platform"

export function HomeDeviceSwitcher(props: MobileRemoteDevicesPlatform) {
  const language = useLanguage()
  const current = createMemo(() => props.devices().find((device) => device.id === props.active()) ?? props.devices()[0])

  return (
    <div
      data-component="home-device-switcher"
      class="mx-auto flex w-full max-w-[1080px] items-center justify-between gap-3 border-b border-v2-border-border-base px-3 pb-3 pt-3 lg:px-6 lg:pt-6"
    >
      <div class="flex min-w-0 items-center gap-2">
        <div class="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-v2-background-bg-layer-01">
          <IconV2 name="monitor" size="small" class="text-v2-icon-icon-muted" />
        </div>
        <div class="min-w-0">
          <div class="text-[11px] leading-4 text-v2-text-text-faint">
            {language.t("settings.mobileAccess.devicesTitle")}
          </div>
          <div class="truncate text-[13px] text-v2-text-text-base [font-weight:530]">
            {current()?.name ?? language.t("mobile.pairing.title")}
          </div>
        </div>
      </div>

      <MenuV2 placement="bottom-end" gutter={6}>
        <MenuV2.Trigger
          class="flex h-8 min-w-0 max-w-[180px] items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed"
          aria-label={language.t("command.server.switch")}
        >
          <span class="min-w-0 truncate">{current()?.name ?? language.t("command.server.switch")}</span>
          <IconV2 name="chevron-down" size="small" class="shrink-0" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="min-w-[230px]">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("settings.mobileAccess.devicesTitle")}</MenuV2.GroupLabel>
              <For each={props.devices()}>
                {(device) => (
                  <MenuV2.Item onSelect={() => props.select(device.id)}>
                    <IconV2 name="monitor" size="small" />
                    <span class="min-w-0 flex-1 truncate">{device.name}</span>
                    <Show when={props.active() === device.id}>
                      <IconV2 name="check" size="small" class="shrink-0 text-v2-icon-icon-base" />
                    </Show>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={props.add}>
              <IconV2 name="plus" size="small" />
              <span>{language.t("mobile.pairing.connect")}</span>
            </MenuV2.Item>
            <Show when={props.devices().length > 1 && current()}>
              <MenuV2.Item
                class="text-v2-text-text-danger"
                onSelect={() => {
                  const id = props.active()
                  if (id) props.remove(id)
                }}
              >
                <IconV2 name="close" size="small" />
                <span>{language.t("settings.mobileAccess.removeDevice")}</span>
              </MenuV2.Item>
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}
