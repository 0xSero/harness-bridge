/**
 * harness-bridge core — connect a coding harness to an inference provider.
 *
 * The only job: given a provider (base URL + key), discover its models, and launch a
 * harness pointed at one of those models. Nothing the user owns is edited: the endpoint,
 * key and model travel in the launch environment, so the harness keeps its own config and
 * only the *selected model* of this tool changes.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

export type Dialect = "chat" | "messages" | "responses";

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
}

export interface Config {
  providers: Provider[];
  selected: { provider: string | null; model: string | null };
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  vision?: boolean;
}

export const CONFIG_DIR = process.env.HARNESS_BRIDGE_HOME || join(homedir(), ".config", "harness-bridge");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const AGENT_DIR = join(CONFIG_DIR, "agents");

const empty = (): Config => ({ providers: [], selected: { provider: null, model: null } });

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { providers: raw.providers ?? [], selected: raw.selected ?? { provider: null, model: null } };
  } catch {
    return empty();
  }
}

export function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

/** write a file the harness reads, never world-readable */
export function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const apiBases = (base: string) => {
  const b = base.replace(/\/+$/, "");
  const root = b.replace(/\/v1$/, "");
  return { base: b, root, v1: b.endsWith("/v1") ? b : `${b}/v1` };
};

// ---------------------------------------------------------------- providers

export function addProvider(p: Partial<Provider> & { id?: string; name?: string; apiUrl: string; apiKey: string }): Provider {
  const cfg = loadConfig();
  const id = (p.id || p.name || "provider").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const prov: Provider = { id, name: p.name || id, apiUrl: p.apiUrl, apiKey: p.apiKey, api: p.api ?? "chat", apis: p.apis };
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

// ---------------------------------------------------------------- models

export async function listModels(providerId?: string): Promise<ModelInfo[]> {
  const p = resolveProvider(providerId);
  const res = await fetch(`${apiBases(p.apiUrl).v1}/models`, {
    headers: { Authorization: `Bearer ${p.apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`models: ${res.status} ${res.statusText}`);
  const body: unknown = await res.json();
  let rows: unknown[] = [];
  if (Array.isArray(body)) rows = body;
  else if (body && typeof body === "object" && "data" in body && Array.isArray(body.data)) rows = body.data;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined); // 3+ call sites
  const num = (v: unknown) => (typeof v === "number" ? v : undefined); // 3+ call sites
  const out: ModelInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = ("id" in row ? str(row.id) : undefined) ?? ("name" in row ? str(row.name) : undefined);
    if (!id) continue;
    const arch = "architecture" in row && row.architecture && typeof row.architecture === "object" ? row.architecture : null;
    const modalities = arch && "input_modalities" in arch && Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    const top = "top_provider" in row && row.top_provider && typeof row.top_provider === "object" ? row.top_provider : null;
    out.push({
      id,
      name: ("name" in row ? str(row.name) : undefined) ?? id,
      contextWindow:
        num("context_window" in row ? row.context_window : undefined) ??
        num("context_length" in row ? row.context_length : undefined) ??
        num("max_model_len" in row ? row.max_model_len : undefined) ??
        num(top && "context_length" in top ? top.context_length : undefined),
      vision: "vision" in row && typeof row.vision === "boolean" ? row.vision : modalities.includes("image"),
    });
  }
  return out;
}

// ---------------------------------------------------------------- harnesses

export interface Harness {
  id: string;
  label: string;
  dialect: Dialect;
  bin: string;
}

/** Every harness is launched with an environment the model can be reached through. */
export const HARNESSES: Harness[] = [
  { id: "claude", label: "Claude Code", dialect: "messages", bin: "claude" },
  { id: "codex", label: "Codex", dialect: "responses", bin: "codex" },
  { id: "opencode", label: "OpenCode", dialect: "chat", bin: "opencode" },
  { id: "pi", label: "Pi", dialect: "chat", bin: "pi" },
  { id: "omp", label: "OMP", dialect: "chat", bin: "omp" },
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
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
};

export const harnessInstalled = (h: Harness): string | null => which(h.bin);

/** which harnesses can speak to a provider serving these dialects */
export const compatible = (dialects: Dialect[]) => HARNESSES.filter((h) => dialects.includes(h.dialect));

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
  aider: { manager: "pip", pkg: "aider-chat", hint: "pipx install aider-chat" },
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
  if (!inst || inst.manager === "manual") throw new Error(`${h.label} cannot be installed automatically — ${inst?.hint ?? "no installer known"}`);
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

/** the dialects an endpoint accepts; a provider without an explicit list serves its primary one */
export const dialectsOf = (p: Provider): Dialect[] => (p.apis?.length ? p.apis : [p.api]);

// ---------------------------------------------------------------- launch plan

export interface LaunchPlan {
  harness: Harness;
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
}

/** Build the argv + environment that points one harness at one model. */
export function buildLaunch(harnessId: string, t: LaunchTarget, cwd = process.cwd()): LaunchPlan {
  const h = harnessById(harnessId);
  if (!h) throw new Error(`unknown harness: ${harnessId}`);
  const bin = harnessInstalled(h);
  if (!bin) throw new Error(`${h.label} is not installed (no \`${h.bin}\` on PATH)`);
  const { root, v1 } = apiBases(t.endpoint);
  const ctx = t.context ?? 131072;
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
              ...(h.id === "omp" ? { compat: { supportsReasoningParams: false } } : {}),
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
  return { harness: h, bin, env, args, files, cwd };
}

// ---------------------------------------------------------------- run

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Render a plan as a shell script that opens the harness in a terminal. */
export function planToScript(plan: LaunchPlan, { keepOpen = false } = {}): string {
  const env = Object.entries(plan.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("\n");
  const argv = [plan.bin, ...plan.args].map(shellQuote).join(" ");
  const tail = keepOpen ? `\nprintf '\\n[harness-bridge] %s exited. Press enter to close.\\n' "$?"\nread -r _` : "";
  return `#!/usr/bin/env bash\ncd ${shellQuote(plan.cwd)} || exit 1\n${env}\nexec ${argv}${tail}\n`;
}

export interface RunOptions {
  harnessId: string;
  providerId?: string;
  model?: string;
  cwd?: string;
  /** print the resolved command instead of launching a terminal */
  foreground?: boolean;
  /** extra flags appended to the harness argv */
  extraArgs?: string[];
  /** the model's real context window, when known */
  context?: number;
  /** whether the model accepts images */
  vision?: boolean;
}

export async function run(opts: RunOptions): Promise<{ plan: LaunchPlan; script: string; launched: boolean }> {
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
  if (opts.model && opts.model !== cfg.selected.model) selectModel(opts.model, provider.id);
  const target: LaunchTarget = { endpoint: provider.apiUrl, key: provider.apiKey, model, context: opts.context, vision: opts.vision };
  const plan = buildLaunch(opts.harnessId, target, opts.cwd);
  if (opts.extraArgs?.length) plan.args.push(...opts.extraArgs);
  const script = planToScript(plan, { keepOpen: !opts.foreground });
  return { plan, script, launched: false };
}

export function dialectNote(provider: Provider): Dialect {
  return provider.api;
}

/**
 * Write the launch script and open it in a terminal. macOS uses Terminal.app; elsewhere the
 * first installed emulator that can run a script. Shared by the CLI and the web UI so a
 * launch behaves identically either way.
 */
export function openScriptInTerminal(script: string, label: string): { opened: boolean; path: string } {
  const dir = join(AGENT_DIR, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${label.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.sh`);
  writePrivate(path, script);
  chmodSync(path, 0o700);
  if (process.platform === "darwin") {
    return { opened: spawnSync("open", ["-a", "Terminal", path], { stdio: "ignore" }).status === 0, path };
  }
  for (const term of ["kgx", "gnome-terminal", "konsole", "kitty", "alacritty", "x-terminal-emulator", "xterm"]) {
    if (spawnSync("bash", ["-lc", `command -v ${term}`], { stdio: "ignore" }).status !== 0) continue;
    const r = spawnSync(term, ["-e", "bash", path], { detached: true, stdio: "ignore" });
    if (!r.error) return { opened: true, path };
  }
  return { opened: false, path };
}