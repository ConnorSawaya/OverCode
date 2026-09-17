import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { forwardInitializationFailure } from "./initialization"
import { sidecarVersion } from "./sidecar-version"

describe("desktop initialization", () => {
  const failure = new Error("sidecar startup failed")
  const expectFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toBe(failure)
  }

  test("forwards loading task failures before renderer initialization", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Deferred.await(initialization).pipe(Effect.exit)
      }),
    )

    expectFailure(exit)
  })

  test("forwards loading task failures while renderer initialization waits", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const waiting = yield* Deferred.await(initialization).pipe(Effect.exit, Effect.forkChild)
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Fiber.join(waiting)
      }),
    )

    expectFailure(exit)
  })

  test("defaults to the shared V2 CLI daemon", () => {
    expect(sidecarVersion({} as NodeJS.ProcessEnv)).toBe("v2")
    expect(sidecarVersion({ OVERCODE_SIDECAR_V2: "1" } as NodeJS.ProcessEnv)).toBe("v2")
  })

  test("preserves a V1 rollback", () => {
    expect(sidecarVersion({ OVERCODE_SIDECAR_V2: "0" } as NodeJS.ProcessEnv)).toBe("v1")
    expect(sidecarVersion({ OVERCODE_SIDECAR_V2: "false" } as NodeJS.ProcessEnv)).toBe("v1")
  })
})
