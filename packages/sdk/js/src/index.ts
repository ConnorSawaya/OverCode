export * from "./client.js"
export * from "./server.js"

import { createOpencodeClient } from "./client.js"
import { createOpencodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

/**
 * @deprecated Use {@link createOvercode} instead. Kept for backwards compatibility.
 */
export async function createOpencode(options?: ServerOptions) {
  const server = await createOpencodeServer({
    ...options,
  })

  const client = createOpencodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

/** Overcode-branded alias for {@link createOpencode}. */
export const createOvercode = createOpencode
