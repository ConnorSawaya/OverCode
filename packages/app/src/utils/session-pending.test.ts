import { describe, expect, test } from "bun:test"
import { normalizeSessionPendingList } from "./session-pending"

describe("normalizeSessionPendingList", () => {
  test("normalizes and orders durable V1 queue rows", () => {
    expect(
      normalizeSessionPendingList([
        {
          id: "msg_2",
          sessionID: "ses_a",
          sequence: 2,
          status: "queued",
          timeCreated: 20,
          input: {
            sessionID: "ses_a",
            delivery: "queue",
            parts: [{ type: "text", text: "second" }],
          },
        },
        {
          id: "msg_1",
          sessionID: "ses_a",
          sequence: 1,
          status: "queued",
          timeCreated: 10,
          input: {
            sessionID: "ses_a",
            delivery: "queue",
            parts: [
              { type: "text", text: "first" },
              {
                type: "file",
                url: "file:///repo/a.ts",
                mime: "text/plain",
                filename: "a.ts",
                source: { text: { start: 0, end: 5, value: "@a.ts" } },
              },
            ],
          },
        },
      ]),
    ).toMatchObject([
      { id: "msg_1", sequence: 1, text: "first", files: [{ name: "a.ts", uri: "file:///repo/a.ts" }] },
      { id: "msg_2", sequence: 2, text: "second" },
    ])
  })

  test("normalizes the current admitted-prompt envelope", () => {
    expect(
      normalizeSessionPendingList({
        data: [
          {
            admittedSeq: 7,
            id: "msg_7",
            sessionID: "ses_b",
            timeCreated: 30,
            delivery: "queue",
            prompt: {
              text: "queued",
              files: [{ uri: "data:text/plain;base64,QQ==", mime: "text/plain", name: "a.txt" }],
            },
          },
        ],
      }),
    ).toEqual([
      {
        id: "msg_7",
        sessionID: "ses_b",
        sequence: 7,
        timeCreated: 30,
        status: "queued",
        type: "user",
        delivery: "queue",
        text: "queued",
        files: [{ uri: "data:text/plain;base64,QQ==", mime: "text/plain", name: "a.txt" }],
        agents: [],
        metadata: undefined,
      },
    ])
  })

  test("does not show steer inputs in the queued prompt dock", () => {
    expect(
      normalizeSessionPendingList([
        {
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_a",
          timeCreated: 1,
          delivery: "steer",
          data: { text: "run now" },
          type: "user",
        },
      ]),
    ).toEqual([])
  })
})
