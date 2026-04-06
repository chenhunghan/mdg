import { expect, test } from "bun:test";
import { hasCurrentEmbedServerScript } from "./sidecar.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cliPath = "/Users/chh/mdg/src/cli/index.ts";

test("embed server shuts down by closing readline", () => {
  const script = `#!/usr/bin/env bun
// mdg embed-server — IPC embedding service
// version: 2
const rl = createInterface({ input: process.stdin });
rl.on("close", () => {
  process.exit(0);
});
`;

  expect(hasCurrentEmbedServerScript(script)).toBe(true);
  expect(script).toContain("rl.on(\"close\", () => {");
  expect(script).toContain("process.exit(0);");
});

test("embed server version marker is required", () => {
  expect(hasCurrentEmbedServerScript("#!/usr/bin/env bun\n// mdg embed-server — IPC embedding service\n")).toBe(false);
});

test("mdg grep auto-refreshes a stale sidecar", () => {
  const home = "/tmp/mdg-sidecar-auto-home";
  const fixture = "/tmp/mdg-sidecar-auto-fixture";

  rmSync(home, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "README.md"), "UniqueRecPrefixToken\n");

  const env = { ...process.env, HOME: home };

  const setup = Bun.spawnSync(["bun", cliPath, "setup"], {
    cwd: "/Users/chh/mdg",
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(setup.exitCode).toBe(0);

  const scriptPath = join(home, ".mdg", "embed-server.js");
  const staleScript = readFileSync(scriptPath, "utf8").replace("version: 2", "version: 1");
  writeFileSync(scriptPath, staleScript);
  expect(hasCurrentEmbedServerScript(readFileSync(scriptPath, "utf8"))).toBe(false);

  const grep = Bun.spawnSync(["bun", cliPath, "grep", "-c", "UniqueRecPrefixToken", "README.md"], {
    cwd: fixture,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(grep.exitCode).toBe(0);
  expect(grep.stdout.toString()).toBe("1\n");
  expect(hasCurrentEmbedServerScript(readFileSync(scriptPath, "utf8"))).toBe(true);
});
