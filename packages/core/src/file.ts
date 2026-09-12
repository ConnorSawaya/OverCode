export * as File from "./file"

import { Revert } from "@opencode-ai/schema/revert"

/**
 * Marker MIME used for local files that should be inspected by the agent's
 * tools instead of being sent as provider media. It is intentionally not a
 * real document MIME type.
 */
export const LOCAL_FILE_REFERENCE_MIME = "application/x-overcode-file-reference"

export const Diff = Revert.FileDiff
export type Diff = typeof Diff.Type
