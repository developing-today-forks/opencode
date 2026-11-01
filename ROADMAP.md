# Roadmap

This is the roadmap for the fork. It is grouped by area. Each area lists its items by horizon: Now, Next, Later and Ideas. How the roadmap works, and how it connects to specs and plans, is in [`planning/README.md`](planning/README.md).

A row here records intent. It does not settle a product question and it is not a go-ahead to build.

Sources: open issues, [`TODO.md`](TODO.md), the fork notice in [`README.md`](README.md), and the merged PRs of 2026-10-20, 2026-10-21 and 2026-10-22.

## Areas

| Area                                                        | Current focus                                             |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| [Nested subsessions](#nested-subsessions-and-their-asks)    | Shipped across the TUI, the app and ACP                   |
| [mcpx integration](#mcpx-integration)                       | Tool projection and daemon lifecycle                      |
| [Serve handover and restarts](#serve-handover-and-restarts) | Session state outside the server process                  |
| [Routing, cost and plans](#routing-cost-and-plans)          | Feature requests for failover, cost display and cache use |
| [CI and test health](#ci-and-test-health)                   | A main branch whose checks are green                      |
| [Upstream sync](#upstream-sync)                             | Daily sync verified working                               |

## Nested subsessions and their asks

Subagents can launch subagents. Pending permissions and questions from any depth now reach the root session in the app, the TUI and ACP.

## mcpx integration

The fork projects mcpx tools into Code Mode, starts a detached daemon with just-in-time secret prompts, and cleans up leaked daemons. The mcpx source lives in `developing-today/code`.

## Serve handover and restarts

`opencode serve` can hand its listening socket to a successor with no refused connection. See [`TODO.md`](TODO.md) for the protocol and its open parts.

| Title                                    | Horizon | Status   | Intent                                                                                                            | Links           |
| ---------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------- | --------------- |
| Session state outside the server process | Later   | idea     | A restarted server reattaches to in-flight work, so restarts stop being visible. Open questions are in `TODO.md`. | [TODO](TODO.md) |

## Routing, cost and plans

The fork adds named route pools, scheduled weights, request telemetry with cost, route review tools and plan or quota tracking.

| Title                                         | Horizon | Status | Intent                                                                           | Links |
| --------------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------- | ----- |
| Failover across credentials on 429            | Later   | idea   | Switch to another credential when quota runs out, through `credential.activate`. | #6    |
| Show authoritative cost in the desktop header | Later   | idea   | Use the models.dev `cost_usd`.                                                   | #7    |
| Prompt cache use across model pools           | Later   | idea   | Through `compatibility.cacheFormat`.                                             | #9    |
| Auto-check plan steps                         | Later   | idea   | Use turn file change summaries to tick plan steps.                               | #10   |

## CI and test health

| Title                                    | Horizon | Status   | Intent                                                                                                      | Links |
| ---------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------- | ----- |

## Upstream sync

No open items. The daily Jules sync issue (#41) closed as transient on 2026-10-21 after three consecutive scheduled successes; see Done.

## Done

Completed work is recorded in GitHub — see closed issues and merged PRs.
