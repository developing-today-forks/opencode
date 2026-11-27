import * as ConfigFormatterV1_1 from "./formatter";
export { ConfigFormatterV1_1 as ConfigFormatterV1 };
import { Schema } from "effect";
export const Entry = Schema.Struct({
    disabled: Schema.optional(Schema.Boolean),
    command: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    extensions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
});
export const Info = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Entry)]);
