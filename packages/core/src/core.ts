/**
 * harness-bridge core — connect a coding harness to an inference provider.
 *
 * Nothing the user owns is edited: the endpoint, key and model travel in the launch
 * environment, so a harness keeps its own config and only this tool's selection changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

// harnesses.ts and terminals.ts hold the tables; this module is the entry point
export * from "./harnesses.ts";
export * from "./terminals.ts";
import {
  DEFAULT_ARGS, HARNESSES, INSTALLERS, THINKING_TOKENS,
  harnessById, harnessFlags, harnessInstalled, installHarness, withHarnessFlags, writePrivate,
} from "./harnesses.ts";
import type { Dialect, ReasoningLevel } from "./harnesses.ts";
import { TERMINALS, resolveTerminal, terminalInstalled } from "./terminals.ts";

export interface Provider {
  id: string;
  name: string;
  /** base URL, e.g. http://host:8080/v1 */
  apiUrl: string;
  apiKey: string;
  /** default dialect advertised by this provider */
  api: Dialect;
  /** every dialect this endpoint serves (a gateway may translate all three) */
  apis?: Dialect[];
  /** how hard harnesses should think when launched on this provider; default auto */
  reasoning?: ReasoningLevel;
}

export interface Config {
  providers: Provider[];
  selected: { provider: string | null; model: string | null };
  /** which terminal sessions open in: a terminal id, "auto", or "custom" */
  terminal?: string;
  /** the argv template used when terminal is "custom"; {command} {dir} {name} are substituted */
  terminalCommand?: string;
  /** where sessions open when no directory is given for the run */
  cwd?: string;
  /** models kept in the main view, in the order they were pinned */
  pinned?: string[];
  /** extra flags per harness, overriding DEFAULT_ARGS */
  agentArgs?: Record<string, string[]>;
}

export const CONFIG_DIR = process.env.HARNESS_BRIDGE_HOME || join(homedir(), ".config", "harness-bridge");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const AGENT_DIR = join(CONFIG_DIR, "agents");

const empty = (): Config => ({ providers: [], selected: { provider: null, model: null } });

/** Keep a model in the main view, or drop it. Pinning the same model twice is a no-op. */
export function pinModel(model: string, on = true): Config {
  const cfg = loadConfig();
  if (!on && cfg.selected.model === model) throw new Error(`${model} is the model in use; select another before unpinning it`);
  const pinned = cfg.pinned ?? [];
  cfg.pinned = on ? (pinned.includes(model) ? pinned : [...pinned, model]) : pinned.filter((m) => m !== model);
  saveConfig(cfg);
  return cfg;
}

export interface DialectProbe {
  dialect: Dialect;
  ok: boolean;
  status: number;
}

/**
 * Ask the endpoint which dialects it actually serves, with a one-token request each, and
 * record the answer. This replaces trusting whatever `--apis` said at add time: an endpoint
 * that implements `/messages` but not `/responses` is common, and a wrong guess silently
 * hides working harnesses.
 */
export async function scanDialects(providerId?: string): Promise<{ provider: Provider; probes: DialectProbe[] }> {
  const p = resolveProvider(providerId);
  const cfg = loadConfig();
  const model = (cfg.selected.provider === p.id ? cfg.selected.model : null) ?? (await listModels(p.id).catch(() => []))[0]?.id ?? "test";
  const base = apiBases(p.apiUrl).v1;
  const bodies: Record<Dialect, unknown> = {
    chat: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    messages: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    responses: { model, input: "ping", max_output_tokens: 16 },
  };
  const probes: DialectProbe[] = [];
  for (const dialect of ["chat", "messages", "responses"] as Dialect[]) {
    const path = dialect === "chat" ? "chat/completions" : dialect;
    try {
      const res = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify(bodies[dialect]),
        signal: AbortSignal.timeout(20_000),
      });
      probes.push({ dialect, ok: res.ok, status: res.status });
    } catch {
      probes.push({ dialect, ok: false, status: 0 });
    }
  }
  const served = probes.filter((d) => d.ok).map((d) => d.dialect);
  if (served.length) {
    const i = cfg.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) {
      cfg.providers[i].apis = served;
      if (cfg.selected.provider === p.id && !served.includes(cfg.providers[i].api)) cfg.providers[i].api = served[0];
      saveConfig(cfg);
    }
  }
  return { provider: p, probes };
}

/** Record the flags a harness launches with. Pass null to restore the default. */
export function setHarnessFlags(id: string, flags: string[] | null): Config {
  const cfg = loadConfig();
  if (!harnessById(id)) throw new Error(`unknown harness: ${id}`);
  const next = withHarnessFlags(cfg, id, flags);
  saveConfig(next as Config);
  return next as Config;
}

/** Record where sessions open. An empty path clears it and falls back to the shell's directory. */
export function setCwd(dir: string): Config {
  const cfg = loadConfig();
  if (dir) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
    cfg.cwd = resolve(dir);
  } else {
    delete cfg.cwd;
  }
  saveConfig(cfg);
  return cfg;
}

/** The directory a session should start in: what the caller named, else the recorded one. */
export const sessionDir = (given?: string): string => given || loadConfig().cwd || process.cwd();

/** Record which terminal sessions open in. Pass "auto" to follow the terminal in use. */
export function setTerminal(id: string, template?: string): Config {
  const cfg = loadConfig();
  cfg.terminal = id;
  if (template !== undefined) cfg.terminalCommand = template;
  saveConfig(cfg);
  return cfg;
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      providers: raw.providers ?? [],
      selected: raw.selected ?? { provider: null, model: null },
      terminal: raw.terminal,
      terminalCommand: raw.terminalCommand,
      cwd: raw.cwd,
      pinned: raw.pinned ?? [],
      agentArgs: raw.agentArgs ?? {},
    };
  } catch {
    return empty();
  }
}

export function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

export const apiBases = (base: string) => {
  const b = base.replace(/\/+$/, "");
  const root = b.replace(/\/v1$/, "");
  return { base: b, root, v1: b.endsWith("/v1") ? b : `${b}/v1` };
};

// ---------------------------------------------------------------- providers

export function addProvider(p: Partial<Provider> & { id?: string; name?: string; apiUrl: string; apiKey?: string }): Provider {
  const cfg = loadConfig();
  const id = (p.id || p.name || "provider").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const existing = cfg.providers.find((x) => x.id === id);
  // editing without retyping the key keeps the stored one
  const apiKey = p.apiKey || existing?.apiKey || "";
  if (!apiKey) throw new Error(`provider ${id} needs an api key`);
  const prov: Provider = { id, name: p.name || id, apiUrl: p.apiUrl, apiKey, api: p.api ?? "chat", apis: p.apis ?? existing?.apis, reasoning: p.reasoning ?? existing?.reasoning };
  const i = cfg.providers.findIndex((x) => x.id === id);
  if (i >= 0) cfg.providers[i] = prov;
  else cfg.providers.push(prov);
  if (!cfg.selected.provider) cfg.selected.provider = id;
  saveConfig(cfg);
  return prov;
}

export function removeProvider(id: string): boolean {
  const cfg = loadConfig();
  const before = cfg.providers.length;
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  if (cfg.selected.provider === id) cfg.selected = { provider: cfg.providers[0]?.id ?? null, model: null };
  saveConfig(cfg);
  return cfg.providers.length < before;
}

export function resolveProvider(id?: string): Provider {
  const cfg = loadConfig();
  const pid = id || cfg.selected.provider;
  const p = cfg.providers.find((x) => x.id === pid);
  if (!p) throw new Error(`no provider configured${pid ? `: ${pid}` : ""} — add one with: providers add --name <n> --url <u> --key <k>`);
  return p;
}

export function selectModel(model: string, providerId?: string): Config {
  const cfg = loadConfig();
  const p = resolveProvider(providerId);
  cfg.selected = { provider: p.id, model };
  saveConfig(cfg);
  return cfg;
}

/** the dialects an endpoint accepts; a provider without an explicit list serves its primary one */
export const dialectsOf = (p: Provider): Dialect[] => (p.apis?.length ? p.apis : [p.api]);

// ---------------------------------------------------------------- launch plan

export interface LaunchPlan {
  harness: Harness;
  /** the model this plan points at */
  model: string;
  bin: string;
  env: Record<string, string>;
  args: string[];
  files: { path: string; data: string }[];
  cwd: string;
}

export interface LaunchTarget {
  endpoint: string;
  key: string;
  model: string;
  context?: number;
  vision?: boolean;
  /** how hard to think; `auto` leaves the harness alone */
  reasoning?: ReasoningLevel;
}

/** Build the argv + environment that points one harness at one model. */
export function buildLaunch(harnessId: string, t: LaunchTarget, cwd = process.cwd()): LaunchPlan {
  const h = harnessById(harnessId);
  if (!h) throw new Error(`unknown harness: ${harnessId}`);
  const bin = harnessInstalled(h);
  if (!bin) throw new Error(`${h.label} is not installed (no \`${h.bin}\` on PATH)`);
  const { root, v1 } = apiBases(t.endpoint);
  const ctx = t.context ?? 131072;
  const think = t.reasoning ?? "auto";
  const wantsThinking = think === "low" || think === "medium" || think === "high";
  const files: LaunchPlan["files"] = [];
  let env: Record<string, string> = {};
  let args: string[] = [];

  switch (h.id) {
    case "claude":
      env = {
        ANTHROPIC_BASE_URL: root,
        ANTHROPIC_AUTH_TOKEN: t.key,
        ANTHROPIC_MODEL: t.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: t.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: t.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: t.model,
        // Claude Code does not know locally served model names; give it the real window instead
        // of letting it assume 200k and enable auto-compact early.
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(ctx),
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
        // only sent when asked for: an unset MAX_THINKING_TOKENS keeps Claude's own default
        ...(think === "auto" ? {} : { MAX_THINKING_TOKENS: String(THINKING_TOKENS[think]) }),
      };
      args = ["--model", t.model];
      break;
    case "codex":
      env = { LOCAL_AI_KEY: t.key };
      args = [
        "-c", "model_providers.local.name=Harness Bridge",
        "-c", `model_providers.local.base_url=${v1}`,
        "-c", "model_providers.local.wire_api=responses",
        "-c", "model_providers.local.env_key=LOCAL_AI_KEY",
        "-c", "model_provider=local",
        "-c", `model=${t.model}`,
        "-c", `model_context_window=${ctx}`,
        // codex calls its lowest setting "minimal", not "off"
        ...(think === "auto" ? [] : ["-c", `model_reasoning_effort=${think === "off" ? "minimal" : think}`]),
      ];
      break;
    case "opencode": {
      const cfg = {
        $schema: "https://opencode.ai/config.json",
        provider: {
          "harness-bridge": {
            npm: "@ai-sdk/openai-compatible",
            name: "Harness Bridge",
            options: { baseURL: v1, apiKey: "{env:HARNESS_BRIDGE_KEY}" },
            models: { [t.model]: { name: t.model, limit: { context: ctx, output: ctx } } },
          },
        },
      };
      env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg), HARNESS_BRIDGE_KEY: t.key };
      args = ["--model", `harness-bridge/${t.model}`];
      break;
    }
    case "pi":
    case "omp": {
      const dir = join(AGENT_DIR, h.id);
      const models = {
        providers: {
          "harness-bridge": {
            baseUrl: v1,
            apiKey: t.key,
            api: "openai-completions",
            models: [{
              id: t.model,
              name: `${t.model} · bridge`,
              contextWindow: ctx,
              input: t.vision ? ["text", "image"] : ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              // the flag suppresses reasoning params for engines that choke on them; asking
              // for a level explicitly is what turns them back on
              ...(h.id === "omp" ? { compat: { supportsReasoningParams: wantsThinking } } : {}),
            }],
          },
        },
      };
      files.push({ path: join(dir, "models.json"), data: JSON.stringify(models, null, 2) + "\n" });
      if (h.id === "omp") {
        files.push({ path: join(dir, "models.yml"), data: JSON.stringify(models, null, 2) + "\n" });
        files.push({ path: join(dir, "config.yml"), data: `modelRoles:\n  default: harness-bridge/${t.model}\nsetupVersion: 2\n` });
      }
      env = { PI_CODING_AGENT_DIR: dir, OMP_CODING_AGENT_DIR: dir };
      if (h.id === "omp") env.OMP_NO_WEBP = "1";
      args = ["--provider", "harness-bridge", "--model", t.model];
      break;
    }
    case "crush": {
      const xdg = join(AGENT_DIR, "crush");
      const cfg = {
        providers: {
          "harness-bridge": {
            type: "openai",
            name: "Harness Bridge",
            base_url: v1,
            api_key: t.key,
            models: [{ id: t.model, name: t.model, context_window: ctx, default_max_tokens: 8192, supports_attachments: !!t.vision }],
          },
        },
        models: { large: { provider: "harness-bridge", model: t.model }, small: { provider: "harness-bridge", model: t.model } },
      };
      files.push({ path: join(xdg, "crush", "crush.json"), data: JSON.stringify(cfg, null, 2) + "\n" });
      env = { XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: xdg };
      args = [];
      break;
    }
    case "copilot":
      env = { COPILOT_PROVIDER_API_KEY: t.key, COPILOT_PROVIDER_BASE_URL: v1 };
      args = ["--model", t.model];
      break;
    case "grok": {
      const dir = join(AGENT_DIR, "grok");
      const q = (s: string) => JSON.stringify(s);
      files.push({
        path: join(dir, "config.toml"),
        data:
          `[models]\ndefault = "harness-bridge"\n[features]\nremote_fetch = false\nmanaged_config = false\n` +
          `[model.harness-bridge]\nmodel = ${q(t.model)}\nname = "Harness Bridge"\nbase_url = ${q(v1)}\n` +
          `env_key = "XAI_API_KEY"\napi_backend = "chat_completions"\ncontext_window = ${ctx}\n`,
      });
      env = { GROK_HOME: dir, XAI_API_KEY: t.key };
      args = ["--model", "harness-bridge"];
      break;
    }
    default:
      // OpenAI-compatible by convention
      env = {
        OPENAI_BASE_URL: v1,
        OPENAI_API_BASE: v1,
        OPENAI_API_KEY: t.key,
        OPENAI_MODEL: t.model,
      };
      args = h.id === "aider" ? ["--model", `openai/${t.model}`] : [];
      break;
  }
  for (const f of files) writePrivate(f.path, f.data);
  return { harness: h, model: t.model, bin, env, args, files, cwd };
}

// ---------------------------------------------------------------- sessions

/** Quote only when a token needs it, so the command stays readable in a terminal's history. */
const bare = /^[A-Za-z0-9_@%+=:,./-]+$/;
const q = (v: string) => (bare.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

let cachedCli: string | undefined;

/** The installed CLI, resolved absolutely: a bundle or a menu bar app starts with a bare PATH. */
export function cliPath(): string {
  if (cachedCli) return cachedCli;
  const home = homedir();
  const candidates = [
    process.env.HARNESS_BRIDGE_BIN,
    join(home, ".bun", "bin", "harness-bridge"),
    join(home, ".local", "bin", "harness-bridge"),
    "/opt/homebrew/bin/harness-bridge",
    "/usr/local/bin/harness-bridge",
  ].filter((c): c is string => !!c);
  cachedCli = candidates.find((c) => existsSync(c)) ?? "harness-bridge";
  return cachedCli;
}

/**
 * The command a session runs. It re-enters this CLI, which builds the launch environment at run
 * time from the 0600 config — so nothing secret is ever written to a file, and a session always
 * reflects the current selection rather than one frozen when the command was composed.
 */
export const sessionCommand = (harnessId: string, dir: string, cli = cliPath()): string =>
  `${q(cli)} run --harness ${q(harnessId)} --exec --dir ${q(dir)}`;

export interface RunOptions {
  harnessId: string;
  providerId?: string;
  model?: string;
  cwd?: string;
  /** extra flags appended to the harness argv */
  extraArgs?: string[];
  /** the model's real context window, when known */
  context?: number;
  /** whether the model accepts images */
  vision?: boolean;
  /** override the provider's reasoning setting for this launch */
  reasoning?: ReasoningLevel;
  /** omit this harness's default flags (they skip its own confirmation prompts) */
  safe?: boolean;
}

export async function run(opts: RunOptions): Promise<{ plan: LaunchPlan; flags: string[] }> {
  const cfg = loadConfig();
  const provider = resolveProvider(opts.providerId);
  const model = opts.model || (cfg.selected.provider === provider.id ? cfg.selected.model : null);
  if (!model) throw new Error("no model selected — run: models, then use <model>");
  const wanted = harnessById(opts.harnessId);
  if (!wanted) throw new Error(`unknown harness: ${opts.harnessId}`);
  if (!dialectsOf(provider).includes(wanted.dialect))
    throw new Error(
      `${wanted.label} speaks ${wanted.dialect}, which ${provider.name} does not serve (${dialectsOf(provider).join(", ")})`,
    );
  const target: LaunchTarget = { endpoint: provider.apiUrl, key: provider.apiKey, model, context: opts.context, vision: opts.vision, reasoning: opts.reasoning ?? provider.reasoning };
  const plan = buildLaunch(opts.harnessId, target, opts.cwd);
  const flags = opts.safe ? [] : harnessFlags(opts.harnessId, cfg.agentArgs);
  plan.args.push(...flags, ...(opts.extraArgs ?? []));
  return { plan, flags };
}

/**
 * Write the launch script and open it in a terminal. macOS uses Terminal.app; elsewhere the
 * first installed emulator that can run a script. Shared by the CLI and the web UI so a
 * launch behaves identically either way.
 */
export function openSession(
  harnessId: string,
  dir: string,
  label: string,
): { opened: boolean; terminal: string; command: string; prepared: string[] } {
  const cfg = loadConfig();
  const term = resolveTerminal(cfg.terminal, cfg.terminalCommand);
  const session = { command: sessionCommand(harnessId, dir), dir, name: `harness-bridge ${label}` };
  const prepared = term.prepare?.(session) ?? [];
  const [cmd, ...args] = term.command(session);
  const r = spawnSync(cmd, args, { stdio: "ignore", detached: true });
  return { opened: !r.error && r.status === 0, terminal: term.id, command: session.command, prepared };
}
