import { afterEach, expect, mock, test } from "bun:test"

// The regression shape for #2313 is the environment the binding is
// constructed under, so the keyring binding is replaced with a recording
// double: it captures DBUS_SESSION_BUS_ADDRESS at construction time and
// answers like a live Secret Service unless the address is the bogus one.
const constructedWith: (string | undefined)[] = []

class RecordingEntry {
  constructor(
    readonly service: string,
    readonly username: string,
  ) {
    constructedWith.push(process.env.DBUS_SESSION_BUS_ADDRESS)
  }

  async getPassword(): Promise<string> {
    if (process.env.DBUS_SESSION_BUS_ADDRESS?.includes("unavailable")) {
      throw new Error("no such bus")
    }
    return "mock-secret"
  }
}

mock.module("@napi-rs/keyring", () => ({ AsyncEntry: RecordingEntry }))

const { lookupSecretService } = await import("../../src/providers/secret-service.js")

const originalBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS

afterEach(() => {
  if (originalBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
  else process.env.DBUS_SESSION_BUS_ADDRESS = originalBusAddress
  constructedWith.length = 0
})

test("an absent session-bus address is synthesized before the entry is constructed (#2313)", async () => {
  if (typeof process.getuid !== "function") return
  delete process.env.DBUS_SESSION_BUS_ADDRESS
  await expect(lookupSecretService("org.opencode.test", "someone")).resolves.toBe("mock-secret")
  expect(constructedWith).toEqual([`unix:path=/run/user/${process.getuid()}/bus`])
})

test("an explicit bogus session-bus address is left alone and still resolves undefined (#2313)", async () => {
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/opencode-secret-service-test-unavailable"
  await expect(lookupSecretService("org.opencode.test", "someone")).resolves.toBeUndefined()
  expect(constructedWith).toEqual(["unix:path=/opencode-secret-service-test-unavailable"])
})
