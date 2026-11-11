import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Document, Info } from "@opencode/schema/config"
import { ConfigModelRoutesPlugin } from "@opencode/core/config/plugin/model-routes"

const decode = Schema.decodeUnknownSync(Info)

const document = (info: unknown) =>
  new Document({ type: "document", info: decode(info) })

describe("configuredMembershipLimits", () => {
  test("reads the membership block a provider declares on its own definition", () => {
    const entries = [
      document({
        providers: {
          opendesign: { settings: { membership: { concurrent: 10, requestsPerMinute: 100 } } },
        },
      }),
    ]
    expect(ConfigModelRoutesPlugin.configuredMembershipLimits(entries, "opendesign")).toEqual({
      concurrent: 10,
      requestsPerMinute: 100,
    })
    expect(ConfigModelRoutesPlugin.configuredMembershipLimits(entries, "other")).toBeUndefined()
  })

  test("later documents win, as they do for the provider's other settings", () => {
    const entries = [
      document({
        providers: { opendesign: { settings: { membership: { concurrent: 5, requestsPerMinute: 50 } } } },
      }),
      document({
        providers: { opendesign: { settings: { membership: { concurrent: 10, requestsPerMinute: 100 } } } },
      }),
    ]
    expect(ConfigModelRoutesPlugin.configuredMembershipLimits(entries, "opendesign")).toEqual({
      concurrent: 10,
      requestsPerMinute: 100,
    })
  })

  test("a malformed declaration is not a declaration", () => {
    const entries = [
      document({
        providers: { opendesign: { settings: { membership: { concurrent: "10", requestsPerMinute: 100 } } } },
      }),
    ]
    expect(ConfigModelRoutesPlugin.configuredMembershipLimits(entries, "opendesign")).toBeUndefined()
  })

  test("no providers, no caps", () => {
    expect(ConfigModelRoutesPlugin.configuredMembershipLimits([], "opendesign")).toBeUndefined()
    expect(ConfigModelRoutesPlugin.configuredMembershipLimits([document({})], "opendesign")).toBeUndefined()
  })
})
