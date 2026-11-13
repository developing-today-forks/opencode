import { matchLocale } from "../i18n/locales"

export function localeFromAcceptLanguage(header: string | null) {
  if (!header) return "root"

  const items = header
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.split(";").map((x) => x.trim())
      const lang = parts[0] ?? ""
      const q = parts
        .slice(1)
        .find((x) => x.startsWith("q="))
        ?.slice(2)
      const parsed = q ? Number.parseFloat(q) : 1
      return {
        lang,
        // A malformed q value sorts last instead of poisoning the
        // comparator with NaN (mirrors #1309).
        q: Number.isFinite(parsed) ? parsed : 0,
        // An explicit q=0 (or negative) is a refusal, not a low
        // preference: the language is not offered at all. A malformed q
        // is not a refusal — it stays a last-resort offer.
        refused: q !== undefined && Number.isFinite(parsed) && parsed <= 0,
      }
    })
    .sort((a, b) => b.q - a.q)

  const locale = items
    .filter((item) => !item.refused)
    .map((item) => item.lang)
    .filter((lang) => lang && lang !== "*")
    .map((lang) => matchLocale(lang))
    .find((lang) => lang)

  return locale ?? "root"
}
