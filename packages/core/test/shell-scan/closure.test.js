import { describe, expect, test } from "bun:test";
import { ShellScan } from "../../src/shell/scan.js";
const opaque = ['printf "unterminated'];
const contexts = [
    (source) => source,
    (source) => `${source}; printf visible`,
    (source) => `printf visible; ${source}`,
    (source) => `${source} && printf visible`,
    (source) => `printf visible || ${source}`,
    (source) => `printf "$(${source})"`,
    (source) => `X=$(${source}) printf visible`,
    (source) => `printf visible >$(${source})`,
];
describe("ShellScan recursive structural opacity", () => {
    for (const seed of opaque) {
        for (const outer of contexts) {
            for (const inner of contexts.slice(0, 5)) {
                const source = outer(inner(seed));
                test(source, () => expect(ShellScan.scan(source).kind).toBe("opaque"));
            }
        }
    }
});
describe("ShellScan quote suppression", () => {
    test.each([...opaque])("single quotes suppress active syntax: %s", (source) => {
        expect(ShellScan.scan(`printf '%s' '${source.replaceAll("'", "")}'`).kind).toBe("scanned");
    });
});
describe("ShellScan recursive parameter expansion coverage", () => {
    for (const seed of ["${COMMAND:-hidden}", "$(printf ${value:-command}) hidden"]) {
        for (const outer of contexts) {
            for (const inner of contexts.slice(0, 5)) {
                const source = outer(inner(seed));
                test(source, () => {
                    const result = ShellScan.scan(source);
                    expect(result.kind).toBe("scanned");
                    if (result.kind !== "scanned")
                        throw new Error(result.reason);
                    expect(result.commands.some((command) => command.resource === seed)).toBe(true);
                });
            }
        }
    }
});
