# Overcode cross-device sync strategy

Overcode synchronizes durable events incrementally. Each installation keeps a
stable device ID and a local monotonic journal revision. A trusted peer resumes
from its last revision; stable event IDs make retries idempotent.

## Merge rules

- Session messages, parts, tool output, and queued-prompt events use append and
  stable-ID semantics. Reconnecting does not create duplicate messages. The
  v2 prompt admission/delivery events are durable, so an admitted queue item
  remains visible and executable after the receiving installation restarts.
- Session metadata is represented by ordered durable events. When two devices
  edit metadata while offline, deterministic event arrival order is retained
  by the receiver; the event history remains available for inspection instead
  of silently rewriting a conversation.
- Project metadata uses the same durable event path. Filesystem locations are
  never merged from a remote machine. An unmapped project receives an isolated
  temporary placeholder until the user chooses a local folder.
- Deletions are durable events and remain in the append-only sync journal, so a
  device that was offline learns the tombstone and does not resurrect the
  deleted session when it reconnects.
- Portable profile fields (pins, project ordering, model preferences, language,
  and UI settings) use independent last-writer-wins clocks with
  `(updatedAt, deviceID)` as the deterministic tie-breaker. A model edit on one
  device therefore cannot overwrite an unrelated pin or language edit made
  offline on another device.
- Project sidebar visibility has its own per-project clocks. Closing a project
  writes a retained tombstone; reopening it writes `true` with a newer clock.
  This prevents an offline close from resurrecting during reconnect while also
  allowing an intentional reopen to win deterministically.

## Device-local data

API keys, OAuth tokens, relay credentials, OS keychain data, raw filesystem
paths, local project mappings, MCP command credentials, and native
computer-use consent remain on the device. A synchronized model preference can
therefore show a provider-credentials warning without copying a secret. The
Android client can use the PC's already-authorized APIs through Mobile Access,
but it cannot start native computer control or copy PC credentials to the phone.
