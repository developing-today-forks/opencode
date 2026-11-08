import { ClaudeCode } from "./packages/ai/src/providers/claude-code.js"
import { Commandcode } from "./packages/ai/src/providers/commandcode.js"
import { Antigravity } from "./packages/ai/src/providers/antigravity.js"
import { MuseDirect } from "./packages/ai/src/providers/muse-direct.js"
import { Vibe } from "./packages/ai/src/providers/vibe.js"
import { ClaudeCodeMessages } from "./packages/ai/src/protocols/claude-code-messages.js"
import { CommandCode as CommandCodeProto } from "./packages/ai/src/protocols/commandcode.js"

const show = (label: string, route: any) =>
  console.log(`${label}: provider=${String(route?.provider)} metadataKey=${route?.providerMetadataKey}`)

show("claude bare provider.route", ClaudeCode.route)
show("claude protocol route", ClaudeCodeMessages.route)
show("claude configured model.route", ClaudeCode.provider.model("claude-haiku-5-5").route)
show("commandcode bare provider.route", Commandcode.route)
show("commandcode protocol route", CommandCodeProto.route)
show("commandcode configured model.route", Commandcode.provider.model("deepseek/deepseek-v4-flash").route)
show("antigravity configured model.route", Antigravity.provider.model("claude-sonnet-5-5").route)
show("muse-direct configured model.route", MuseDirect.configure({ apiKey: "x" } as any).model("muse-spark-1.3-contributor").route)
show("vibe exported route", Vibe.route)
show("vibe configured model.route", Vibe.provider.model("mistral-medium-latest").route)
console.log("ids:", ClaudeCode.id, Commandcode.id, Antigravity.id, MuseDirect.id, Vibe.id)
