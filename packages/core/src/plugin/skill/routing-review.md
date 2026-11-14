<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Routing Review

Review how the user's model pools, categories, plans and usage fit together, and
recommend changes they can approve. Start read-only. Change nothing until the user
approves a specific change, then make only that change.

The other skills hold the detail: `routing-usage` for what each figure means,
`plan-tracking` for finding and recording plan facts, and `routing-config` for the
exact config keys.

## 0. Before you start

- Read the evidence in this order:
  1. `route_stats` with `hours: 168` (a week) for pools, members and health. Pass
     `route` to focus on one pool. Use `hours: 24` only for "what is happening now".
  2. `route_usage` with `hours: 168` for who used what, cost, sessions and the share
     of each plan window that is gone.
  3. `plan_info` with `list` for the plan records, tiers, pool purposes and the
     latest notes.
- `route_stats` and `route_adjust` are offered only when some pool is at autonomy
  `agent` or has no autonomy set. `route_usage` and `plan_info` are always offered
  when routes exist. If `route_stats` is missing, say so and offer to set
  `autonomy: "agent"` on the pools the user wants reviewed, as a config change
  that needs approval.
- Check how much evidence there is: total attempts, and attempts per pool. Thin data
  means thin recommendations (section 3).
- Read the notes before the numbers. An expectation or an experience changes what a
  good result looks like.

## 1. What exists

### Pools

A pool is `experimental.model_routes.<id>`: an ordered list of targets plus the
models its matching keys (`include`, `contains`, `match`) add, shown as the model
`opencode-route/<id>`. A category's model can be a pool, and a pool can list
another pool as a target or name it in a matching key. `route_stats` lists only the
configured `targets` as members until the history has offered the matched ones.

- `selection`: `ordered` (default; the first ready target takes the traffic, and the
  rest are failover, ranked by effective weight), `round-robin` (weights are priority
  tiers: new sessions rotate evenly inside the top tier, and the next tier is tried
  only once every target above it has failed), or `weighted` (each new session draws
  a target in proportion to its weight). In every mode a session stays on its target
  while it works; failover moves it.
- `weights`: per target, default 1 — ratios in `weighted` pools, priority tiers in
  `round-robin` pools, failover rank in `ordered` pools.
- `health`: `firstTokenTimeoutMs` (default 10000), `maxResponseTimeMs`,
  `minOutputTokensPerSecond`, `sampleWindow` (5), `slowThreshold` (3), `cooldownMs`
  (60000), `quotaCooldownMs` (900000). A target that fails goes on cooldown.
- `budgets`: per target, `requestsPerMinute`, `requestsPerDay`, `tokensPerMinute`,
  `tokensPerDay`, `softLimit` (default 0.9). A target at its soft limit is passed over.
- `attempts`: requests per target before failover (default 2, so one retry).
  Retries happen only before any output, and a rate limit or quota error moves on
  at once.
- `hedgeAfterMs`: after this many milliseconds without output, the next target gets
  the same request, and the first answer wins. It costs a duplicate request.
- `autonomy`: `fixed`, `rules`, `adaptive`, `predictive` or `agent`, each including
  the ones before it.

A target is left out of a selection for one reason, which `route_stats` reports as
`excluded`: `cooldown`, `provider-limit`, `user-skip`, `soft-budget`,
`over-limit` (the request does not fit the target's ceiling), `already-tried` (it already failed in this request), or `sits-out-level` (its
remap sits out the requested level, which is configuration, not a fault).

### How effective weight is formed

Start from the configured weight, then apply in order:

1. Schedules: the global `experimental.model_route_schedules`, then the pool's own.
   `factor` multiplies, `weight` replaces.
2. User preferences from OpenChamber sentence rules. "Prefer" multiplies by 3 unless a
   factor or weight is given. "Avoid" takes the target out of rotation at every
   autonomy level.
3. Recorded adjustments (`route_adjust` and the tuner), except on `fixed` pools.
4. Quota demotion: a target demoted after quota errors keeps 1% of its weight until
   it recovers.

### Categories and classification (OpenChamber)

- Categories are OpenChamber's task classes: `trivial` (mechanical work), `research`
  (read and explain), `implement` (bounded engineering), `review` (inspect a change),
  and `hard` (ambiguous, high-stakes or unknown-cause work). Each has a model, a
  variant and an agent; a category with no model uses the fallback. Users can add
  their own.
- The file is `routing.json` in the OpenChamber data directory (`$OPENCHAMBER_DATA_DIR`,
  or `~/.config/openchamber` by default). It stores only what differs from the
  defaults. Read it if you can. If you cannot, ask the user to paste the categories
  from Settings → Routing.
- Jev, the classifier, picks one category per request with a confidence. Below
  `minConfidence` (default 0.6) the fallback is used. Stickiness keeps a session on
  its model until consistent prompts move it.
- Auto is OpenChamber's mode that picks a category for each request. It is not a pool.
- Category choices are not written to the history. `route_usage` cannot split a pool
  by category.

### Plans, tiers and notes

- Plan records and their quota windows: see `plan-tracking`.
- Model tiers (`cheap`, `standard`, `frontier`) say what a model costs the user, its speed/capabilities,
  and whether a plan covers it. Pool purposes say what each pool is for.
- Notes are the user's experiences and expectations, dated and never rewritten.

### Where things change

- A pool's members, weights and selection, or a model's visibility: the OpenCode config
  (`routing-config`).
- A category's model, or a sentence rule: OpenChamber Settings → Routing.
- A plan, a model's tier, a pool's purpose, a note: `plan_info`.
- A temporary fact: `route_adjust`, with approval.

## 2. Procedure

1. Gather the evidence in section 0, in order. Read the notes first.
2. For each pool, apply section 3 in order: members that do not fit, splitting or
   merging, underused members, category fit, cost tiers, and the plan order of
   operations.
3. Write the report in the format of section 4. Recommend only what the evidence
   supports, and say which evidence each recommendation rests on.
4. After approval, make exactly the approved change, the smallest one that works:
   a weight before a membership change, a schedule before a permanent weight, an
   adjustment before a config edit for a temporary fact, and a note before a change
   of a plan record unless the user states a new fact. Record the change with
   `plan_info` when it concerns a plan, and re-run the evidence after enough time has
   passed: a day for a weekday pattern, a week for a pattern across days.

## 3. Decision rules

Minimum evidence:

- 20 attempts before judging a member's latency, speed or reliability.
- 30 new-session draws before judging a weight.
- 3 days of history before judging a time-of-day pattern.
- 100 attempts in a pool before splitting or merging it.
- 7 days of history before judging a plan's window or a monthly pattern.

Below these, say "not enough data yet" and name the number you need.

### 3.1 A member that does not fit its pool

Read the pool's purpose from its name, its `purpose` in the plan store, and the
categories that use it. Compare each member with the pool's median member:

- Slow to answer: first output above 2.5 times the pool median.
- Slow to stream: tokens per second below half the pool median.
- Unreliable: a failure rate of 20% or more. At 50% or more it is broken.
- Undersized: failures such as `ContextLengthExceeded` on a member, while the pool's
  `inputTokens` p90 is well above that member's context.
- Costly for the pool's purpose: compare the member's cost per request (from
  `route_usage`) with its tier in the plan store. A `cheap` pool with a `frontier`
  model or an unmanaged high-cost model is a misclassification.

Recommend moving a member only when two signals agree and the evidence meets the
minimums. A single bad hour is not evidence: check `predictions` first. Quality is
not measured. If the question is whether answers are good enough, ask the user.

### 3.2 Splitting a pool

Split only for one of these:

- Two request sizes behave differently: `inputTokens` p90 is at least 4 times p50,
  and the failures or slow answers sit on the large requests. Propose a small-input
  pool and a large-input pool.
- Two categories send different kinds of work to one pool, and their best members
  differ on the user's account or on the data. Say that route data cannot separate
  the categories.

Do not split for one category, or below 100 attempts.

### 3.3 Merging or retiring a pool

Propose a merge when two pools have the same members or at least 80% overlap, and
the same categories use them. Propose retiring a pool when it has fewer than 20
attempts in 7 days and no category uses it. Retire only after the user confirms.

### 3.4 Underused members

Only in `weighted` and `round-robin` pools, compare `takeRate` with `expectedShare`
over at least 30 draws. `expectedShare` follows the pool's own mode: in a `weighted`
pool it is the member's proportional share of the weights; in a `round-robin` pool
weights are priority tiers, so the top tier present in a draw splits the expectation
evenly and every lower tier expects 0 — a lower-tier member that wins nothing is
serving as failover, exactly as configured, not underused.

- Underused: `takeRate` below half of `expectedShare`, and exclusions on fewer than
  20% of its offers. In a `weighted` pool, raise its weight by 1.5 to 2 times, or add
  a time-bound schedule. In a `round-robin` pool only a member of the active tier can
  be underused this way; the fix is a tier change — raise its weight into (or above)
  the top tier — not a proportional bump, which leaves it in its tier.
- Mostly excluded: a health or budget problem, not a weight problem. Read its errors,
  cooldown and budget.

In `ordered` pools a member behind a healthy first target is idle by design. Do not
call it underused. Look at it when the targets ahead of it fail often, or when it
is configured but absent from the history. Then check the spelling, an `until` that
has passed, and whether its provider is disabled.

Never recommend dropping a provider for low traffic alone. Lower its weight first and
let a window pass.

### 3.5 Categories and their pools

Each category points at a model or pool. Check that the pool does what the
category's description asks for:

- `trivial` and `research`: fast, cheap members. Judge by first-output latency,
  speed and cost.
- `implement`: reliable mid-tier members. Judge by failure rate and errors.
- `review`: careful members that finish. Judge by failure rate and timeouts.
- `hard`: the strongest members, however slow. Judge by reach and reliability.

A mismatch is a proposal, not a fact. Route data cannot show answer quality, so name
what the user should check. When several categories share one pool, its numbers mix
their traffic.

### 3.6 Cost and Capability tiers

Use the model tiers in the plan store, and the cost per request from `route_usage`.

- A `frontier` model that a subscription covers, with headroom in that plan's window, can take
  work that a metered `standard` model does now. Propose moving the work, and say which
  window has the headroom.
- A `frontier` model with no covering plan, used for `trivial` or `research` work, is
  the usual cause of an unexpected bill. Propose moving that work to a `cheap` or `standard`
  member.
- A subscription-covered model whose window is spent (`percent` at or near 100) should drop to a
  metered fallback until the window resets. Give the reset time from `resetRule` or
  `resetAt`.
- An expectation note ("I always have GPT left at month end") is a reason to spend
  that plan first when the window is near its end. Quote it.

### 3.7 The plan order of operations

For each provider that matters, use `route_usage` (`plans`) and the plan record:

- Burn rate per day: the window's usage over its last `windowHours`, divided by the
  window's length in days. Use the 7-day history for a steadier estimate.
- Days left: until the next reset, or until expiry if that is sooner.
- Projected use: burn rate times days left.
- Headroom: the limit's remaining amount minus projected use.

Order the actions by time:

1. Expiring with headroom ("use it or lose it"): raise its weight now, with a
   `route_adjust` whose `hours` reach the expiry, or a schedule that ends at expiry.
   Taper before expiry if the headroom shrinks.
2. A refilling window with headroom (daily or hourly): a schedule that raises its
   weight in the hours before the reset.
3. Projected to run out before its reset: skip the non-essential traffic with
   `route_adjust` until the reset time, and keep the target only for the categories
   that need it.
4. A flat fee with headroom and no expiry: prefer it over metered members of the same
   pool.
5. Metered members: the lowest weight, fallback only, unless the flat plans have no
   headroom.

Present a timeline (now, next reset, expiry), with the change at each step. Mark every
number that came from the user, from a recorded limit, or from a single reading.

## 4. Report

Lead with the three most valuable actions. Then:

- **Evidence:** a table per pool, with the window stated. Columns: member, attempts,
  failure rate, first output, tokens per second, take rate against expected share,
  exclusions, errors, and cost per request.
- **Plans:** each plan's windows with used, limit, percent and reset, and how old its
  record is.
- **Findings:** each with the rule from section 3, the numbers behind it, a confidence
  (high, medium or low), and what would change the conclusion.
- **Proposed changes:** numbered. For each: where it goes (the config key, the
  `route_adjust` arguments, the `plan_info` call, or the OpenChamber setting), the
  exact snippet, the expected effect, when to check it, and how to undo it.
- **Needs you:** the questions only the user can answer: plan facts, prices, answer
  quality, and what a category is meant to cover.
- **Not measured:** what this review could not see.

Keep it short enough to read in a terminal. Label every measured fact and every
guess as such.

## 5. Guardrails

- Read-only until the user approves a specific change. That covers `route_adjust`,
  `route_stats` with `apply: true`, and any edit to the OpenCode config,
  `routing.json`, or OpenChamber settings.
- `plan_info` writes record facts the user stated or a source shows. Do not record
  a guess.
- Do not read or print credentials, tokens or auth files.
- Do not invent prices, plan limits, reset times or categories. Ask.
- Do not recommend from thin data. Name the minimum and what is missing.
- Do not react to one bad hour, one error, or one day of a weekly pattern.
- Prefer the smallest change: a weight before a membership change, a schedule before a
  permanent weight, and an adjustment before a config edit.
- Respect the user's choices. A pool they built for a reason stays unless the data
  clearly contradicts it. If it does, say so and let them decide.
