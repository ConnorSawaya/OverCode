import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, path } from "@opencode-ai/core/effect/app-node-platform"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

const skillConcurrency = 4
const fileConcurrency = 8

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

const GithubTree = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String, mode: Schema.String, size: Schema.optional(Schema.Number) })),
})

export function githubSkillSource(value: string) {
  const url = new URL(value)
  if (url.hostname !== "github.com") return undefined
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+?)\/?$/)
  if (!match) throw new Error("Choose a GitHub skill folder, for example /owner/repo/tree/main/skills/name")
  const [, owner, repo, ref, raw] = match
  const folder = raw.replace(/\/SKILL\.md$/, "")
  if (![owner, repo, ref, ...folder.split("/")].every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) {
    throw new Error("Unsupported GitHub skill path")
  }
  return { owner, repo, ref, folder }
}

export function safeSkillPath(value: string) {
  return value.length > 0 && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !/[\\:\x00-\x1f]/.test(part))
}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@overcode/SkillDiscovery") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | Path.Path | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const path = yield* Path.Path
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((res) => res.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((err) => Effect.logError("failed to download", { url: url, error: err }).pipe(Effect.as(false))),
      )
    })

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const github = githubSkillSource(url)
      if (github) {
        const tree = yield* HttpClientRequest.get(`https://api.github.com/repos/${github.owner}/${github.repo}/git/trees/${github.ref}?recursive=1`).pipe(
          HttpClientRequest.setHeader("User-Agent", "Overcode"),
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GithubTree)),
          Effect.orDie,
        )
        if (tree.truncated) return yield* Effect.die("Repository is too large; add a local skills folder instead")
        const files = tree.tree.filter((item) => item.type === "blob" && item.path.startsWith(`${github.folder}/`))
        if (!files.some((item) => item.path === `${github.folder}/SKILL.md`)) return yield* Effect.die("The selected folder has no SKILL.md")
        if (files.length > 256 || files.reduce((sum, item) => sum + (item.size ?? 0), 0) > 20_000_000) return yield* Effect.die("Skill exceeds the download limit; add a local folder instead")
        if (files.some((item) => !safeSkillPath(item.path) || item.mode === "120000")) return yield* Effect.die("Skill contains unsupported file paths or symbolic links")
        const root = path.join(cache, "github", github.owner, github.repo, tree.sha, github.folder)
        // Fetch support files first. SKILL.md is the install-complete marker.
        for (const item of files.toSorted((a, b) => Number(a.path.endsWith("/SKILL.md")) - Number(b.path.endsWith("/SKILL.md")))) {
          const ok = yield* download(
            `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${tree.sha}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
            path.join(root, item.path.slice(github.folder.length + 1)),
          )
          if (!ok) return yield* Effect.die("Skill download failed; retry the source")
        }
        return [root]
      }
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href
      const host = base.slice(0, -1)

      yield* Effect.logInfo("fetching index", { url: index })

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.catch((err) =>
          Effect.logError("failed to fetch index", { url: index, error: err }).pipe(Effect.as(null)),
        ),
      )

      if (!data) return []

      const missing = data.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      yield* Effect.forEach(
        missing,
        (skill) => Effect.logWarning("skill entry missing SKILL.md", { url: index, skill: skill.name }),
        { discard: true },
      )
      const list = data.skills.filter((skill) => safeSkillPath(skill.name) && skill.files.includes("SKILL.md") && skill.files.every(safeSkillPath))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            const root = path.join(cache, skill.name)
            const versionFile = path.join(root, ".overcode-version")
            const version = skill.version
            const current =
              version === undefined
                ? undefined
                : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))

            if (version === undefined || current === version) {
              yield* Effect.forEach(
                skill.files,
                (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(root, file)),
                { concurrency: fileConcurrency, discard: true },
              )
            } else {
              const token = crypto.randomUUID()
              const staging = `${root}.tmp-${token}`
              const backup = `${root}.old-${token}`
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  skill.files,
                  (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(staging, file)),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean)) return
                if (!(yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie))) return
                yield* fs.writeFileString(path.join(staging, ".overcode-version"), version)
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const cached = yield* fs.exists(root).pipe(Effect.orDie)
                    if (cached) yield* fs.rename(root, backup)
                    yield* fs.rename(staging, root).pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                          return yield* Effect.fail(error)
                        }),
                      ),
                    )
                    if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                  }),
                )
              }).pipe(
                Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: skill.name, error })),
                Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
              )
            }
            return (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ? root : null
          }),
        { concurrency: skillConcurrency },
      )

      return dirs.filter((dir): dir is string => dir !== null)
    })

    return Service.of({ pull })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, path, httpClient] })

export * as Discovery from "./discovery"
