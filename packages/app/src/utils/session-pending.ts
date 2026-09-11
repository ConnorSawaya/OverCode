export type SessionPendingFile = {
  uri: string
  mime?: string
  name?: string
  description?: string
  mention?: { start: number; end: number; text: string }
}

export type SessionPendingAgent = {
  name: string
  mention?: { start: number; end: number; text: string }
}

export type SessionPendingPrompt = {
  id: string
  sessionID: string
  sequence: number
  timeCreated: number
  status: "queued"
  type: "user" | "synthetic" | "compaction"
  delivery: "steer" | "queue"
  text: string
  files: SessionPendingFile[]
  agents: SessionPendingAgent[]
  metadata?: Record<string, unknown>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const string = (value: unknown) => (typeof value === "string" ? value : undefined)
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

const mention = (value: unknown) => {
  const source = record(value)
  if (!source) return
  const nested = record(source.text)
  const start = number(nested?.start ?? source.start)
  const end = number(nested?.end ?? source.end)
  const text = string(nested?.value ?? nested?.text ?? source.text)
  if (start === undefined || end === undefined || text === undefined) return
  return { start, end, text }
}

const normalizeFiles = (value: unknown): SessionPendingFile[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    if (!item) return []
    const uri = string(item.uri ?? item.url)
    if (!uri) return []
    return [
      {
        uri,
        mime: string(item.mime),
        name: string(item.name ?? item.filename),
        description: string(item.description),
        mention: mention(item.mention ?? item.source),
      },
    ]
  })
}

const normalizeAgents = (value: unknown): SessionPendingAgent[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const name = string(item?.name)
    if (!name) return []
    return [{ name, mention: mention(item?.mention ?? item?.source) }]
  })
}

const normalizeLegacy = (item: Record<string, unknown>): SessionPendingPrompt | undefined => {
  const input = record(item.input)
  if (!input || !Array.isArray(input.parts)) return
  const id = string(item.id)
  const sessionID = string(item.sessionID ?? input.sessionID)
  if (!id || !sessionID) return

  const parts = input.parts.flatMap((part) => (record(part) ? [record(part)!] : []))
  const text = parts.flatMap((part) => (part.type === "text" ? [string(part.text) ?? ""] : [])).join("\n")
  const files = normalizeFiles(parts.filter((part) => part.type === "file"))
  const agents = normalizeAgents(parts.filter((part) => part.type === "agent"))

  return {
    id,
    sessionID,
    sequence: number(item.sequence) ?? 0,
    timeCreated: number(item.timeCreated) ?? 0,
    status: "queued",
    type: "user",
    delivery: input.delivery === "steer" ? "steer" : "queue",
    text,
    files,
    agents,
    metadata: record(input.metadata),
  }
}

const normalizeCurrent = (item: Record<string, unknown>): SessionPendingPrompt | undefined => {
  const id = string(item.id)
  const sessionID = string(item.sessionID)
  if (!id || !sessionID) return
  const type = item.type === "synthetic" || item.type === "compaction" ? item.type : "user"
  const prompt = record(item.prompt ?? item.data) ?? {}
  return {
    id,
    sessionID,
    sequence: number(item.admittedSeq ?? item.sequence) ?? 0,
    timeCreated: number(item.timeCreated) ?? 0,
    status: "queued",
    type,
    delivery: item.delivery === "steer" ? "steer" : "queue",
    text: string(prompt.text) ?? "",
    files: normalizeFiles(prompt.files),
    agents: normalizeAgents(prompt.agents),
    metadata: record(prompt.metadata),
  }
}

export function normalizeSessionPendingList(value: unknown): SessionPendingPrompt[] {
  const envelope = record(value)
  const source = Array.isArray(value) ? value : Array.isArray(envelope?.data) ? envelope.data : []
  return source
    .flatMap((entry) => {
      const item = record(entry)
      if (!item) return []
      const normalized = item.input ? normalizeLegacy(item) : normalizeCurrent(item)
      return normalized ? [normalized] : []
    })
    .filter((item) => item.delivery === "queue")
    .sort((a, b) => a.sequence - b.sequence || a.timeCreated - b.timeCreated || a.id.localeCompare(b.id))
}
