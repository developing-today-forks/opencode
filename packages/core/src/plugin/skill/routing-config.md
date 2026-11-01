<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Routing Config

How to change what OpenCode shows and how routed models are chosen, with the exact
keys. Read this before you edit a config file. Change nothing until the user
approves the specific change.

## Where config lives

- Project settings: `opencode.jsonc` (or `opencode.json`) at the project root.
  Global settings: the OpenCode config directory, `~/.config/opencode/`. Project
  values override global ones. `opencode config` lists the files OpenCode reads.
- OpenCode reloads config files on change. A request already in progress keeps the
  settings it started with.
- JSONC allows comments and trailing commas. Keep both valid when you edit.
- OpenChamber's Auto categories are not in this file. They live in OpenChamber's
  `routing.json` (see routing-review, section 1).

## Providers: turn on or off

- Turn one off: `"disabled_providers": ["<providerID>"]`. Its models leave every
  picker, and pool targets that use it cannot be reached.
- Allow-list: `"enabled_providers": ["<providerID>", ...]` turns off every provider
  it does not name. Use it only when the user asks for an allow-list.
- The same thing as policies, in `experimental.policies`:
  `{ "action": "provider.use", "resource": "<providerID>", "effect": "deny" }`, or
  `"allow"` to switch a denied provider back on.
- In OpenChamber, Settings → Providers has an on/off control. `/connect` in OpenCode
  connects a provider. Never edit credential files by hand.

## Models: hide, show, add

Model entries sit under `providers`:

```jsonc
{
  "providers": {
    "<providerID>": {
      "models": {
        "<modelID>": { "disabled": true },
      },
    },
  },
}
```

- `disabled: true` hides the model from the picker and takes it out of routing.
- Show it again: set `"disabled": false`, or delete the key.
- Add a model the catalog does not list: a new key under `models` with `modelID`
  (the provider's real id), `name`, and `limit` (`context`, `output`).
- In OpenChamber, hiding a model from the model picker is a UI-only setting. OpenCode
  and the pools still use the model. The config key is what changes what routing
  can reach.

## Pools: define and change

A pool is `experimental.model_routes.<id>`. OpenCode and OpenChamber show it as the
model `opencode-route/<id>`.

```jsonc
{
  "experimental": {
    "model_routes": {
      "cheap-fast": {
        "targets": ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
        "selection": "weighted",
        "weights": { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
        "autonomy": "agent",
        "health": { "firstTokenTimeoutMs": 10000, "cooldownMs": 60000 },
        "budgets": { "openai/gpt-6-luna": { "requestsPerDay": 500, "softLimit": 0.9 } },
        "attempts": 1,
        "hedgeAfterMs": 8000,
      },
    },
  },
}
```

- `targets`: `"provider/model"`, `"provider/model#variant"`, or
  `{ "model": "provider/model", "defaultVariant", "variants", "until" }`. `until` is
  an epoch-millisecond time after which the target leaves the pool. A target can be
  another pool, written `"opencode-route/<id>"`.
- `selection`: `ordered` (the default), `round-robin`, or `weighted`.
- `weights`: keyed by target; a target not listed weighs 1. In a `weighted` pool a
  weight is a relative ratio. In a `round-robin` pool it is a priority tier instead:
  equal weights rotate evenly, and a lower tier is tried only once every target above
  it has failed. In an `ordered` pool weights rank the failover order.
- `autonomy`: `fixed`, `rules`, `adaptive`, `predictive`, or `agent`. Each level
  includes the ones before it. `agent` also exposes `route_stats`, `route_usage` and
  `route_adjust` to the model.
- `health`, `budgets`, `attempts`, `hedgeAfterMs`: see routing-review, section 1.

Common changes:

- Change a member's share: edit its `weights` entry. Ordered pools rank failover by
  weight too, so a weight change there also changes the order.
- Add a member: append it to `targets`, and give it a `weights` entry if it should
  not weigh 1.
- Remove a member for good: delete it from `targets` and `weights`. For a temporary
  removal, give it an `until` instead, or use `route_adjust` skip.
- A new pool: add a new key under `model_routes`. Then point a category at
  `opencode-route/<id>` in OpenChamber (Settings → Routing).

## Provider routes: one pool of providers for every model

- A provider route is a named selection over concrete providers, declared once
  under `experimental.provider_routes` and then used like a provider in any pool:
  `"<provider-route>/<model>"`. One definition serves every model the members offer - use
  it when the same accounts should back several models (two subscriptions for one
  provider's models, say), instead of repeating the pair in a pool per model.

```jsonc
"experimental": {
  "provider_routes": {
    "openai-plan": { "providers": ["openai.alternate", "openai"], "selection": "ordered" },
  },
},
```

- `providers` is the member list, in order. `selection` is `ordered` (the default),
  `round-robin`, or `weighted` - the same modes pools use, tiered weights included.
  `weights` keys by member provider id (an unset member weighs 1) and applies the
  same way pool weights do.
- A member serves a dispatch only when it offers the model and can produce the
  target's variant - the same skip rule as a direct leaf. Health is per concrete
  provider, model, and credential, so a benched or quota-demoted member falls
  through inside the provider route's own selection; nothing is tracked per provider route.
- Members must be concrete providers: provider routes do not nest. An id that
  names a concrete provider, a pool, or `opencode-route` is dropped at load
  with a warning - references always resolve to the concrete provider.
- Decision records show the provider route as its own step (provider route id, chosen member),
  and pools label the member group `"<provider-route>/<model>"`, so a walk stays
  explainable.

## Time-of-day and temporary weights

- Inside one pool, `schedules` is a list. Each entry has `targets` (optional,
  wildcards allowed), `when`, and either `factor` (multiplies) or `weight` (replaces):

```jsonc
"schedules": [
  {
    "targets": ["deepseek/*"],
    "when": {
      "daysOfWeek": ["mon", "tue", "wed", "thu", "fri"],
      "start": "09:00",
      "end": "17:00",
      "timezone": "America/Chicago",
    },
    "factor": 0.5,
    "note": "peak hours",
  },
],
```

- Across pools: `experimental.model_route_schedules`, a list of entries with
  `providers`, `models`, `targets`, `routes` (all optional), `when`, and `factor` or
  `weight`.
- `when` fields: `daysOfWeek` (`mon`..`sun`, or 0 to 6), `daysOfMonth` (1 to 31, or
  -1 for the last day), `start` and `end` as `HH:mm` (`end` exclusive; a start after
  the end runs past midnight), `timezone` (IANA), and `from` and `until` (epoch ms).
- A temporary fact ("credits expire Friday") belongs in `route_adjust`, not in config.
  It needs approval and it expires on its own.

## Tuning and notes

```jsonc
{
  "experimental": {
    "model_route_tuning": {
      "enabled": true,
      "intervalMinutes": 15,
      "windowHours": 24,
      "notes": ["openai/gpt-6-luna: out of quota, back in 3 hours"],
    },
  },
}
```

- `enabled` (default false) turns on the automatic review of history, which lowers or
  skips targets. It lapses on its own; it does not rewrite config.
- `notes`: one line each as `match: text`, where `match` is part of provider/model.
  A text that states a return time skips the match until then.

## Applying a change

1. Read the current value and show the user the before and after.
2. Get approval for that specific change.
3. Edit only the keys the change needs. Keep the rest of the file as it was.
4. Read the file back and check each key name against this skill.
5. Verify. For a pool change, run `route_stats` with `route` set. For a visibility or
   provider change, say what should now be missing from the model picker. Routing
   patterns need at least a day of history before they show.
6. Tell the user how to undo it: the previous value, in one line.
