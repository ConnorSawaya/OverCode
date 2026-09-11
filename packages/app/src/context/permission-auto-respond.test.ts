import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  applyPermissionMode,
  autoRespondsPermission,
  cyclePermissionMode,
  isDirectoryAutoAccepting,
  resolvePermissionMode,
  sessionAutoAccept,
} from "./permission-auto-respond"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (sessionID: string) =>
  ({
    sessionID,
  }) as Pick<PermissionRequest, "sessionID">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const autoAccept = {
      other: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), "/tmp/project")).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
    expect(sessionAutoAccept(autoAccept, sessions, permission("root"), directory)).toBeUndefined()
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("parent false override takes precedence over directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("parent true override takes precedence over disabled directory fallback", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: false,
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})

describe("resolvePermissionMode", () => {
  test("reports ask when nothing auto-accepts", () => {
    expect(resolvePermissionMode({ directoryAuto: false, sessionAuto: false })).toBe("ask")
  })

  test("reports auto for session-level auto-accept", () => {
    expect(resolvePermissionMode({ directoryAuto: false, sessionAuto: true })).toBe("auto")
  })

  test("reports full for directory-level auto-accept", () => {
    expect(resolvePermissionMode({ directoryAuto: true, sessionAuto: false })).toBe("full")
    expect(resolvePermissionMode({ directoryAuto: true, sessionAuto: true })).toBe("full")
  })
})

describe("cyclePermissionMode", () => {
  test("cycles ask to auto to full and back to ask", () => {
    expect(cyclePermissionMode("ask")).toBe("auto")
    expect(cyclePermissionMode("auto")).toBe("full")
    expect(cyclePermissionMode("full")).toBe("ask")
  })
})

describe("applyPermissionMode", () => {
  const calls: string[] = []
  const api = {
    enableAutoAccept: (sessionID: string, directory: string) => {
      calls.push(`enable:${sessionID}:${directory}`)
    },
    disableAutoAccept: (sessionID: string, directory?: string) => {
      calls.push(`disable:${sessionID}:${directory ?? ""}`)
    },
    setDirectoryAutoAccept: (directory: string, value: boolean) => {
      calls.push(`directory:${directory}:${value}`)
    },
  }

  test("ask disables session and directory", () => {
    calls.length = 0
    applyPermissionMode(api, "/tmp/demo", "ses_1", "ask")
    expect(calls).toEqual(["disable:ses_1:/tmp/demo", "directory:/tmp/demo:false"])
  })

  test("auto enables the session when one exists", () => {
    calls.length = 0
    applyPermissionMode(api, "/tmp/demo", "ses_1", "auto")
    expect(calls).toEqual(["directory:/tmp/demo:false", "enable:ses_1:/tmp/demo"])
  })

  test("auto falls back to the directory for drafts", () => {
    calls.length = 0
    applyPermissionMode(api, "/tmp/demo", undefined, "auto")
    expect(calls).toEqual(["directory:/tmp/demo:true"])
  })

  test("full enables the directory", () => {
    calls.length = 0
    applyPermissionMode(api, "/tmp/demo", "ses_1", "full")
    expect(calls).toEqual(["directory:/tmp/demo:true"])
  })
})
