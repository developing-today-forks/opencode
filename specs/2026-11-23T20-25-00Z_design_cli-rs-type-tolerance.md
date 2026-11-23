# cli-rs generated types: tolerance for leaner wire payloads (`sections`, `models`) — design

- Status: draft — decision record for the owners' call; no implementation by this record
- Date: 2026-11-23
- Roadmap item: none
- Issues: [#2770](https://github.com/developing-today-forks/opencode/issues/2770) (this record)
- Scope of this document: design/decision only. No generator, generated type, runtime, or client code is changed by this record.

## 1. Intent

Found during the #2733/#2738 landing (PR #2768) and corroborated by Lane TO's
independent verification on #2733 (comment 7104002680).

The current-main regeneration made two previously unmodelled payloads strict:

- `ConfigUpdatedData` was `crate::de::NotNull` (any non-null data); it is now a
  struct requiring `sections: Vec<String>`, matching packages/core's
  `UpdatedData = Schema.Struct({ sections: Array(String) })`. The recorded
  F.7 parity fixture and the TS client's own `solid-refresh.test.ts` carry
  `config.updated` with `data: {}`, and TS core consumers guard with
  `Schema.is(UpdatedData)` rather than requiring the field.
- `ProviderInfoWithModels.models` is required (schema-required); provider
  payloads without `models` no longer decode.

PR #2768 adapted the in-repo fixtures to the current contract (empty
`sections` / `models`), which is right for a client built against the current
server. What is left is a policy question: should the generated Rust types
tolerate a payload from an older or leaner server that omits these
now-required fields (for example generator-emitted defaults for
`sections`/`models`), or is strictness the intended posture — in which case
the parity fixture's `data: {}` shape is simply a legacy recording?

This issue does not block #2733/#2738: their acceptance (generate completes
end to end; workspace suites at the pristine-main baseline) is met without a
decision here.

## 2. Current behaviour (verified)

All points below were established first-hand by Lane ZX (comment 7106930497)
and Lane OA12 (comment 7108613407) via read-only GitHub API file reads at
current main; no claim here depends on a local checkout.

### 2.1 Generated Rust types are strict about missing required fields

- `ConfigUpdatedData` in `packages/cli-rs/crates/api-types/src/types.rs` is a
  struct with `pub sections: Vec<String>` and **no** `#[serde(default)]` on
  the field. A `config.updated` payload with `data: {}` fails to decode
  (`missing field sections`). The struct derives `Default`, but serde does not
  consult that impl per field without the attribute.
- `ProviderInfoWithModels.models` is `Vec<ModelInfo>`, likewise with no
  `#[serde(default)]`; the struct does not derive `Default`. A provider
  payload without `models` fails to decode.
- Unknown or misshapen **extra** fields are already tolerated:
  `deny_unknown_fields` appears 0 times in the 15,947-line generated
  `types.rs`. The strictness axis is missing required fields (and wrong
  types), not unknown keys.

### 2.2 The generator has no required-collection default today

- The generator never emits a default for a required collection anywhere in
  the file: all 11 plain `#[serde(default)]` fields are `Option`-typed, and
  there are zero `Vec::is_empty` defaults.
- `packages/cli-rs/script/gen/api.ts` only collects schema roots and delegates
  emission to `packages/cli-rs/script/rust/types.ts` (the `Types` class).
  - `field(r, optional, hint)` (lines ~254-297): `optional` → `Option<T>` +
    `#[serde(default)]` (+ `skip_serializing_if`); `nullable` → `Option<T>` +
    `#[serde(default)]`; optional+nullable → `Option<Option<T>>` + default +
    `de::double_option`; a **required** field returns
    `{ type: inner, attrs: [] }` — no default, ever, regardless of whether the
    type is a collection.
  - `objects()` (lines ~212-250) adds `#[serde(default)]` only via those
    per-field attrs; it derives `Default` for the struct when every field type
    `isDefault` (Vec qualifies, line ~87) — which is why `ConfigUpdatedData`
    derives `Default` yet serde still rejects a missing `sections`.
- Consequence: generator-emitted defaults for required collections would be a
  new branch in `field()` (required + collection/map → `#[serde(default)]`),
  changing every generated required `Vec`/`IndexMap` field in the 15,947-line
  `types.rs`, not just the two named here.

### 2.3 Existing tolerance is hand-written, not generated

The codebase's existing tolerance posture lives in hand-written helpers in
`packages/cli-rs/crates/api-types/src/de.rs` — `NotNull` (any non-null value,
defaulting to `{}`, which is what `ConfigUpdatedData` was before the
regeneration), `double_option`, and the `well_formed` surrogate-repair pass.
Tolerance has historically been added per-type at the hand-written layer,
never as a blanket generator policy.

### 2.4 The TypeScript side already tolerates lean payloads

- Producer: the current server always sends `sections`.
  `packages/core/src/config.ts` (~line 501) publishes `Event.Updated` with
  `sections: unattributed ? [...sections, UNATTRIBUTED_SECTION] : sections` —
  an array is always present in payloads the current server emits. Omission
  can only come from an older or leaner server, or a hand-made recording.
- Consumer posture is guard-and-skip, not require-and-crash: `reloadsSections`
  in the same file (lines ~43-49) checks `Schema.is(UpdatedData)` where
  `const UpdatedData = Schema.Struct({ sections: Schema.Array(Schema.String) })`
  (line 49); a payload failing the guard (e.g. `data: {}`) returns `false` —
  "touches none of the given keys" — a soft no-op.
- The TS client test `packages/client/test/solid-refresh.test.ts` line 38
  constructs `{ type: "config.updated", data: {} }` and dispatches it through
  the client's event listeners; the event layer carries `data` untyped
  (`OpenCodeEvent`), and refresh decisions happen through guards like the
  above. So on the TS side a lean payload is a normal, tolerated input; the
  strictness is new and Rust-only.

### 2.5 Rust blast radius

- The two known breakers: `ConfigUpdatedData.sections` (event decode — a lean
  `config.updated` event fails to decode where the pre-regeneration
  `crate::de::NotNull` accepted any non-null data) and
  `ProviderInfoWithModels.models` (provider payloads without `models` fail).
- Unknown extra fields already decode fine (§2.1), so the break is narrow:
  only payloads that *omit* one of these two required fields.

## 3. Options

### A. Strict as intended

Treat the current generated types as the intended posture and the F.7
`data: {}` fixture as a legacy recording. Keep PR #2768's fixture adaptation.

- What it does: no code change. A lean/older payload fails to decode.
- Cost: a Rust client pointed at an older or leaner server cannot decode
  `config.updated` without `sections` or a provider payload without `models`.
  The TS side would have tolerated the same payload.
- Benefit: the generated type matches the current wire contract exactly; no
  new generator policy.

### B. Generator-emitted defaults for required collections

Add a generator branch: a required collection/map field emits
`#[serde(default)]` (empty collection) in addition to its type.

- What it does: every required `Vec`/`IndexMap` field in the generated surface
  decodes as empty when absent.
- Cost: broadest blast radius — one generator change alters every required
  collection field in the 15,947-line `types.rs`. It also blurs the
  absent-vs-empty distinction for every collection in the API, not just the
  two named, and it is a new generator policy with no existing precedent
  (§2.2).
- Benefit: uniform, mechanical tolerance; no per-type hand maintenance.

### C. Targeted `de.rs`-style tolerance for exactly the two named fields

Apply `#[serde(default)]` narrowly to `ConfigUpdatedData.sections` and
`ProviderInfoWithModels.models` — through the generator's per-type mechanisms
or a hand-written wrapper — following the `de.rs` precedent, and add a
regression test that a payload omitting each field decodes (to an empty
collection) while the current-server payloads still decode unchanged.

- What it does: restores exactly the tolerance that existed before the
  regeneration (`ConfigUpdatedData` accepted any non-null data; the provider
  models list was previously unmodelled) for the two fields that regressed,
  and nothing else.
- Cost: small, local exception to "generated types mirror the schema"; needs a
  comment stating why the exception exists and a test pinning it. A
  hand-written wrapper must survive regeneration.
- Benefit: smallest blast radius; matches the codebase's existing
  hand-written-tolerance precedent; keeps the strictness everywhere else,
  including on the TS side's meaning of "absent vs empty" for every other
  collection.

## 4. Recommendation

**Option C — targeted `de.rs`-style tolerance for exactly the two named
fields** (`ConfigUpdatedData.sections`, `ProviderInfoWithModels.models`).

Reasoning:

1. The regression is narrow: only these two payloads changed from tolerated to
   strict, and only for *missing* required fields (§2.1, §2.5). Unknown extra
   fields already decode, so the strictness axis does not need a general fix.
2. Option B's blast radius (every required collection in the generated
   surface) is out of proportion to a two-field regression, and it is a new
   generator policy with no precedent (§2.2).
3. Option C matches the codebase's established pattern: tolerance is added
   per-type in the hand-written `de.rs` layer (`NotNull`, `double_option`,
   `well_formed`), not as a blanket generator rule (§2.3). It restores exactly
   the tolerance that existed before the regeneration and leaves every other
   generated type as strict as it is today.
4. The TS side already treats a lean payload as a normal, tolerated input
   (§2.4); Option C brings the Rust client to the same posture for exactly the
   fields where the TS side tolerates omission.

Option A is defensible if the owners decide the wire contract is "sections and
models are always present from a current server", but it leaves the Rust
client stricter than the TS client for the same events and re-breaks decoding
against any older or leaner server. That is a product/contract call, which is
why this record stops at the recommendation and leaves the decision open.

## 5. Alternatives considered

- **Do nothing and document only** (Option A): simplest, but the asymmetry
  with the TS client and the older-server decode failure remain.
- **Make the two schema fields optional in the source schemas** (a variant of
  C that stays inside the generator's existing vocabulary): makes the fields
  `Option<Vec<_>>`, which changes the wire contract's meaning (absent vs
  empty) for every consumer, including TS, and pushes `null`/absent handling
  into every caller. Rejected as broader than the regression.
- **Option B (generator defaults for required collections)**: rejected as
  disproportionate blast radius and a new policy (§3 B).

## 6. Consequences

- Option C (recommended): a lean or older `config.updated` / provider payload
  decodes in Rust with an empty `sections` / `models`; current-server payloads
  are unchanged; every other generated type keeps its current strictness. The
  exception must be commented and pinned by a test, and must be re-applied if
  the registry of hand-written tolerance changes.
- The parity fixture stays as PR #2768 left it (`data: {"sections": []}`),
  since a current client should still emit the current contract.
- No migration is needed for current-server clients under any option.

## 7. Open questions

- **Owners' call:** adopt Option A (strict-as-intended) or Option C
  (targeted tolerance)? Settled by the maintainers on #2770; this record
  recommends C.
- If C is adopted: implement the exception via a generator mechanism or a
  hand-written wrapper in `de.rs`? Settled at implementation time, following
  whichever survives regeneration cleanly.
- Does any other generated required collection field have a recorded
  lean-payload precedent beyond the two named here? Not found in this
  investigation; a broader survey would be a separate task if the owners want
  Option B later.
