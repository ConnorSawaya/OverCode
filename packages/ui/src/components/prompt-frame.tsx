import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import "./prompt-frame.css"

export function PromptFrame(props: { enabled: boolean; working: boolean; agent?: string; dragging?: boolean }) {
  let frame!: HTMLDivElement
  const [visibility, setVisibility] = createStore({ onscreen: false, foreground: true })

  onMount(() => {
    const parent = frame.parentElement!
    const radius = () => frame.style.setProperty("--prompt-frame-radius", getComputedStyle(parent).borderTopLeftRadius)
    const resize = new ResizeObserver(radius)
    resize.observe(parent)
    radius()
    const observer = new IntersectionObserver(([entry]) => setVisibility("onscreen", entry.isIntersecting))
    observer.observe(parent)
    const foreground = () => setVisibility("foreground", document.visibilityState === "visible")
    document.addEventListener("visibilitychange", foreground)
    foreground()
    onCleanup(() => {
      resize.disconnect()
      observer.disconnect()
      document.removeEventListener("visibilitychange", foreground)
    })
  })

  return (
    <div
      ref={frame}
      data-component="prompt-frame"
      data-agent={props.agent?.toLowerCase()}
      data-working={props.working ? "true" : "false"}
      data-animate={
        props.enabled && props.working && !props.dragging && visibility.onscreen && visibility.foreground
          ? "true"
          : "false"
      }
      hidden={!props.enabled || props.dragging}
      aria-hidden="true"
    >
    </div>
  )
}
