/**
 * Size cap for the whats-new changelog response body. The changelog is a
 * few KB of release-highlight JSON (~6 KB when this cap was added); 1 MiB
 * leaves generous headroom for it to grow while keeping a huge or hostile
 * response from buffering unbounded into the renderer (#1061). This
 * mirrors the CLI updater's bounded release read (#1031); an oversized
 * response fails the fetch, so the version stays un-marked and is retried
 * on the next start, exactly like any other failed request.
 */
export const changelogMaxResponseBytes = 1024 * 1024

export const readBoundedChangelogText = async (response: Response): Promise<string> => {
  const tooLarge = () => new Error(`Changelog response exceeded ${changelogMaxResponseBytes} bytes`)
  const contentLength = response.headers.get("content-length")
  const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined

  const declaredSize =
    parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined

  if (declaredSize !== undefined && declaredSize > changelogMaxResponseBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }

  if (!response.body) {
    const text = await response.text()

    if (new TextEncoder().encode(text).byteLength > changelogMaxResponseBytes) throw tooLarge()

    return text
  }

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break

    if (!value || value.byteLength === 0) continue

    if (size + value.byteLength > changelogMaxResponseBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }

    chunks.push(value)
    size += value.byteLength
  }

  const body = new Uint8Array(size)
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(body)
}
