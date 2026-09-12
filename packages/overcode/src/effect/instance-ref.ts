import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~overcode/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~overcode/WorkspaceRef", {
  defaultValue: () => undefined,
})
