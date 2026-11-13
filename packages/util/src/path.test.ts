import { describe, expect, test } from "bun:test"
import {
  comparablePath,
  containsDirectory,
  encodeFilePath,
  getDirectory,
  getFilename,
  getFilenameTruncated,
  sameDirectory,
  truncateMiddle,
} from "./path.js"

describe("client paths", () => {
  test("reads POSIX and Windows paths with the same rules", () => {
    expect(getFilename("/repo/src/index.ts")).toBe("index.ts")
    expect(getFilename("C:\\repo\\src\\index.ts\\")).toBe("index.ts")
    expect(getDirectory("/repo/src/index.ts")).toBe("/repo/src/")
    expect(getDirectory("C:\\repo\\src\\index.ts")).toBe("C:/repo/src/")
  })

  test("preserves root, UNC, mixed, and single-segment behavior", () => {
    expect(getFilename("\\\\server\\share\\file")).toBe("file")
    expect(getDirectory("\\\\server\\share\\file")).toBe("//server/share/")
    expect(getDirectory("C:\\repo/src\\file")).toBe("C:/repo/src/")
    expect(getDirectory("file")).toBe("/")
    expect(getFilename(undefined)).toBe("")
    expect(getDirectory("")).toBe("")
  })

  test.each([
    ["/repo/src/index.ts///", "index.ts"],
    ["C:\\repo\\src\\index.ts", "index.ts"],
    ["C:\\repo/src\\file", "file"],
    ["C:/repo\\src/file/\\", "file"],
    ["/", ""],
    ["\\", ""],
    ["/\\/\\", ""],
    ["C:\\", "C:"],
    ["file", "file"],
    ["", ""],
  ])("reads the filename from %j", (path, filename) => {
    expect(getFilename(path)).toBe(filename)
  })

  test("keeps filename truncation stable", () => {
    expect(getFilenameTruncated("/repo/long-component-name.tsx", 16)).toBe("long-compon….tsx")
    expect(truncateMiddle("abcdefghijklmnop", 9)).toBe("abcd…mnop")
  })

  test("getFilenameTruncated never exceeds the requested length at widths 0-2", () => {
    expect(getFilenameTruncated("/repo/long-component-name.tsx", 0)).toBe("")
    expect(getFilenameTruncated("/repo/long-component-name.tsx", -1)).toBe("")
    expect(getFilenameTruncated("/repo/long-component-name.tsx", 1)).toBe("…")
    expect(getFilenameTruncated("/repo/long-component-name.tsx", 2)).toBe("l…")
    expect(getFilenameTruncated("/repo/README", 0)).toBe("")
    expect(getFilenameTruncated("/repo/README", 1)).toBe("…")
    expect(getFilenameTruncated("/repo/README", 2)).toBe("R…")
    expect(getFilenameTruncated("/repo/a.verylongext", 1)).toBe("…")
    expect(getFilenameTruncated("/repo/a.verylongext", 2)).toBe("a…")
  })

  test("truncateMiddle never exceeds the requested length at widths 0-2", () => {
    expect(truncateMiddle("abcdefghijklmnop", 0)).toBe("")
    expect(truncateMiddle("abcdefghijklmnop", 1)).toBe("…")
    expect(truncateMiddle("abcdefghijklmnop", 2)).toBe("a…")
    expect(truncateMiddle("abcdefghijklmnop", 3)).toBe("a…p")
  })
})

describe("encodeFilePath", () => {
  const rows = [
    ["/home/user/project/README.md", "/home/user/project/README.md"],
    ["/home/user/file#name with spaces.txt", "/home/user/file%23name%20with%20spaces.txt"],
    ["/path/to/file#with?special%chars&more.txt", "/path/to/file%23with%3Fspecial%25chars%26more.txt"],
    ["/path/to/file?name.txt", "/path/to/file%3Fname.txt"],
    ["/path/to/file%name.txt", "/path/to/file%25name.txt"],
    ["/home/user/文档/README.md", "/home/user/%E6%96%87%E6%A1%A3/README.md"],
    ["/", "/"],
    ["", ""],
    ["//path//to///file.txt", "//path//to///file.txt"],
    ["src/components/App.tsx", "src/components/App.tsx"],
    ["src\\components\\App.tsx", "src/components/App.tsx"],
    ["D:\\dev\\projects\\opencode\\README.bs.md", "/D:/dev/projects/opencode/README.bs.md"],
    ["D:\\dev\\projects\\opencode/README.bs.md", "/D:/dev/projects/opencode/README.bs.md"],
    ["C:\\Program Files\\MyApp\\file with spaces.txt", "/C:/Program%20Files/MyApp/file%20with%20spaces.txt"],
    ["D:\\projects\\file#name with ?marks.txt", "/D:/projects/file%23name%20with%20%3Fmarks.txt"],
    ["C:\\", "/C:/"],
    ["c:\\users\\test\\file.txt", "/c:/users/test/file.txt"],
    ["D:", "/D:"],
    ["C:\\Users\\test\\", "/C:/Users/test/"],
    ["C:\\Users\\..\\test\\.\\file.txt", "/C:/Users/../test/./file.txt"],
    ["/D:/path/file.txt", "/D:/path/file.txt"],
  ] as const

  test.each(rows)("encodes %p as %p", (input, expected) => {
    expect(encodeFilePath(input)).toBe(expected)
  })

  test("every encoded path forms a file URL that keeps its query", () => {
    rows.forEach(([input]) => {
      const url = new URL(`file://${encodeFilePath(input)}?start=10`)
      expect(url.protocol).toBe("file:")
      expect(url.searchParams.get("start")).toBe("10")
    })
  })
})

describe("directory containment", () => {
  test("an empty parent contains nothing", () => {
    expect(containsDirectory("", "/etc/passwd")).toBe(false)
    expect(containsDirectory("", "/")).toBe(false)
    expect(containsDirectory("", "rel/path")).toBe(false)
    expect(containsDirectory("", "")).toBe(false)
  })

  test("empty-input behavior is pinned for comparablePath and sameDirectory", () => {
    expect(comparablePath("")).toBe("")
    expect(sameDirectory("", "")).toBe(false)
    expect(sameDirectory("", "/a")).toBe(false)
    expect(sameDirectory("/a", "")).toBe(false)
  })

  test.each([
    ["/", "/etc", true],
    ["/", "/", true],
    ["/a/b", "/a/b", true],
    ["/a/b", "/a/b/c", true],
    ["/a/b/", "/a/b/c", true],
    ["/a/b", "/a/bc", false],
    ["/a/b", "/a", false],
  ])("containsDirectory(%j, %j)", (parent, child, expected) => {
    expect(containsDirectory(parent, child)).toBe(expected)
  })

  test("Windows drive and UNC paths compare case-insensitively", () => {
    expect(containsDirectory("C:\\Repo", "c:/repo/src")).toBe(true)
    expect(containsDirectory("c:/repo", "C:\\REPO\\SRC")).toBe(true)
    expect(containsDirectory("C:\\Repo", "c:/repo2")).toBe(false)
    expect(containsDirectory("\\\\Server\\Share", "//server/share/dir")).toBe(true)
    expect(containsDirectory("\\\\Server\\Share", "//server/other/dir")).toBe(false)
    expect(sameDirectory("C:\\Repo\\", "c:/repo")).toBe(true)
    expect(sameDirectory("\\\\SERVER\\Share", "//server/share/")).toBe(true)
  })

  test("comparablePath normalizes trailing slashes and roots", () => {
    expect(comparablePath("/")).toBe("/")
    expect(comparablePath("/a/b/")).toBe("/a/b")
    expect(comparablePath("C:\\repo\\")).toBe("C:/repo")
    expect(comparablePath("C:")).toBe("C:/")
    expect(sameDirectory("/a/b/", "/a/b")).toBe(true)
    expect(sameDirectory("/a/b", "/a/bc")).toBe(false)
  })
})
