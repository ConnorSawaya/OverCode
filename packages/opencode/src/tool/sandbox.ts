// Overcode sandbox execution: run generated code in a fresh empty temp dir
// with a hard timeout, returning a {returncode, stdout, stderr} envelope.
//
// Honest limits (same as the heroku/mcp-code-exec design this adapts): this
// is process-level containment — empty working directory, no shell, killed
// on timeout — NOT a security boundary. No filesystem or network isolation.
// Never run hostile code here.

import os from "os";
import path from "path";
import fs from "fs/promises";
import { Effect, Schema } from "effect";
import * as Tool from "./tool";
import DESCRIPTION from "./sandbox.txt";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const Parameters = Schema.Struct({
  command: Schema.Array(Schema.String).annotate({ description: "Executable + args, no shell (e.g. [\"bun\", \"run\", \"main.ts\"])" }),
  files: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional files to write into the empty workdir before running ({relativePath: content})",
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({ description: "Kill after this long (default 10000, max 60000)" }),
});

export type SandboxResult = {
  returncode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  workdir: string;
};

export function truncateOutput(value: string): string {
  if (Buffer.byteLength(value) <= MAX_OUTPUT_BYTES) return value;
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated at 64 KiB]`;
}

export function runSandboxed(input: {
  command: ReadonlyArray<string>;
  files?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SandboxResult> {
  return Effect.gen(function* () {
    if (input.command.length === 0) {
      return { returncode: 2, stdout: "", stderr: "sandbox: empty command", timedOut: false, workdir: "" };
    }
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    const workdir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "overcode-sandbox-")));
    try {
      for (const [name, content] of Object.entries(input.files ?? {})) {
        const target = path.resolve(workdir, name);
        if (!target.startsWith(workdir)) return { returncode: 2, stdout: "", stderr: `sandbox: refusing path escape: ${name}`, timedOut: false, workdir };
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }));
        yield* Effect.promise(() => fs.writeFile(target, content));
      }
      const argv = [...input.command];
      const proc = Bun.spawn(argv, {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
        signal: input.signal,
        timeout: timeoutMs,
      });
      const started = Date.now();
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      );
      const elapsed = Date.now() - started;
      // Timeout kills surface as SIGTERM/SIGKILL exit codes (143/137), null,
      // or 124 depending on platform — elapsed time is the robust signal.
      const timedOut = code !== 0 && elapsed >= timeoutMs;
      return {
        returncode: code ?? 124,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut,
        workdir,
      };
    } finally {
      yield* Effect.promise(() => fs.rm(workdir, { recursive: true, force: true })).pipe(Effect.ignore);
    }
  }).pipe(Effect.runPromise);
}

export const SandboxTool = Tool.define(
  "sandbox",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "sandbox",
          patterns: [],
          always: [],
          metadata: {},
        });
        const result = yield* Effect.promise(() =>
          runSandboxed({ command: params.command, files: params.files, timeoutMs: params.timeoutMs, signal: ctx.abort }),
        );
        const lines = [
          `returncode: ${result.returncode}${result.timedOut ? " (timed out)" : ""}`,
          "",
          "stdout:",
          result.stdout || "(empty)",
          "",
          "stderr:",
          result.stderr || "(empty)",
        ];
        return { title: `Sandbox exit ${result.returncode}`, output: lines.join("\n"), metadata: {} };
      }).pipe(Effect.orDie),
  }),
);
