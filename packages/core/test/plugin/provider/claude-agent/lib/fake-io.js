import * as FakeIO_1 from "./fake-io";
export { FakeIO_1 as FakeIO };
export const EXECUTABLE = "/fake/bin/claude";
export function make(input) {
    return {
        spawn: input.claude.spawn,
        which: () => EXECUTABLE,
        env: () => input.env ?? {},
        sessionExists: async () => true,
        fork: input.claude.fork,
        remove: input.claude.remove,
    };
}
