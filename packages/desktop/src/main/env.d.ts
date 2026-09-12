interface ImportMetaEnv {
  readonly OVERCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:overcode-server" {
  export namespace Server {
    export const listen: typeof import("../../../overcode/dist/types/src/node").Server.listen
    export type Listener = import("../../../overcode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../overcode/dist/types/src/node").Config.get
    export type Info = import("../../../overcode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../overcode/dist/types/src/node").bootstrap
}
