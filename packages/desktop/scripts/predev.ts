import { $ } from "bun"
import { buildComputerUse } from "./build-computer-use"
import { downloadCliToResources } from "./utils"

await buildComputerUse()
await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`
await downloadCliToResources()
