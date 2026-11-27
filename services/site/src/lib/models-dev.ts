// Bounded fetch of the free-model list from models.dev, for the DevTools console API
// (opencode.models() in console-api.ts). models.dev can stall before responding or
// mid-body; without a deadline and a size bound the call would stay pending forever
// and never reach the freeModels fallback. One AbortSignal deadline covers both the
// request and the body read, and the body is rejected as soon as it grows past the
// limit instead of being buffered whole.

export const modelsDevTimeoutMs = 10_000
export const modelsDevMaxBytes = 16 * 1024 * 1024

export type ModelsDevModel = {
  id: string
  name: string
  status?: string
  cost?: { input?: number; output?: number }
}

type ModelsDev = Record<string, { models?: Record<string, ModelsDevModel> }>

export async function fetchFreeModels(options?: {
  timeoutMs?: number
  maxBytes?: number
  fetch?: typeof fetch
}): Promise<ModelsDevModel[]> {
  const load = options?.fetch ?? fetch
  const response = await load("https://models.dev/api.json", {
    signal: AbortSignal.timeout(options?.timeoutMs ?? modelsDevTimeoutMs),
  })
  const data = JSON.parse(await readBounded(response, options?.maxBytes ?? modelsDevMaxBytes)) as ModelsDev
  return Object.values(data.opencode?.models ?? {}).filter(
    (model) => model.cost?.input === 0 && model.cost?.output === 0 && model.status !== "deprecated",
  )
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("models.dev response had no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`models.dev response exceeded ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
