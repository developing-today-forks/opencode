# TODO

## Externally persisted session state so restarts are invisible

Today a restart of `opencode serve` interrupts running sessions. Graceful drain and config reload
cover the common cases, but the server still has to exit, and anything still running at the
grace deadline is cut and only resumed from the claimed-execution record on the next boot.

Long term, session state (messages, execution claims, pending tool calls, and streamed output)
should live in a store that outlives the server process. A restarted server would then reattach
to in-flight work instead of resuming it, so restarts stop being visible to the user.

Open questions:
- Which store owns session state (the local database, or a separate process the server connects to)?
- How does a restarted server reattach to a model stream that was in flight when it died?
- How do clients that were mid-turn learn that the work continued instead of failing?

## Supervisor and handoff protocol for replacing `opencode serve`

A replaced server should never refuse a client that was already connected. Clients see a refused
connection only when nothing holds the listening socket, so the supervisor keeps one.

Implemented in `serve` (the Node build; see the runtime note below):
- Listener inheritance: with `LISTEN_PID` naming the server and `LISTEN_FDS` set, `serve` serves the
  socket on fd 3 instead of binding `hostname:port`. `LISTEN_PID` and `LISTEN_FDS` are removed from
  the environment once read, so children do not see them. Children spawned by `serve` do not inherit
  fd 3: Node and Bun spawn children with only the descriptors they map (checked by running a shell
  from a process that held the socket).
- Drain: `SIGTERM` closes the server's listener, stops answering idle keep-alive connections, and
  sends `Connection: close` on responses still in progress. Requests already accepted are still
  answered, and running sessions and non-SSE requests finish within `OPENCODE_SHUTDOWN_GRACE_MS`.
  A second `SIGTERM` ends the wait. Event streams are not waited for; they end when the process
  exits, after the events of sessions that finished during the drain.
- Ready: once `serve` is listening and its application is ready, it sends `READY=1` to
  `$NOTIFY_SOCKET` (sd_notify, `Type=notify`) and prints `opencode: ready` on stdout. In `--stdio`
  mode the line goes to stderr, because stdout carries the JSON handshake. The check runs in-process
  rather than over the socket: a request sent to a shared socket could be answered by a predecessor.
- Starting: until it is ready, the successor answers `GET /api/info` at once with 503 and `Retry-After`, and
  holds every other request for up to `Status.startupWait` (25 seconds). A held request is served as soon as the
  successor is ready, so a request that reaches the successor early is not refused. Only a startup still running
  when the wait ends answers 503 `service_starting`. A client that disconnects cancels its own wait.
- Runtime: Bun 1.4's `node:http`, `Bun.serve` and `Bun.listen` ignore an inherited socket and bind a
  port of their own, but `node:net` adopts it (`net.Server.listen({ fd })`). On Bun the listener is a net
  server on fd 3, and each accepted connection is handed to the unchanged http server
  (`packages/server/src/inherited-socket.ts`). The Node build keeps `http.listen({ fd })`. `READY=1` uses
  `sendto(2)` on Bun and `systemd-notify` on Node, because neither runtime has a unix datagram socket.
- Wrapper: `bin/opencode.cjs` passes fd 3 to the server it starts and rewrites `LISTEN_PID` to that
  child's pid, so the handover works through the installed launcher.

Handover order a supervisor must follow:
1. The supervisor creates the listening socket and keeps its own descriptor open for the whole
   service lifetime. Closing the last descriptor is what refuses connections.
2. Start the successor with the socket as fd 3, `LISTEN_FDS=1`, and `LISTEN_PID` set to the
   successor's pid. The successor starts accepting on the same socket while the predecessor still runs.
3. Wait for the successor's `READY=1` (or `opencode: ready`). Only then send `SIGTERM` to the
   predecessor. Sending it earlier moves traffic to a server that has not proven it can answer.
4. The predecessor closes its own copy of the socket and drains. The kernel keeps the socket because
   the supervisor and the successor still hold it, so connections queue for the successor instead
   of being refused.
5. When the predecessor exits, the supervisor keeps its descriptor until the next handover.

Verified by `packages/cli/test/serve-handover.test.ts` with real processes on both runtimes: a 10 ms
client loop across a handover saw no refused connection and no failed request, while a control run
without a supervisor's socket refused connections on every restart. The control code path is the same
binary without `LISTEN_FDS`, so it binds the port itself as before.

Verified under a real systemd user session (systemd 261, `Linger=yes`) on 2026-10-28, with a socket
unit (`ListenStream=127.0.0.1:4319`) and a `Type=notify` service whose `ExecStart` runs the launcher,
so the process that sends `READY=1` is the server child rather than the unit's main pid:
`NotifyAccess=all` accepts it, and the socket unit holds the listener across `systemctl --user
restart`, which is the handover. Two generations under a 10 ms request loop on a fresh connection saw
no refused connection and no failed request, and the journal shows `Started` for each generation with
`opencode: ready` from the child. The unit and its output are recorded on issue #81.

The teardown race is closed. A connection the predecessor accepted in the last instant before it
closed could get a reset when its request arrived after teardown began: the drain tracked only
requests whose headers had been parsed, and the Bun listener dropped idle connections as soon as it
closed, so a connection that had connected but not yet sent its request was reset. Measured before
the fix, a fresh connection every 5 ms across ten `systemctl --user restart` handovers saw 4 resets in
1851 requests (0.22%), and the handover order alone, with the successor ready before the predecessor
stops, saw 1 in 7376. The drain now keeps serving connections the listener already accepted for a
bounded linger (500 ms) before closing them, and waits for any request that arrives during the
linger. `packages/cli/test/serve-handover.test.ts` covers it with "a drain answers a request on a
connection the server accepted before it began", which fails without the drain change.

Still open:
- Session state: restarts still interrupt sessions that outlive the grace period; see the section above.
