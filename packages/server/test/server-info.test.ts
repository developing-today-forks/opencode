import { describe, expect, test } from "bun:test"
import type { networkInterfaces } from "node:os"
import { connectionURLs } from "../src/server-info"

describe("ServerInfo.connectionURLs", () => {
  test("omits IPv6 link-local interfaces but keeps loopback, ULA, and global addresses", () => {
    const interfaces: ReturnType<typeof networkInterfaces> = {
      lo: [
        {
          address: "::1",
          cidr: "::1/128",
          family: "IPv6",
          internal: true,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "00:00:00:00:00:00",
          scopeid: 0,
        },
      ],
      eth0: [
        {
          address: "fe80::1",
          cidr: "fe80::1/64",
          family: "IPv6",
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "00:00:00:00:00:00",
          scopeid: 2,
        },
        {
          address: "fd00::1",
          cidr: "fd00::1/64",
          family: "IPv6",
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "00:00:00:00:00:00",
          scopeid: 0,
        },
        {
          address: "2001:db8::1",
          cidr: "2001:db8::1/64",
          family: "IPv6",
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "00:00:00:00:00:00",
          scopeid: 0,
        },
      ],
    }

    expect(connectionURLs("http://[::]:4096", undefined, interfaces)).toEqual([
      "http://[::1]:4096",
      "http://[fd00::1]:4096",
      "http://[2001:db8::1]:4096",
    ])
  })

  test("leaves IPv4 wildcard and specific-hostname results unchanged", () => {
    const interfaces: ReturnType<typeof networkInterfaces> = {
      eth0: [
        { address: "192.0.2.1", cidr: "192.0.2.1/24", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00" },
      ],
    }

    expect(connectionURLs("http://0.0.0.0:4096", undefined, interfaces)).toEqual([
      "http://127.0.0.1:4096",
      "http://192.0.2.1:4096",
    ])
    expect(connectionURLs("http://example.test:4096", undefined, interfaces)).toEqual(["http://example.test:4096"])
  })
})
