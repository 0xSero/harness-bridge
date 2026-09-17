/**
 * Behaviours that would silently break a launch: dialect gating, key placement,
 * base-URL normalisation, and config round-tripping.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hb-test-"));
process.env.HARNESS_BRIDGE_HOME = home;

// core.ts captures CONFIG_DIR at module load, so the temp home must be set first —
// a static import would be hoisted above that assignment.
const core = await import("../packages/core/src/core.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("a harness is refused when the provider cannot speak its dialect", async () => {
  core.addProvider({ name: "chatonly", apiUrl: "http://127.0.0.1:1/v1", apiKey: "k", api: "chat" });
  core.selectModel("m", "chatonly");
  await expect(core.run({ harnessId: "codex" })).rejects.toThrow(/responses/);
});

test("a multi-dialect provider admits the harnesses for each of its dialects", () => {
  const p = core.addProvider({ name: "gw", apiUrl: "http://127.0.0.1:1/v1", apiKey: "k", api: "chat", apis: ["chat", "messages"] });
  const served = core.dialectsOf(p);
  expect(served).toContain("messages");
  expect(served).not.toContain("responses");
});

test("the key is passed in the environment, never in the argv", () => {
  const secret = "sk-must-not-be-an-argument";
  const plan = core.buildLaunch("claude", { endpoint: "http://127.0.0.1:8080/v1", key: secret, model: "m" });
  expect(plan.args.join(" ")).not.toContain(secret);
  expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe(secret);
  expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
});

test("codex is pointed at the Responses wire API", () => {
  const plan = core.buildLaunch("codex", { endpoint: "http://127.0.0.1:8080/v1", key: "k", model: "m", context: 4096 });
  const argv = plan.args.join(" ");
  expect(argv).toContain("model_providers.local.wire_api=responses");
  expect(argv).toContain(`model_providers.local.base_url=${"http://127.0.0.1:8080/v1"}`);
  expect(argv).toContain("model_context_window=4096");
});

test("a base URL is normalised whether or not it already ends in /v1", () => {
  expect(core.apiBases("http://h:1")).toMatchObject({ v1: "http://h:1/v1", root: "http://h:1" });
  expect(core.apiBases("http://h:1/v1/")).toMatchObject({ v1: "http://h:1/v1", root: "http://h:1" });
});

test("the config file is only readable by its owner", () => {
  core.addProvider({ name: "perms", apiUrl: "http://h:1/v1", apiKey: "k", api: "chat" });
  expect(statSync(core.CONFIG_PATH).mode & 0o777).toBe(0o600);
});

test("reasoning is only sent when a level is chosen", () => {
  const base = { endpoint: "http://h:1/v1", key: "k", model: "m" };
  const auto = core.buildLaunch("claude", { ...base, reasoning: "auto" });
  const high = core.buildLaunch("claude", { ...base, reasoning: "high" });
  expect(auto.env.MAX_THINKING_TOKENS).toBeUndefined();
  expect(high.env.MAX_THINKING_TOKENS).toBe(String(core.THINKING_TOKENS.high));
});

test("codex is told an effort, and its lowest setting is named minimal", () => {
  const base = { endpoint: "http://h:1/v1", key: "k", model: "m" };
  expect(core.buildLaunch("codex", { ...base, reasoning: "high" }).args.join(" ")).toContain("model_reasoning_effort=high");
  expect(core.buildLaunch("codex", { ...base, reasoning: "off" }).args.join(" ")).toContain("model_reasoning_effort=minimal");
  expect(core.buildLaunch("codex", { ...base, reasoning: "auto" }).args.join(" ")).not.toContain("model_reasoning_effort");
});

test("omp suppresses reasoning params unless a level is asked for", () => {
  const base = { endpoint: "http://h:1/v1", key: "k", model: "m" };
  const flagOf = (level: "auto" | "medium") => {
    core.buildLaunch("omp", { ...base, reasoning: level });
    const written = JSON.parse(readFileSync(join(core.AGENT_DIR, "omp", "models.json"), "utf8"));
    return written.providers["harness-bridge"].models[0].compat.supportsReasoningParams;
  };
  expect(flagOf("auto")).toBe(false);
  expect(flagOf("medium")).toBe(true);
});
