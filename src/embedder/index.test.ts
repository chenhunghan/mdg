import { expect, test } from "bun:test";
import { shouldFallbackToIPC } from "./index.ts";

test("falls back to IPC on sqlite already loaded errors", () => {
  expect(shouldFallbackToIPC(new Error("SQLite already loaded"))).toBe(true);
  expect(shouldFallbackToIPC(new Error("sqlite already loaded"))).toBe(true);
  expect(shouldFallbackToIPC(new Error("some other error"))).toBe(false);
});
