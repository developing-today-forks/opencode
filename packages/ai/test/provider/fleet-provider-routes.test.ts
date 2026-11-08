import { describe, expect, test } from "bun:test"
import { Antigravity as AntigravityProtocol } from "../../src/protocols/antigravity.js"
import { Antigravity } from "../../src/providers/antigravity.js"
import { ClaudeCode } from "../../src/providers/claude-code.js"
import { Commandcode } from "../../src/providers/commandcode.js"
import { MuseDirect } from "../../src/providers/muse-direct.js"
import { Vibe } from "../../src/providers/vibe.js"

// #1945: PR #1944 (#1823) renamed the fleet-built provider ids to
// leading-underscore ids, but the bare claude-code and commandcode
// protocol routes kept the pre-rename ids, splitting provider identity
// between the bare exported routes and the configured routes (which
// derive their metadata key from the provider patch). Pin every
// fleet-built provider bare route to its underscore id with a matching
// providerMetadataKey so a future rename cannot split the set again.
describe("fleet provider bare routes", () => {
  test("bare exported routes carry the renamed underscore provider ids and matching metadata keys", () => {
    const cases = [
      ["claude", ClaudeCode.route, "_claude"],
      ["commandcode", Commandcode.route, "_commandcode"],
      ["antigravity", AntigravityProtocol.route, "_antigravity"],
      ["muse", MuseDirect.route, "_muse"],
      ["vibe", Vibe.route, "_vibe"],
    ] as const
    for (const [, route, id] of cases) {
      expect(String(route.provider)).toBe(id)
      expect(route.providerMetadataKey).toBe(id)
    }
  })

  test("provider module ids match the bare route ids", () => {
    expect(String(ClaudeCode.id)).toBe("_claude")
    expect(String(Commandcode.id)).toBe("_commandcode")
    expect(String(Antigravity.id)).toBe("_antigravity")
    expect(String(MuseDirect.id)).toBe("_muse")
    expect(String(Vibe.id)).toBe("_vibe")
  })
})
