import { describe, expect, test } from "bun:test"
import { fetchFreeModels } from "../src/lib/models-dev"

// Oracle: the returned model list and bounded settlement. opencode.models()
// (console-api.ts) falls back to freeModels whenever fetchFreeModels rejects,
// so each stall case must reject promptly instead of staying pending.

const valid = JSON.stringify({
  opencode: {
    models: {
      free: { id: "free", name: "Free", cost: { input: 0, output: 0 } },
      paid: { id: "paid", name: "Paid", cost: { input: 1, output: 0 } },
      retired: { id: "retired", name: "Retired", status: "deprecated", cost: { input: 0, output: 0 } },
      unpriced: { id: "unpriced", name: "Unpriced" },
    },
  },
})

describe("fetchFreeModels", () => {
  test("returns the non-deprecated zero-cost models from a valid response", async () => {
    const models = await fetchFreeModels({ fetch: async () => new Response(valid) })
    expect(models.map((model) => model.id)).toEqual(["free"])
  })

  test("a stalled request settles within the deadline", async () => {
    const start = Date.now()
    await expect(
      fetchFreeModels({
        timeoutMs: 25,
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          }),
      }),
    ).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  test("a never-ending response body settles within the deadline", async () => {
    const start = Date.now()
    await expect(
      fetchFreeModels({
        timeoutMs: 25,
        fetch: async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
              },
            }),
          ),
      }),
    ).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  test("an over-limit body is rejected before full buffering", async () => {
    await expect(fetchFreeModels({ fetch: async () => new Response(valid), maxBytes: 16 })).rejects.toThrow(
      "exceeded 16 bytes",
    )
  })
})
