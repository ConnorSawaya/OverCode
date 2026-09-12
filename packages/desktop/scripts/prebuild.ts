#!/usr/bin/env bun
import { $ } from "bun"

import { buildComputerUse } from "./build-computer-use"
import { downloadCliToResources, resolveChannel } from "./utils"

await buildComputerUse()
const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../overcode && bun script/build-node.ts`
if (channel === "dev") await downloadCliToResources()
