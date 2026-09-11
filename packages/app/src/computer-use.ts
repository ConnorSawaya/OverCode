export type ComputerUseState = {
  available: boolean
  phase: "idle" | "starting" | "active" | "stopping" | "error"
  color: string
  sessionID?: string
  grantID?: string
  reason?: string
}

export type ComputerUsePlatform = {
  state: () => Promise<ComputerUseState>
  start: (sessionID: string, serverUrl: string, directory?: string) => Promise<ComputerUseState>
  stop: (sessionID?: string) => Promise<ComputerUseState>
  setColor: (color: string) => Promise<ComputerUseState>
  onState: (listener: (state: ComputerUseState) => void) => () => void
}
