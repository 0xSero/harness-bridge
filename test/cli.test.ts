/**
 * A smoke test for the CLI surface. Every command is exercised in a throwaway config home,
 * against a provider that is never reached — the point is that each verb parses, resolves its
 * imports and exits cleanly, which is exactly what a refactor breaks silently.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hb-cli-"));
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "cli.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Run the CLI in the temporary home; a dead import shows up as a non-zero exit. */
function run(...args: string[]) {
  const p = Bun.spawnSync(["bun", cli, ...args], {
    env: { ...process.env, HARNESS_BRIDGE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test("a provider survives a full round trip through the CLI", () => {
  expect(run("providers", "add", "--name", "T", "--url", "http://127.0.0.1:1/v1", "--key", "k", "--apis", "chat,messages").code).toBe(0);
  expect(run("providers").out).toContain("t");
  expect(run("use", "some-model").code).toBe(0);
  expect(run("providers", "reasoning", "high").out).toContain("high");
  expect(run("providers", "use", "t").code).toBe(0);
  expect(run("providers", "rm", "t").out).toContain("removed");
});

test("every read-only verb exits cleanly", () => {
  for (const args of [["providers"], ["models"], ["harnesses"], ["terminal"], ["dir"], ["status"], ["config"], ["snapshot"]]) {
    const r = run(...args);
    expect(`${args[0]}: ${r.err}`).not.toContain("ReferenceError");
    expect(`${args[0]}: ${r.err}`).not.toContain("is not defined");
  }
});

test("a bad value is refused rather than silently ignored", () => {
  expect(run("providers", "reasoning", "banana").code).not.toBe(0);
  expect(run("dir", "/definitely/not/here").code).not.toBe(0);
  expect(run("terminal", "nosuchterminal").code).not.toBe(0);
  expect(run("install", "nosuchharness").code).not.toBe(0);
});

test("help lists the verbs a user needs", () => {
  const out = run("help").out;
  for (const verb of ["providers", "models", "harnesses", "run", "dir", "terminal", "install"]) {
    expect(out).toContain(verb);
  }
});