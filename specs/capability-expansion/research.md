# Overcode Capability Expansion — Research & Integration Record

Goal: native Overcode skills / tool discovery / workflows / MCP-first UX /
agent testing, learned from public-domain sources, integrated (not bolted on).

License rule for this pass: copy source ONLY from CC0 / Unlicense / MIT-0 /
0BSD / explicit public-domain dedications. Everything else (MIT, Apache,
GPL, unclear) is architecture/behavior inspiration only, reimplemented.

## What Overcode already has (do NOT duplicate)

- SKILL.md skills, dual loader (core V2 `packages/core/src/skill*.ts`,
  legacy V1 `packages/opencode/src/skill/`), discovery via URL index.json,
  guidance injection, `skill()` tool, permission filtering.
- MCP clients (local stdio + remote, OAuth), tool/prompt/resource merging,
  status + watch (no auto-reconnect), HTTP API + CLI + UI surfaces.
- Commands (markdown + MCP prompts + skills), slash invocation, subtask/agent
  overrides, `command.execute.before` hook.
- Hooks (V1 `Hooks` map incl. tool.execute.before/after; V2 Effect
  registration + EventV2 bridge), plugins (V1 code hooks, V2 draft
  transforms), durable session todos, SQLite session persistence.
- Agent behavior tests under `packages/core/test` + `packages/opencode/test`
  (tools, sessions, MCP lifecycle, httpapi exercise).

## Sources investigated

### 1. nakane1chome/claude-skills — Unlicense ✅ safe-source
Concepts taken:
- Two-tier session record (committable summary vs gitignored ops log) →
  session journal design (deferred; todos + GlobalBus events cover part).
- Plan-vs-actual auditing (plan table vs `git diff --name-only`) →
  `skill-eval` "deviation" check idea (recorded, not built).
- Skill testing as characterization (`require/expect/achieve`, Ability%) →
  ADAPTED as deterministic skill activation evals (no LLM needed).
- Agent/developer ownership matrix → skill authoring template sections.
NOT taken: Docker YOLO sandbox, Claude-only hooks paths, live-model E2E
harness (flaky/heavy), document-curation prose.

### 2. goodbarber/goodbarber-skills — Unlicense ✅ safe-source
Mechanisms taken:
- Discovery frontmatter line ("prefer this skill over raw tools…") →
  skill frontmatter guidance for Overcode authoring template.
- Input/Computation/Output contracts + guardrails block (read-only,
  confirm-before-mutate) → skill authoring template + validator.
- Chaining ("next actions") + namespaced families → skill index categories.
NOT taken: all domain content, thresholds, vendor endpoints/OAuth,
marketplace manifests.

### 3. pipeabellos/thetoolforthat — CC0 ✅ safe-source
Taken:
- 4-verb discovery API (search / list-categories / get-by-category /
  recommend) + intent routing → Overcode tool-discovery tool shape.
- Lazy rules files + taxonomy/keyword bridge → skill index design.
NOT taken: catalog rows (stale/affiliate), keyword-match ranking
implementation (interface only), `npx` wrapper (no source).

### 4. heroku/mcp-code-exec-python — CC0 ✅ safe-source
Taken:
- `{returncode, stdout, stderr}` envelope, install-vs-exec error prefix,
  hard timeout, transport split, Bearer/x-api-key shape, E2E harness
  pattern (list → call → unwrap → assert) → sandbox exec tool + its tests.
NOT taken: Heroku specifics, venv-per-call verbatim, unpinned global pip
install, sandboxing claims (repo disclaims isolation; so do we).

### 5. jeanibarz/orchestrator-mcp-server — Unlicense ✅ safe-source
Taken:
- SQLite instances + append-only history, advance/resume loop with
  fail-closed terminal states, report payload shape, deterministic stub
  seam for tests → durable Overcode workflows (Effect service + tools).
NOT taken: Gemini-only client, lossy context array, list-order "planning",
deprecated datetime, stderr-print error paths.

### 6. wertzui/AutoMCP — Unlicense ✅ safe-source
Taken (concepts only, .NET types left behind):
- One-tool-per-endpoint discovery, description/schema from signatures,
  wrapper unwrapping, structured error envelope.
- Applied narrowly: workflow + discovery tools get generated JSON Schemas
  from TS definitions; NOT a general API→MCP generator (recorded below).

### 7. awesome-opencode/awesome-opencode — CC0 list only ⚠️ links NOT CC0
Checked 10 high-value linked repos: 7× MIT, 1× Apache-2.0, 1× custom dual,
1× AGPL-3.0 — ALL inspiration-only, no source copied. Ideas recorded:
beads (task memory), vibe-kanban/opencode-kanban (parallel-agent UI),
OpenSpec (spec loop), eval-harness (regression gates), agenttrace
(trace TUI), supamem (memory MCP), agent-harness (asset CLI), OpenWork
(desktop workflow ref), CodeWalk (protocol ref, AGPL — observe only).

## What was integrated (this pass)

1. **Overcode skill kit** — authoring template (`skill-author` skill content),
   frontmatter contract validator, category/keyword index feeding guidance,
   deterministic activation evals. Files: `packages/opencode/src/skill/*`.
2. **Tool discovery tool** — `tools {search,list-categories,describe}`
   over MCP + bundled tools. Files: `packages/opencode/src/tool/discovery*`.
3. **Sandbox exec tool** — tempdir Bun/Node execution, timeouts, envelope
   errors. Files: `packages/opencode/src/tool/sandbox*`.
4. **Durable workflows** — SQLite instances + history, start/advance/resume/
   status, agent-facing tool, stub-seam tests.
   Files: `packages/core/src/workflow/*` + migration, `packages/opencode/src/tool/workflow*`.

## Remaining ideas worth revisiting

- Session journal (two-tier record) + plan-vs-actual deviation check.
- General API→MCP generator (AutoMCP-for-TS); needs routing/auth design.
- MCP auto-reconnect + per-server context budgets in UI.
- Live-model skill evals (nightly, not CI).
- Parallel-agent kanban UI (vibe-kanban-inspired, original implementation).
