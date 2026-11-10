export * as SessionError from "./session-error.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export interface Error extends Schema.Schema.Type<typeof Error> {}
export const Error = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })).pipe(optional),
  // The provider / model that served the failed request, when known
  // (code#7073 step 4): a session outcome must name what failed, not only how —
  // before this, those facts existed only in route_attempt rows.
  provider: Schema.String.pipe(optional),
  model: Schema.String.pipe(optional),
  response: Schema.Struct({ body: Schema.String }).pipe(optional),
}).annotate({ identifier: "Session.StructuredError" })
