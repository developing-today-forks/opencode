// Fidelity corpus for the three packages/ai tool-schema translators — design #1684, phase 1 (issue #1685).
//
// ORACLE: the disposition tables in this file are the oracle (model-based testing: the tables are the
// model of each translator's intended semantics, per design #1684's contract — every keyword, in every
// translator, has exactly one named disposition: preserved, approximated (named, with direction:
// widening = the projection accepts more than the source, narrowing = it accepts less), refused, or
// known-lossy-with-issue-link). The corpus runs every table row through its translator and asserts the
// projected shape the table states. If a translator's projection for a row changes, this corpus fails
// until the table row is updated in the same change — that flip is the intended review signal.
//
// Known-lossy rows assert the CURRENT (lossy) projection and are marked with their issue: antigravity
// `const` -> #1557. When its fix lands, exactly that row flips to its conforming disposition. (The Moonshot
// `prefixItems` with `items` present row was reclassified to approximated/widening under #1933: its issue
// #1574 closed via PR #1647, which adopted the fold as the intended projection, so the stale known-lossy
// link was removed — the meta-test below guards against a known-lossy row linking a closed issue.)
//
// Recorded approximations (probed against live endpoints by the family fixes, not changed here):
// Gemini loop-cut to {} (#1585), antigravity anyOf->oneOf fold for Anthropic targets (#1550), Moonshot
// prefixItems fold when `items` is absent. `objectRoot`'s object-root forcing lives in the unexported
// tools() layer of tool-schema.ts (it drops a root-level `not: {type:"null"}` / branch-only anyOf and
// forces type:"object"); ToolSchemaProjection.moonshot itself does not apply it, so the moonshot table
// asserts the direct projection and this note records the forcing at the layer above.
import { describe, expect, test } from "bun:test"
import { convertSchema } from "../src/protocols/antigravity.js"
import { GeminiJsonSchema } from "../src/protocols/utils/gemini-json-schema.js"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema.js"

type Disposition = "preserved" | "approximated" | "refused" | "known-lossy"
type Row = {
  shape: string
  disposition: Disposition
  direction?: "widening" | "narrowing"
  issue?: string
  note?: string
  anthropic?: boolean
  input: unknown
  expected: unknown
}

// Wrap a fragment as a property schema, the shape built-in tool parameters actually take.
const P = (frag: unknown) => ({ type: "object", properties: { v: frag }, required: ["v"] })

const basic = {
  type: "string",
  description: "d",
  title: "t",
  format: "date-time",
  minLength: 1,
  maxLength: 9,
  pattern: "^a",
  default: "x",
  example: "y",
}
const unknownKw = {
  type: "string",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  contains: { type: "string" },
  if: { type: "string" },
  contentEncoding: "base64",
  $comment: "hi",
  unevaluatedProperties: false,
}
const refSchema = {
  type: "object",
  $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
  properties: { root: { $ref: "#/$defs/node" } },
}
const mutualDefs = {
  type: "object",
  $defs: {
    a: { type: "object", properties: { b: { $ref: "#/$defs/b" } } },
    b: { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
  },
  properties: { start: { $ref: "#/$defs/a" } },
}
const mutualRequired = {
  type: "object",
  $defs: {
    a: { type: "object", properties: { b: { $ref: "#/$defs/b" } }, required: ["b"] },
    b: { type: "object", properties: { a: { $ref: "#/$defs/a" } }, required: ["a"] },
  },
  properties: { start: { $ref: "#/$defs/a" } },
}
const selfRef = {
  $ref: "#/$defs/self",
  $defs: {
    self: {
      type: "object",
      properties: { me: { $ref: "#/$defs/self" }, opt: { $ref: "#/$defs/self" } },
      required: ["me"],
    },
  },
}
const objBounds = {
  type: "object",
  minProperties: 1,
  maxProperties: 4,
  properties: { a: { type: "string" } },
  patternProperties: { "^x": { type: "number" } },
  additionalProperties: { type: "boolean" },
}
const dependent = {
  type: "object",
  dependentRequired: { a: ["b"] },
  dependentSchemas: { a: { properties: { b: { type: "string" } } } },
}

export const antigravityTable: ReadonlyArray<Row> = [
  {
    shape: "scalar keywords (type/description/title/format/length/pattern/default/example)",
    disposition: "preserved",
    input: P(basic),
    expected: {
      properties: {
        v: {
          description: "d",
          title: "t",
          format: "date-time",
          minLength: 1,
          maxLength: 9,
          pattern: "^a",
          default: "x",
          example: "y",
          type: "STRING",
        },
      },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "const",
    disposition: "known-lossy",
    issue: "#1557",
    note: "const is absent from the SCHEMA_FIELDS allowlist and is dropped entirely; the fixed-value parameter goes upstream unconstrained.",
    input: P({ const: "fixed" }),
    expected: { properties: { v: {} }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "enum (typed)",
    disposition: "preserved",
    input: P({ type: "string", enum: ["a", "b"] }),
    expected: { properties: { v: { enum: ["a", "b"], type: "STRING" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "enum (untyped / mixed / nullable)",
    disposition: "preserved",
    input: P({ enum: [null, "a"] }),
    expected: { properties: { v: { enum: [null, "a"] } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "minimum/maximum",
    disposition: "preserved",
    input: P({ type: "integer", minimum: 1, maximum: 10 }),
    expected: { properties: { v: { minimum: 1, maximum: 10, type: "INTEGER" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "exclusiveMinimum/exclusiveMaximum (numeric, with minimum/maximum present)",
    disposition: "approximated",
    direction: "widening",
    note: "Exclusive bounds are dropped when the inclusive bound is present; the strict bound becomes inclusive.",
    input: P({ type: "integer", minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11 }),
    expected: { properties: { v: { minimum: 1, maximum: 10, type: "INTEGER" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "exclusiveMinimum (numeric, no minimum)",
    disposition: "approximated",
    direction: "widening",
    note: "Folded into minimum: >5 becomes >=5.",
    input: P({ type: "number", exclusiveMinimum: 5 }),
    expected: { properties: { v: { minimum: 5, type: "NUMBER" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "draft-04 boolean exclusive bounds",
    disposition: "approximated",
    direction: "widening",
    note: "Boolean exclusiveMinimum/exclusiveMaximum are ignored; the inclusive bounds ride through.",
    input: P({ type: "number", minimum: 0, exclusiveMinimum: true, maximum: 60, exclusiveMaximum: true }),
    expected: { properties: { v: { minimum: 0, maximum: 60, type: "NUMBER" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "multi-valued type",
    disposition: "preserved",
    note: "Emitted as one anyOf branch per concrete member (#1556).",
    input: P({ type: ["string", "integer"] }),
    expected: {
      properties: { v: { anyOf: [{ type: "STRING" }, { type: "INTEGER" }] } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "multi-valued type (Anthropic target)",
    disposition: "approximated",
    direction: "narrowing",
    note: "Branches fold into oneOf for Anthropic targets (#1550): exactly-one instead of at-least-one.",
    anthropic: true,
    input: P({ type: ["string", "integer"] }),
    expected: {
      properties: { v: { oneOf: [{ type: "STRING" }, { type: "INTEGER" }] } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "multi-valued type + anyOf",
    disposition: "preserved",
    note: "Type and anyOf are conjunctive in JSON Schema: the type branches ride in an allOf wrapper beside the node's own anyOf instead of flattening into it (#1926).",
    input: P({
      type: ["string", "integer"],
      anyOf: [
        { type: "string", minLength: 5 },
        { type: "integer", minimum: 10 },
      ],
    }),
    expected: {
      properties: {
        v: {
          anyOf: [
            { type: "STRING", minLength: 5 },
            { type: "INTEGER", minimum: 10 },
          ],
          allOf: [{ anyOf: [{ type: "STRING" }, { type: "INTEGER" }] }],
        },
      },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "multi-valued type + anyOf (Anthropic target)",
    disposition: "approximated",
    direction: "narrowing",
    note: "The node's anyOf folds into oneOf (#1550), and the type branches ride in an allOf wrapper as oneOf — the conjunction itself is preserved, so valid instances are no longer rejected by an exactly-one miscount (#1926).",
    anthropic: true,
    input: P({
      type: ["string", "integer"],
      anyOf: [
        { type: "string", minLength: 5 },
        { type: "integer", minimum: 10 },
      ],
    }),
    expected: {
      properties: {
        v: {
          oneOf: [
            { type: "STRING", minLength: 5 },
            { type: "INTEGER", minimum: 10 },
          ],
          allOf: [{ oneOf: [{ type: "STRING" }, { type: "INTEGER" }] }],
        },
      },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "type with null member",
    disposition: "preserved",
    note: "The null member becomes nullable:true on the concrete type.",
    input: P({ type: ["string", "null"] }),
    expected: { properties: { v: { type: "STRING", nullable: true } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "nullable keyword",
    disposition: "preserved",
    input: P({ type: "string", nullable: true }),
    expected: { properties: { v: { nullable: true, type: "STRING" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape:
      "unsupported keywords ($schema/additionalProperties/contains/if/contentEncoding/$comment/unevaluatedProperties)",
    disposition: "approximated",
    direction: "widening",
    note: "Anything outside SCHEMA_FIELDS is dropped by the allowlist, including additionalProperties:false.",
    input: P(unknownKw),
    expected: { properties: { v: { type: "STRING" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "boolean false subschema",
    disposition: "preserved",
    note: "Encoded as {not:{}} — the never schema (#1573); never inverted to {}.",
    input: P(false),
    expected: { properties: { v: { not: {} } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "boolean true subschema",
    disposition: "preserved",
    input: P(true),
    expected: { properties: { v: {} }, type: "OBJECT", required: ["v"] },
  },
  { shape: "boolean false root", disposition: "preserved", input: false, expected: { not: {} } },
  {
    shape: "not:false / not:true",
    disposition: "preserved",
    note: "not:false is unconstrained (key omitted); not:true lands as {not:{}} (#1573).",
    input: P({ not: false }),
    expected: { properties: { v: {} }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "ARRAY without items",
    disposition: "preserved",
    note: "An unconstrained items:{} is synthesized — the proto requires the field (#1548).",
    input: P({ type: "array" }),
    expected: { properties: { v: { type: "ARRAY", items: {} } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "items:false",
    disposition: "preserved",
    input: P({ type: "array", items: false }),
    expected: { properties: { v: { items: { not: {} }, type: "ARRAY" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "draft-07 tuple items array",
    disposition: "preserved",
    note: "Converted to prefixItems plus a synthesized unconstrained items.",
    input: P({ type: "array", items: [{ type: "string" }, { type: "number" }] }),
    expected: {
      properties: { v: { items: {}, prefixItems: [{ type: "STRING" }, { type: "NUMBER" }], type: "ARRAY" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "prefixItems with items",
    disposition: "preserved",
    input: P({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }),
    expected: {
      properties: { v: { items: { type: "NUMBER" }, prefixItems: [{ type: "STRING" }], type: "ARRAY" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "prefixItems without items",
    disposition: "preserved",
    input: P({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }),
    expected: {
      properties: { v: { items: {}, prefixItems: [{ type: "STRING" }, { type: "NUMBER" }], type: "ARRAY" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "items schema + minItems/maxItems",
    disposition: "preserved",
    input: P({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }),
    expected: {
      properties: { v: { minItems: 1, maxItems: 5, items: { type: "STRING" }, type: "ARRAY" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "anyOf",
    disposition: "preserved",
    input: P({ anyOf: [{ type: "string" }, { type: "number" }] }),
    expected: {
      properties: { v: { anyOf: [{ type: "STRING" }, { type: "NUMBER" }] } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "anyOf (Anthropic target)",
    disposition: "approximated",
    direction: "narrowing",
    note: "anyOf folds into oneOf for Anthropic targets (#1550).",
    anthropic: true,
    input: P({ anyOf: [{ type: "string" }, { type: "number" }] }),
    expected: {
      properties: { v: { oneOf: [{ type: "STRING" }, { type: "NUMBER" }] } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "oneOf / allOf / not",
    disposition: "preserved",
    input: P({ allOf: [{ type: "string", minLength: 2 }] }),
    expected: { properties: { v: { allOf: [{ minLength: 2, type: "STRING" }] } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "allOf-only root",
    disposition: "preserved",
    note: "No OBJECT type is forced onto a branch-only root (#1667).",
    input: { allOf: [{ type: "string" }] },
    expected: { allOf: [{ type: "STRING" }] },
  },
  {
    shape: "not-only root",
    disposition: "preserved",
    note: "No OBJECT type is forced onto a not-only root (#1667).",
    input: { not: { type: "null" } },
    expected: { not: { type: "NULL" } },
  },
  {
    shape: "$ref to $defs (recursive)",
    disposition: "approximated",
    direction: "widening",
    note: "$refs are inlined; the recursive step that would loop is cut to {} (unconstrained).",
    input: refSchema,
    expected: { properties: { root: { properties: { child: {} }, type: "OBJECT" } }, type: "OBJECT" },
  },
  {
    shape: "$ref with siblings (unresolved)",
    disposition: "approximated",
    direction: "widening",
    note: "An unresolvable $ref contributes {}; its siblings survive.",
    input: P({ $ref: "#/$defs/x", description: "keep?" }),
    expected: { properties: { v: { description: "keep?" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "definitions (draft-07) + $ref",
    disposition: "preserved",
    note: "The reference is inlined and the definitions block is consumed by the inlining.",
    input: { type: "object", definitions: { x: { type: "string" } }, properties: { v: { $ref: "#/definitions/x" } } },
    expected: { properties: { v: { type: "STRING" } }, type: "OBJECT" },
  },
  {
    shape: "mutually recursive $defs",
    disposition: "approximated",
    direction: "widening",
    note: "Defs are inlined until the cycle step, which is cut to {}.",
    input: mutualDefs,
    expected: {
      properties: { start: { properties: { b: { properties: { a: {} }, type: "OBJECT" } }, type: "OBJECT" } },
      type: "OBJECT",
    },
  },
  {
    shape: "self-referencing root $ref",
    disposition: "approximated",
    direction: "widening",
    note: "The root def is inlined; nested self-references are cut to {}.",
    input: selfRef,
    expected: { properties: { me: {}, opt: {} }, type: "OBJECT", required: ["me"] },
  },
  {
    shape: "required naming an undeclared property",
    disposition: "approximated",
    direction: "widening",
    note: "required is filtered to declared properties; the undeclared requirement is dropped.",
    input: { type: "object", properties: { a: { type: "string" } }, required: ["a", "missing"] },
    expected: { properties: { a: { type: "STRING" } }, type: "OBJECT", required: ["a"] },
  },
  {
    shape: "minProperties/maxProperties",
    disposition: "preserved",
    input: P({ type: "object", minProperties: 1, maxProperties: 4, properties: { a: { type: "string" } } }),
    expected: {
      properties: { v: { minProperties: 1, maxProperties: 4, properties: { a: { type: "STRING" } }, type: "OBJECT" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "patternProperties / additionalProperties (schema form)",
    disposition: "approximated",
    direction: "widening",
    note: "Neither rides the proto allowlist; both are dropped.",
    input: P(objBounds),
    expected: {
      properties: { v: { minProperties: 1, maxProperties: 4, properties: { a: { type: "STRING" } }, type: "OBJECT" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "dependentRequired / dependentSchemas",
    disposition: "approximated",
    direction: "widening",
    note: "Both are dropped by the allowlist.",
    input: P(dependent),
    expected: { properties: { v: { type: "OBJECT" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "unevaluatedItems",
    disposition: "approximated",
    direction: "widening",
    note: "Dropped; the ARRAY also gains its synthesized unconstrained items.",
    input: P({ type: "array", unevaluatedItems: false }),
    expected: { properties: { v: { type: "ARRAY", items: {} } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "additionalItems with tuple items",
    disposition: "approximated",
    direction: "widening",
    note: "The tuple becomes prefixItems; additionalItems is dropped.",
    input: P({ type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } }),
    expected: {
      properties: { v: { items: {}, prefixItems: [{ type: "STRING" }], type: "ARRAY" } },
      type: "OBJECT",
      required: ["v"],
    },
  },
  {
    shape: "examples (plural)",
    disposition: "preserved",
    note: "Annotation only: `examples` is dropped and the singular `example` (see the scalar row) is kept; validation semantics are unchanged either way.",
    input: P({ type: "string", examples: ["a"] }),
    expected: { properties: { v: { type: "STRING" } }, type: "OBJECT", required: ["v"] },
  },
  {
    shape: "propertyOrdering",
    disposition: "preserved",
    input: {
      type: "object",
      properties: { b: { type: "string" }, a: { type: "string" } },
      propertyOrdering: ["a", "b"],
    },
    expected: {
      properties: { b: { type: "STRING" }, a: { type: "STRING" } },
      propertyOrdering: ["a", "b"],
      type: "OBJECT",
    },
  },
]

export const geminiTable: ReadonlyArray<Row> = [
  { shape: "scalar keywords", disposition: "preserved", input: P(basic), expected: P(basic) },
  {
    shape: "const",
    disposition: "preserved",
    note: "Kept verbatim (a VALUES key) — the divergence from antigravity's #1557 drop is the point of this row.",
    input: P({ const: "fixed" }),
    expected: P({ const: "fixed" }),
  },
  {
    shape: "enum",
    disposition: "preserved",
    input: P({ type: "string", enum: ["a", "b"] }),
    expected: P({ type: "string", enum: ["a", "b"] }),
  },
  {
    shape: "numeric exclusive bounds",
    disposition: "preserved",
    input: P({ type: "integer", minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11 }),
    expected: P({ type: "integer", minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11 }),
  },
  {
    shape: "draft-04 boolean exclusive bounds",
    disposition: "preserved",
    note: "Converted to the numeric form: exclusiveMinimum:true + minimum:0 becomes exclusiveMinimum:0 and minimum is dropped (same bound).",
    input: P({ type: "number", minimum: 0, exclusiveMinimum: true, maximum: 60, exclusiveMaximum: true }),
    expected: P({ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 60 }),
  },
  {
    shape: "exclusiveMinimum:true with no minimum",
    disposition: "approximated",
    direction: "widening",
    note: "There is no bound to convert, so the keyword is dropped.",
    input: P({ type: "number", exclusiveMinimum: true }),
    expected: P({ type: "number" }),
  },
  {
    shape: "multi-valued type / null member",
    disposition: "preserved",
    input: P({ type: ["string", "null"] }),
    expected: P({ type: ["string", "null"] }),
  },
  {
    shape: "unsupported-looking keywords pass through",
    disposition: "preserved",
    note: "normalize rewrites only its named shapes and sends everything else unchanged, including additionalProperties:false and unevaluatedProperties.",
    input: P(unknownKw),
    expected: P(unknownKw),
  },
  { shape: "boolean false / true subschemas", disposition: "preserved", input: P(false), expected: P(false) },
  {
    shape: "ARRAY without items",
    disposition: "preserved",
    note: "No items is synthesized here (the divergence from antigravity's #1548 synthesis).",
    input: P({ type: "array" }),
    expected: P({ type: "array" }),
  },
  {
    shape: "draft-07 tuple items array",
    disposition: "preserved",
    note: "Converted to the 2020-12 form: items array becomes prefixItems.",
    input: P({ type: "array", items: [{ type: "string" }, { type: "number" }] }),
    expected: P({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }),
  },
  {
    shape: "additionalItems with tuple items",
    disposition: "preserved",
    note: "additionalItems becomes the trailing items alongside the converted prefixItems.",
    input: P({ type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } }),
    expected: P({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }),
  },
  {
    shape: "prefixItems with items / without items",
    disposition: "preserved",
    input: P({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }),
    expected: P({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }),
  },
  {
    shape: "items schema + minItems/maxItems",
    disposition: "preserved",
    input: P({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }),
    expected: P({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }),
  },
  {
    shape: "anyOf / oneOf / allOf / not",
    disposition: "preserved",
    input: P({ anyOf: [{ type: "string" }, { type: "number" }] }),
    expected: P({ anyOf: [{ type: "string" }, { type: "number" }] }),
  },
  {
    shape: "allOf-only / not-only root",
    disposition: "preserved",
    input: { not: { type: "null" } },
    expected: { not: { type: "null" } },
  },
  {
    shape: "$ref to $defs (optional recursion)",
    disposition: "preserved",
    note: "A loop through an optional property is safe and the $ref is kept (#1585).",
    input: refSchema,
    expected: refSchema,
  },
  {
    shape: "$ref with siblings",
    disposition: "preserved",
    input: P({ $ref: "#/$defs/x", description: "keep?" }),
    expected: P({ $ref: "#/$defs/x", description: "keep?" }),
  },
  {
    shape: "mutually recursive $defs (optional step)",
    disposition: "preserved",
    input: mutualDefs,
    expected: mutualDefs,
  },
  {
    shape: "mutually recursive $defs (all steps required)",
    disposition: "approximated",
    direction: "widening",
    note: "The cycle is cut to {} inside the defs (#1585's cutDefCycles semantics); the entry $ref survives.",
    input: mutualRequired,
    expected: {
      type: "object",
      $defs: {
        a: { type: "object", properties: { b: {} }, required: ["b"] },
        b: { type: "object", properties: { a: {} }, required: ["a"] },
      },
      properties: { start: { $ref: "#/$defs/a" } },
    },
  },
  {
    shape: "self-referencing root $ref",
    disposition: "approximated",
    direction: "widening",
    note: "The required self-step (me) is cut to {}; the optional self-step (opt) keeps its $ref (#1585).",
    input: selfRef,
    expected: {
      $ref: "#/$defs/self",
      $defs: { self: { type: "object", properties: { me: {}, opt: { $ref: "#/$defs/self" } }, required: ["me"] } },
    },
  },
  {
    shape: "root $ref to itself",
    disposition: "approximated",
    direction: "widening",
    note: "An unsafe root self-loop is cut to {}.",
    input: { $ref: "#" },
    expected: {},
  },
  {
    shape: "required naming an undeclared property",
    disposition: "approximated",
    direction: "widening",
    note: "required is filtered to declared properties.",
    input: { type: "object", properties: { a: { type: "string" } }, required: ["a", "missing"] },
    expected: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  },
  {
    shape: "object bounds + patternProperties + additionalProperties",
    disposition: "preserved",
    input: P(objBounds),
    expected: P(objBounds),
  },
  {
    shape: "dependentRequired / dependentSchemas",
    disposition: "preserved",
    input: P(dependent),
    expected: P(dependent),
  },
  {
    shape: "unevaluatedItems",
    disposition: "preserved",
    input: P({ type: "array", unevaluatedItems: false }),
    expected: P({ type: "array", unevaluatedItems: false }),
  },
  {
    shape: "examples",
    disposition: "preserved",
    input: P({ type: "string", examples: ["a"] }),
    expected: P({ type: "string", examples: ["a"] }),
  },
  {
    shape: "definitions (draft-07) + $ref",
    disposition: "preserved",
    input: { type: "object", definitions: { x: { type: "string" } }, properties: { v: { $ref: "#/definitions/x" } } },
    expected: {
      type: "object",
      definitions: { x: { type: "string" } },
      properties: { v: { $ref: "#/definitions/x" } },
    },
  },
]

export const moonshotTable: ReadonlyArray<Row> = [
  { shape: "scalar keywords", disposition: "preserved", input: P(basic), expected: P(basic) },
  { shape: "const", disposition: "preserved", input: P({ const: "fixed" }), expected: P({ const: "fixed" }) },
  {
    shape: "enum (typed)",
    disposition: "preserved",
    input: P({ type: "string", enum: ["a", "b"] }),
    expected: P({ type: "string", enum: ["a", "b"] }),
  },
  {
    shape: "enum (untyped, single inferred type)",
    disposition: "preserved",
    note: "Moonshot rejects an enum without a sibling type, so the type implied by the values is synthesized; acceptance is unchanged.",
    input: P({ enum: ["a", "b"] }),
    expected: P({ type: "string", enum: ["a", "b"] }),
  },
  {
    shape: "enum (mixed types)",
    disposition: "preserved",
    note: "No single type (or type+null) describes the values, so no type is synthesized and the enum rides alone.",
    input: P({ enum: ["a", 1] }),
    expected: P({ enum: ["a", 1] }),
  },
  {
    shape: "enum (nullable)",
    disposition: "preserved",
    note: "The synthesized type is [string, null] — one type plus null, the form Moonshot accepts.",
    input: P({ enum: [null, "a"] }),
    expected: P({ type: ["string", "null"], enum: [null, "a"] }),
  },
  {
    shape: "numeric + draft-04 boolean exclusive bounds",
    disposition: "preserved",
    note: "Both forms ride through verbatim (the divergence from Gemini's draft-04 conversion).",
    input: P({ type: "number", minimum: 0, exclusiveMinimum: true, maximum: 60, exclusiveMaximum: true }),
    expected: P({ type: "number", minimum: 0, exclusiveMinimum: true, maximum: 60, exclusiveMaximum: true }),
  },
  {
    shape: "multi-valued type / null member",
    disposition: "preserved",
    input: P({ type: ["string", "null"] }),
    expected: P({ type: ["string", "null"] }),
  },
  {
    shape: "unsupported-looking keywords pass through",
    disposition: "preserved",
    note: "Everything except the moonshotNode special cases rides through, including additionalProperties:false (unevaluatedItems is the exception — its own row below).",
    input: P({
      type: "string",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      contains: { type: "string" },
      if: { type: "string" },
      contentEncoding: "base64",
      $comment: "hi",
      unevaluatedProperties: false,
    }),
    expected: P({
      type: "string",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      contains: { type: "string" },
      if: { type: "string" },
      contentEncoding: "base64",
      $comment: "hi",
      unevaluatedProperties: false,
    }),
  },
  { shape: "boolean false / true subschemas", disposition: "preserved", input: P(false), expected: P(false) },
  {
    shape: "ARRAY without items",
    disposition: "preserved",
    input: P({ type: "array" }),
    expected: P({ type: "array" }),
  },
  {
    shape: "draft-07 tuple items array",
    disposition: "approximated",
    direction: "widening",
    note: "The tuple folds into a single items:anyOf — per-position types are lost, every position accepts either.",
    input: P({ type: "array", items: [{ type: "string" }, { type: "number" }] }),
    expected: P({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
  },
  {
    shape: "prefixItems with items present",
    disposition: "approximated",
    direction: "widening",
    note: "prefixItems is dropped as a keyword and folded with the items schema into one items:anyOf — per-position types are lost, every position accepts either. The fold is the projection #1647 adopted for Moonshot tuples; the residual loss is widening only (#1933).",
    input: P({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }),
    expected: P({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
  },
  {
    shape: "prefixItems without items",
    disposition: "approximated",
    direction: "widening",
    note: "The recorded fold: prefixItems becomes a single items:anyOf over the prefix schemas.",
    input: P({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }),
    expected: P({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
  },
  {
    shape: "items schema + minItems/maxItems",
    disposition: "preserved",
    input: P({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }),
    expected: P({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }),
  },
  {
    shape: "additionalItems with tuple items",
    disposition: "approximated",
    direction: "widening",
    note: "A one-element tuple folds to that element's schema as items; additionalItems rides through but no longer has a tuple to extend.",
    input: P({ type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } }),
    expected: P({ type: "array", items: { type: "string" }, additionalItems: { type: "number" } }),
  },
  {
    shape: "anyOf / oneOf / allOf / not",
    disposition: "preserved",
    input: P({ anyOf: [{ type: "string" }, { type: "number" }] }),
    expected: P({ anyOf: [{ type: "string" }, { type: "number" }] }),
  },
  {
    shape: "allOf-only / not-only root (direct projection)",
    disposition: "preserved",
    note: "moonshot() itself forces no object root; objectRoot forcing happens in the tools() layer above (see header).",
    input: { not: { type: "null" } },
    expected: { not: { type: "null" } },
  },
  { shape: "$ref to $defs (recursive)", disposition: "preserved", input: refSchema, expected: refSchema },
  {
    shape: "$ref with siblings",
    disposition: "approximated",
    direction: "widening",
    note: "A $ref node projects to {$ref} alone; every sibling is dropped (the sibling here is an annotation, but a validating sibling would be lost the same way).",
    input: P({ $ref: "#/$defs/x", description: "keep?" }),
    expected: P({ $ref: "#/$defs/x" }),
  },
  {
    shape: "self-referencing root $ref",
    disposition: "approximated",
    direction: "widening",
    note: "The root $ref node projects to {$ref} alone; its $defs sibling is dropped, leaving the reference unresolved in the projected schema.",
    input: selfRef,
    expected: { $ref: "#/$defs/self" },
  },
  { shape: "mutually recursive $defs", disposition: "preserved", input: mutualDefs, expected: mutualDefs },
  {
    shape: "required naming an undeclared property",
    disposition: "preserved",
    note: "required rides through verbatim, undeclared names included (the divergence from antigravity/Gemini filtering).",
    input: { type: "object", properties: { a: { type: "string" } }, required: ["a", "missing"] },
    expected: { type: "object", properties: { a: { type: "string" } }, required: ["a", "missing"] },
  },
  {
    shape: "object bounds + patternProperties + additionalProperties",
    disposition: "preserved",
    input: P(objBounds),
    expected: P(objBounds),
  },
  {
    shape: "dependentRequired / dependentSchemas",
    disposition: "preserved",
    input: P(dependent),
    expected: P(dependent),
  },
  {
    shape: "unevaluatedItems",
    disposition: "approximated",
    direction: "widening",
    note: "Explicitly dropped by moonshotNode.",
    input: P({ type: "array", unevaluatedItems: false }),
    expected: P({ type: "array" }),
  },
  {
    shape: "examples",
    disposition: "preserved",
    input: P({ type: "string", examples: ["a"] }),
    expected: P({ type: "string", examples: ["a"] }),
  },
  {
    shape: "definitions (draft-07) + $ref",
    disposition: "preserved",
    input: { type: "object", definitions: { x: { type: "string" } }, properties: { v: { $ref: "#/definitions/x" } } },
    expected: {
      type: "object",
      definitions: { x: { type: "string" } },
      properties: { v: { $ref: "#/definitions/x" } },
    },
  },
]

const translators = [
  {
    name: "antigravity convertSchema",
    table: antigravityTable,
    run: (row: Row) => convertSchema(structuredClone(row.input), row.anthropic ?? false),
  },
  {
    name: "GeminiJsonSchema.normalize",
    table: geminiTable,
    run: (row: Row) => GeminiJsonSchema.normalize(structuredClone(row.input) as never),
  },
  {
    name: "ToolSchemaProjection.moonshot",
    table: moonshotTable,
    run: (row: Row) => ToolSchemaProjection.moonshot(structuredClone(row.input) as never),
  },
] as const

describe("tool-schema fidelity corpus (oracle: the disposition tables above, design #1684)", () => {
  for (const translator of translators) {
    describe(translator.name, () => {
      for (const row of translator.table) {
        test(`${row.shape} — ${row.disposition}${row.issue ? ` (${row.issue})` : ""}`, () => {
          expect(translator.run(row)).toEqual(row.expected)
        })
      }
    })
  }

  test("every table row carries a well-formed disposition", () => {
    for (const { table } of translators) {
      for (const row of table) {
        if (row.disposition === "approximated") expect(row.direction, row.shape).toBeDefined()
        if (row.disposition === "known-lossy") expect(row.issue, row.shape).toBeDefined()
      }
    }
  })

  test("the remaining known-lossy row is present and marked", () => {
    expect(antigravityTable.find((row) => row.shape === "const")?.issue).toBe("#1557")
  })

  test("known-lossy rows cannot link a closed issue", () => {
    // #1574 closed completed on 2026-11-05 via PR #1647 while its Moonshot row
    // still pointed at it as a live known-lossy link; the row was reclassified
    // to approximated/widening under #1933. When a known-lossy row's issue
    // closes, reclassify the row (or re-link it to a live tracking issue) in
    // the same change and add the closed number here, so a stale link cannot
    // return unnoticed. The antigravity `const` row above (#1557, open) is
    // the live positive control.
    const closedIssues = new Set(["#1574"])
    for (const { table } of translators) {
      for (const row of table) {
        if (row.disposition !== "known-lossy") continue
        expect(row.issue, row.shape).toBeDefined()
        expect(closedIssues.has(row.issue ?? ""), row.shape).toBe(false)
      }
    }
  })
})
