/*
 * Refresh from packages/ai with `bun script/antigravity-model-catalog.ts`.
 * The script uses the quota provider's keyring-backed auth and probes both
 * daily-cloudcode-pa and production cloudcode-pa. Record its sorted output
 * for both endpoints and the UTC observation date here. Classify every key
 * as wire-complete, effort-suffixed, or internal; update
 * WIRE_COMPLETE_MODEL_IDS in src/protocols/antigravity.ts in the same change.
 * Run `bun test test/provider/antigravity.test.ts` to verify the partition
 * and the request mapping against this snapshot.
 *
 * Probe recorded 2026-11-08 UTC (re-confirmed from a fresh live probe; the
 * 2026-11-07 probe returned the identical 23 keys). Both daily-cloudcode-pa
 * and production cloudcode-pa returned these same 23 keys.
 */
export const ANTIGRAVITY_MODEL_CATALOG = {
  observedAt: "2026-11-08",
  endpoints: {
    dailyCloudcodePa: [
      "chat_20706",
      "chat_23310",
      "claude-opus-5-5-high",
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-low",
      "claude-sonnet-5-5-medium",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-thinking",
      "gemini-2.5-pro",
      "gemini-3-flash",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-tiered",
      "gpt-oss-120b-medium",
      "tab_flash_lite_preview",
      "tab_jump_flash_lite_preview",
    ],
    cloudcodePa: [
      "chat_20706",
      "chat_23310",
      "claude-opus-5-5-high",
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-low",
      "claude-sonnet-5-5-medium",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-thinking",
      "gemini-2.5-pro",
      "gemini-3-flash",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-tiered",
      "gpt-oss-120b-medium",
      "tab_flash_lite_preview",
      "tab_jump_flash_lite_preview",
    ],
  },
  wireCompleteModelIds: [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-pro",
    "gemini-3-flash",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash-tiered",
  ],
  effortModelIds: [
    "claude-opus-5-5-high",
    "claude-opus-5-5-low",
    "claude-opus-5-5-medium",
    "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-low",
    "claude-sonnet-5-5-medium",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-medium",
    "gpt-oss-120b-medium",
  ],
  internalModelIds: ["chat_20706", "chat_23310", "tab_flash_lite_preview", "tab_jump_flash_lite_preview"],
} as const
