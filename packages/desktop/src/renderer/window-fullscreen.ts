import { createSignal } from "solid-js"

const [windowFullscreen, setWindowFullscreen] = createSignal(false)
const [windowMaximized, setWindowMaximized] = createSignal(false)

window.api.onWindowFullscreenChanged(setWindowFullscreen)
void window.api.getWindowFullscreen().then(setWindowFullscreen)
window.api.onWindowMaximizedChanged(setWindowMaximized)
void window.api.getWindowMaximized().then(setWindowMaximized)

export { windowFullscreen, windowMaximized }
