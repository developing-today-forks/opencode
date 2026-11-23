import { parseWindowBootstrap, type WindowBootstrap } from "../shared/window-bootstrap"

// Asks the main process for the bootstrap the argv did not deliver. The answer crosses a process
// boundary, so it is validated like the argv value; a channel error, an unknown-sender refusal
// (undefined), or a malformed answer all resolve to undefined, and the preload exposes the
// degraded minimal bridge exactly as a window without a bootstrap argument does today.
// SAFETY: the invoke result is the untrusted IPC answer itself; parseWindowBootstrap is the
// parser at this boundary, so the callback legitimately carries `unknown` into it.
export async function recoverWindowBootstrap(
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see SAFETY above
  invoke: () => Promise<unknown>,
): Promise<WindowBootstrap | undefined> {
  try {
    return parseWindowBootstrap(await invoke())
  } catch {
    return undefined
  }
}
