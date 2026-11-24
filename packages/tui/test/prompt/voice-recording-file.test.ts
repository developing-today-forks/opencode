import { expect, test } from "bun:test"
import { readFile, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createVoiceRecordingFile } from "../../src/component/prompt/voice-input"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform === "win32")("double reserve in the same directory yields distinct owner-only paths", async () => {
  await using tmp = await tmpdir()
  const first = await createVoiceRecordingFile(tmp.path)
  const second = await createVoiceRecordingFile(tmp.path)
  expect(first).not.toBe(second)
  expect((await stat(first)).mode & 0o777).toBe(0o600)
  expect((await stat(second)).mode & 0o777).toBe(0o600)
})

test.skipIf(process.platform === "win32")("a planted symlink at the candidate path is never followed or overwritten", async () => {
  await using tmp = await tmpdir()
  const victim = path.join(tmp.path, "victim.txt")
  await writeFile(victim, "original")
  await symlink(victim, path.join(tmp.path, "planted.wav"))
  // A name generator that keeps proposing the planted name is refused
  // loudly after the retries instead of following the link.
  await expect(createVoiceRecordingFile(tmp.path, () => "planted.wav")).rejects.toThrow(
    "Unable to create a unique staging file",
  )
  expect(await readFile(victim, "utf8")).toBe("original")
  // A generator that moves on to a fresh name succeeds without
  // touching the plant.
  let calls = 0
  const reserved = await createVoiceRecordingFile(tmp.path, () =>
    ++calls === 1 ? "planted.wav" : "fresh.wav",
  )
  expect(path.basename(reserved)).toBe("fresh.wav")
  expect(await readFile(victim, "utf8")).toBe("original")
})
