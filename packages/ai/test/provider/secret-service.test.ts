import { expect, test } from "bun:test"
import { lookupSecretService } from "../../src/providers/secret-service.js"

test("an unavailable Secret Service returns no credential without helper binaries", async () => {
  const originalPath = process.env.PATH
  const originalBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS
  process.env.PATH = ""
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/opencode-secret-service-test-unavailable"
  try {
    await expect(
      lookupSecretService("org.opencode.test.no-entry", `missing-${crypto.randomUUID()}`),
    ).resolves.toBeUndefined()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
    else process.env.DBUS_SESSION_BUS_ADDRESS = originalBusAddress
  }
})
