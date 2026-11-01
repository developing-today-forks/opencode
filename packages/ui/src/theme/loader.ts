import type { DesktopTheme, ResolvedTheme, ResolvedV2Theme } from "./types"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { resolveThemeVariantV2, themeV2ToCss } from "./v2/resolve"

let activeTheme: DesktopTheme | null = null

const THEME_STYLE_ID = "opencode-theme"

function ensureLoaderStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null

  if (existing) {
    return existing
  }

  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)

  return element
}

export function applyTheme(theme: DesktopTheme, themeId?: string): void {
  activeTheme = theme
  const lightTokens = resolveThemeVariant(theme.light, false)
  const darkTokens = resolveThemeVariant(theme.dark, true)
  const lightV2Tokens = resolveThemeVariantV2(theme.light, false)
  const darkV2Tokens = resolveThemeVariantV2(theme.dark, true)
  const targetThemeId = themeId ?? theme.id
  const css = buildThemeCss(lightTokens, darkTokens, lightV2Tokens, darkV2Tokens, targetThemeId)
  const themeStyleElement = ensureLoaderStyleElement()
  themeStyleElement.textContent = css
  document.documentElement.setAttribute("data-theme", targetThemeId)
}

function buildThemeCss(
  light: ResolvedTheme,
  dark: ResolvedTheme,
  lightV2: ResolvedV2Theme,
  darkV2: ResolvedV2Theme,
  themeId: string,
): string {
  const isDefaultTheme = themeId === "oc-2"
  const lightCss = `${themeToCss(light)}\n  ${themeV2ToCss(lightV2)}`
  const darkCss = `${themeToCss(dark)}\n  ${themeV2ToCss(darkV2)}`

  if (isDefaultTheme) {
    return `
:root {
  color-scheme: light;
  --text-mix-blend-mode: multiply;

  ${lightCss}

  @media (prefers-color-scheme: dark) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;

    ${darkCss}
  }
}
`
  }

  return `
html[data-theme="${themeId}"] {
  color-scheme: light;
  --text-mix-blend-mode: multiply;

  ${lightCss}

  @media (prefers-color-scheme: dark) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;

    ${darkCss}
  }
}
`
}

/**
 * Size cap for a theme loaded from a URL. Bundled themes are a few KB of
 * token JSON (the largest, oc-2, is ~24 KB); 1 MiB leaves generous headroom
 * while keeping a huge or hostile response from buffering unbounded into
 * the renderer (#1061). This mirrors core's `readBoundedResponseText`
 * (`packages/core/src/tool/http-body.ts`), which ui cannot import under
 * the repo's dependency layering.
 */
export const themeMaxResponseBytes = 1024 * 1024

const readBoundedThemeText = async (response: Response, url: string): Promise<string> => {
  const tooLarge = () => new Error(`Theme response from ${url} exceeded ${themeMaxResponseBytes} bytes`)
  const contentLength = response.headers.get("content-length")
  const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
  const declaredSize =
    parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
  if (declaredSize !== undefined && declaredSize > themeMaxResponseBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > themeMaxResponseBytes) throw tooLarge()
    return text
  }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    if (size + value.byteLength > themeMaxResponseBytes) {
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

export async function loadThemeFromUrl(url: string): Promise<DesktopTheme> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to load theme from ${url}: ${response.statusText}`)
  }

  return JSON.parse(await readBoundedThemeText(response, url))
}

export function getActiveTheme(): DesktopTheme | null {
  const activeId = document.documentElement.getAttribute("data-theme")

  if (!activeId) {
    return null
  }

  if (activeTheme?.id === activeId) {
    return activeTheme
  }

  return null
}

export function removeTheme(): void {
  activeTheme = null
  const existingElement = document.getElementById(THEME_STYLE_ID)

  if (existingElement) {
    existingElement.remove()
  }

  document.documentElement.removeAttribute("data-theme")
}

export function setColorScheme(scheme: "light" | "dark" | "auto"): void {
  if (scheme === "auto") {
    document.documentElement.style.removeProperty("color-scheme")
  } else {
    document.documentElement.style.setProperty("color-scheme", scheme)
  }
}
