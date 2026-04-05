import { expect, test } from "bun:test";
import { executeGrep, formatSearchResults } from "./grep.ts";

const cwd = "/Users/chh/mdg";

test("exact grep output matches plain grep paths for explicit files", async () => {
  const result = await executeGrep({
    pattern: "Markdown Grep",
    paths: ["README.md", "CHANGELOG.md"],
    flags: ["-rn"],
    cwd,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    "README.md:1:# mdg — Markdown Grep\n" +
      "CHANGELOG.md:8:* initial implementation of mdg (Markdown Grep) ([1b04d97](https://github.com/chenhunghan/mdg/commit/1b04d970ebdaeda53c27bd0cfdf3c0e856657069))\n"
  );
});

test("exact grep output uses dot-prefixed paths for cwd searches", async () => {
  const result = await executeGrep({
    pattern: "Markdown Grep",
    paths: [],
    flags: ["-rn"],
    cwd,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("./CHANGELOG.md:8:* initial implementation of mdg (Markdown Grep)");
  expect(result.stdout).toContain("./README.md:1:# mdg — Markdown Grep");
});

test("-e patterns are not duplicated into the shell command", async () => {
  const result = await executeGrep({
    pattern: "Markdown Grep",
    paths: ["README.md"],
    flags: ["-e"],
    patternFromFlag: true,
    cwd,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("# mdg — Markdown Grep\n");
});

test("semantic formatter uses grep-like filenames without slashes", () => {
  const result = formatSearchResults(
    [
      {
        filePath: "README.md",
        content: "# mdg — Markdown Grep",
        startLine: 1,
        score: 1,
        method: "vector",
      },
    ],
    ["-n"],
    { explicitPaths: true }
  );

  expect(result.stdout).toBe("1:# mdg — Markdown Grep\n");
});
