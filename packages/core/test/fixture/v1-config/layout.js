import * as ConfigLayoutV1_1 from "./layout";
export { ConfigLayoutV1_1 as ConfigLayoutV1 };
import { Schema } from "effect";
export const Layout = Schema.Literals(["auto", "stretch"]).annotate({ identifier: "LayoutConfig" });
