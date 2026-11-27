import * as ConfigSkillsV1_1 from "./skills";
export { ConfigSkillsV1_1 as ConfigSkillsV1 };
import { Schema } from "effect";
export const Info = Schema.Struct({
    paths: Schema.optional(Schema.Array(Schema.String)).annotate({
        description: "Additional paths to skill folders",
    }),
    urls: Schema.optional(Schema.Array(Schema.String)).annotate({
        description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
    }),
});
