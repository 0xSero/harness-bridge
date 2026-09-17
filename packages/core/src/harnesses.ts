/**
 * The harness table: what each coding agent is, which API dialect it speaks, where it comes
 * from, and whether it has a reasoning knob. This is the only place a harness is described;
 * core.ts turns a table row into a launch environment.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Dialect = "chat" | "messages" | "responses";

/**
 * How hard a harness is told to think. `auto` changes nothing — the harness and the engine
 * keep their own defaults — which is the safe setting for models whose reasoning support
 * the endpoint does not advertise.
 */
export type ReasoningLevel = "auto" | "off" | "low" | "medium" | "high";

export const REASONING_LEVELS: ReasoningLevel[] = ["auto", "off", "low", "medium", "high"];

/** Extended-thinking budgets, in tokens, for harnesses that take a number rather than a word. */
export const THINKING_TOKENS: Record<string, number> = { off: 0, low: 4096, medium: 16384, high: 32768 };

export interface Harness {
  id: string;
  label: string;
  dialect: Dialect;
  bin: string;
  /** whether this harness has a reasoning knob the bridge can set */
  reasons?: boolean;
}

/** Every harness is launched with an environment the model can be reached through. */
export const HARNESSES: Harness[] = [
  { id: "claude", label: "Claude Code", dialect: "messages", bin: "claude", reasons: true },
  { id: "codex", label: "Codex", dialect: "responses", bin: "codex", reasons: true },
  { id: "opencode", label: "OpenCode", dialect: "chat", bin: "opencode" },
  { id: "pi", label: "Pi", dialect: "chat", bin: "pi", reasons: true },
  { id: "omp", label: "OMP", dialect: "chat", bin: "omp", reasons: true },
  { id: "crush", label: "Crush", dialect: "chat", bin: "crush" },
  { id: "copilot", label: "Copilot CLI", dialect: "chat", bin: "copilot" },
  { id: "grok", label: "Grok CLI", dialect: "chat", bin: "grok" },
  { id: "aider", label: "Aider", dialect: "chat", bin: "aider" },
  { id: "hermes", label: "Hermes", dialect: "chat", bin: "hermes" },
];

export const harnessById = (id: string) => HARNESSES.find((h) => h.id === id);

const which = (bin: string): string | null => {
  // a harness installed a moment ago lands in a global bin dir that may not be on this
  // process's PATH yet, so the well-known ones are searched too
  const dirs = [
    ...(process.env.PATH ?? "").split(":"),
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, bin);
    try {
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  return null;
};

export const harnessInstalled = (h: Harness): string | null => which(h.bin);

/**
 * Flags a harness is launched with by default. These two skip the harness's own confirmation
 * prompts, which is convenient on a local endpoint and worth knowing about: the agent can then
 * edit files and run commands without asking. `args <harness>` overrides them, `--safe` omits
 * them for one launch.
 */
export const DEFAULT_ARGS: Record<string, string[]> = {
  // this build of Codex has no --yolo; the long form is its documented spelling
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  claude: ["--dangerously-skip-permissions"],
};

/** What a harness is actually launched with: the user's choice, else the default. */
export function harnessFlags(id: string, overrides?: Record<string, string[]>): string[] {
  return overrides?.[id] ?? DEFAULT_ARGS[id] ?? [];
}

/** Record extra flags for a harness, or clear them with null. */
export function withHarnessFlags(cfg: ConfigLike, id: string, flags: string[] | null): ConfigLike {
  const next = { ...(cfg.agentArgs ?? {}) };
  if (flags && flags.length) next[id] = flags;
  else delete next[id];
  return { ...cfg, agentArgs: next };
}

/** The slice of the config this module needs, so it does not depend on core's full type. */
export interface ConfigLike {
  agentArgs?: Record<string, string[]>;
}

// ---------------------------------------------------------------- installing

export interface Installer {
  /** npm and pipx packages can be installed unattended; manual means the vendor ships a binary */
  manager: "npm" | "pip" | "manual";
  pkg?: string;
  hint: string;
}

/**
 * Where each harness comes from. Only vendors' published packages are listed; harnesses that
 * ship as downloaded binaries say so instead of guessing a URL.
 */
export const INSTALLERS: Record<string, Installer> = {
  claude: { manager: "npm", pkg: "@anthropic-ai/claude-code", hint: "npm install -g @anthropic-ai/claude-code" },
  codex: { manager: "npm", pkg: "@openai/codex", hint: "npm install -g @openai/codex" },
  opencode: { manager: "npm", pkg: "opencode-ai", hint: "npm install -g opencode-ai" },
  pi: { manager: "npm", pkg: "@oh-my-pi/pi-coding-agent", hint: "npm install -g @oh-my-pi/pi-coding-agent" },
  crush: { manager: "npm", pkg: "@charmland/crush", hint: "npm install -g @charmland/crush" },
  copilot: { manager: "npm", pkg: "@github/copilot", hint: "npm install -g @github/copilot" },
  aider: { manager: "pip", pkg: "aider-chat", hint: "pipx install aider-chat — aider pins numpy==1.24.3, which will not build on Python 3.13; add --python 3.11" },
  omp: { manager: "manual", hint: "OMP ships a native binary — install it from https://oh-my-pi.dev" },
  grok: { manager: "manual", hint: "the Grok CLI ships a downloaded binary — install it from xAI" },
  hermes: { manager: "manual", hint: "install Hermes from its own repository" },
};

/** Install a harness with the vendor's package, then report the binary that appeared. */
export function installHarness(id: string): { path: string; command: string } {
  const h = harnessById(id);
  if (!h) throw new Error(`unknown harness: ${id}`);
  const already = harnessInstalled(h);
  if (already) return { path: already, command: "" };
  const inst = INSTALLERS[id];
  if (!inst || inst.manager === "manual")
    throw new Error(`${h.label} cannot be installed automatically — ${inst?.hint ?? "no installer known"}`);
  const argv =
    inst.manager === "pip"
      ? ["pipx", "install", inst.pkg!]
      : which("bun")
        ? ["bun", "add", "-g", inst.pkg!]
        : ["npm", "install", "-g", inst.pkg!];
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  if (r.error) throw new Error(`could not run ${argv.join(" ")}: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`${inst.manager === "pip" ? "pipx" : "the package manager"} failed (${argv.join(" ")} exited ${r.status}) — nothing was installed`);
  const after = harnessInstalled(h);
  if (!after) throw new Error(`\`${argv.join(" ")}\` reported success but ${h.label} is not on PATH — a new shell may be needed`);
  return { path: after, command: argv.join(" ") };
}

/** Write a file the harness reads, never world-readable. */
export function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}