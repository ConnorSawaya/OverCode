export type ComputerStatus = {
  available: boolean
  ownerSessionId?: string
  controller: "off" | "user" | "agent"
  busy: boolean
  action?: string
  runId?: string
  updatedAt: number
}

export type ComputerFrame = {
  id: string
  data: string
  mime: "image/jpeg"
  width: number
  height: number
  display: number
  displays: number
  capturedAt: number
  cursor: { x: number; y: number }
}

export type ComputerAction = {
  sessionID: string
  runID?: string
  action: "screenshot" | "move" | "click" | "doubleClick" | "drag" | "scroll" | "type" | "press"
  frameId?: string
  x?: number
  y?: number
  endX?: number
  endY?: number
  button?: "left" | "right" | "middle"
  text?: string
  key?: string
  direction?: "up" | "down" | "left" | "right"
  amount?: number
  display?: number
}

export type ComputerPlatform = {
  status: () => Promise<ComputerStatus>
  control: (sessionID: string, controller: ComputerStatus["controller"]) => Promise<ComputerStatus>
  frame: (sessionID: string, display?: number) => Promise<ComputerFrame>
  onEvent: (cb: (status: ComputerStatus) => void) => () => void
}
