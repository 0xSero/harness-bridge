#!/usr/bin/env bun
/**
 * harness-bridge CLI — a thin shell over @harness-bridge/core.
 * Configuration, model discovery, selection, and launching a harness on a model.
 */
import {
  CONFIG_PATH, HARNESSES, REASONING_LEVELS, TERMINALS,
  addProvider, buildLaunch, dialectsOf, harnessById, harnessInstalled, installHarness,
  listModels, loadConfig, openSession, removeProvider, resolveProvider, resolveTerminal,
  run, saveConfig, selectModel, sessionDir, setCwd, setTerminal, snapshot, terminalInstalled,
} from "@harness-bridge/core";
import type { ReasoningLevel } from "@harness-bridge/core";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
// escape codes are for a person at a terminal: a menu, a pipe or a log gets plain text
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const die = (m: string): never => {
  console.error(`harness-bridge: ${m}`);
  process.exit(1);
};

function flag(name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

/** boolean flags carry no value */
const has = (name: string) => argv.includes(`--${name}`);

/** a reasoning level, rejected loudly rather than silently ignored */
function parseReasoning(raw: string | undefined): ReasoningLevel {
  if (REASONING_LEVELS.includes(raw as ReasoningLevel)) return raw as ReasoningLevel;
  return die(`reasoning ${raw ?? ""}: one of ${REASONING_LEVELS.join(", ")}`);
}

function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break; // everything after belongs to the wrapped harness
    if (a.startsWith("--")) {
      if (!a.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const usage = `harness-bridge — launch a coding harness on any OpenAI/Anthropic-compatible endpoint

  providers | providers add --name N --url U --key K [--apis chat,messages] [--reasoning <level>]
  providers rm <id> | providers use <id> | providers reasoning <level> [provider]
  models [provider]                  list live models
  use <model> [provider]             select a model (only the selection is persisted)
  harnesses [provider]               what is installed, and what this endpoint can drive
  install <harness>                  install a harness so it can be launched
  run [model] [harness]              open a session; --print | --exec | --no-install
                                     --provider <id> | --dir <path> | -- <harness flags>
  dir [path]                         where sessions open (default: this shell's directory)
  terminal [id|auto|custom] --command "<t>"   which terminal sessions open in
  snapshot [--json] | status         the whole state, or the one-line summary
  config                             path to the config file
`;

const cmd = positional()[0];
const args = positional().slice(1);

async function main() {
  switch (cmd) {
    case "providers": {
      const cfg = loadConfig();
      if (args[0] === "add") {
        const url = flag("url") ?? die("providers add needs --url");
        const key = flag("key") ?? die("providers add needs --key");
        const api = (flag("api") ?? "chat") as "chat" | "messages" | "responses";
        const apis = flag("apis")?.split(",").map((s) => s.trim()) as ("chat" | "messages" | "responses")[] | undefined;
        const reasoning = parseReasoning(flag("reasoning") ?? "auto");
        const p = addProvider({ name: flag("name"), id: flag("id"), apiUrl: url, apiKey: key, api, apis, reasoning });
        console.log(`added ${bold(p.id)}  ${dim(p.apiUrl)}  ${dim(p.api)}`);
        return;
      }
      if (args[0] === "rm" || args[0] === "remove") {
        const id = args[1] ?? die("providers rm <id>");
        console.log(removeProvider(id) ? `removed ${id}` : die(`no provider ${id}`));
        return;
      }
      if (args[0] === "reasoning") {
        const p = resolveProvider(args[2]);
        const level = parseReasoning(args[1]);
        addProvider({ ...p, reasoning: level });
        console.log(`${bold(p.id)} reasoning: ${bold(level)}`);
        return;
      }
      if (args[0] === "use") {
        const p = resolveProvider(args[1] ?? die("providers use <id>"));
        const next = loadConfig();
        next.selected = { provider: p.id, model: null };
        saveConfig(next);
        console.log(`using ${bold(p.id)} — run \`models\` to pick a model`);
        return;
      }
      if (!cfg.providers.length) return console.log(dim("no providers — providers add --name … --url … --key …"));
      for (const p of cfg.providers) {
        const sel = cfg.selected.provider === p.id ? bold("*") : " ";
        console.log(`${sel} ${bold(p.id.padEnd(14))} ${p.apiUrl.padEnd(42)} ${dim(p.api)}`);
      }
      return;
    }

    case "models": {
      const provider = resolveProvider(args[0]);
      const models = await listModels(provider.id);
      const sel = loadConfig().selected;
      for (const m of models) {
        const mark = sel.model === m.id && sel.provider === provider.id ? bold("→") : " ";
        const meta = [m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : "", m.vision ? "vision" : ""].filter(Boolean).join(" ");
        console.log(`${mark} ${m.id.padEnd(44)} ${dim(meta)}`);
      }
      console.log(dim(`\n${models.length} models from ${provider.name}`));
      return;
    }

    case "use": {
      const model = args[0] ?? die("use <model> [provider]");
      const cfg = selectModel(model, args[1]);
      console.log(`selected ${bold(cfg.selected.model)} on ${bold(cfg.selected.provider!)}`);
      return;
    }

    case "harnesses": {
      const provider = resolveProvider(args[0]);
      const served = dialectsOf(provider);
      for (const h of HARNESSES) {
        const bin = harnessInstalled(h);
        const live = served.includes(h.dialect);
        console.log(`${bin ? bold("●") : dim("○")} ${h.id.padEnd(10)} ${h.label.padEnd(14)} ${dim(h.dialect)}${live ? "" : dim("  (not served by this provider)")}`);
      }
      return;
    }

    case "run": {
      const model = args[0];
      const harnessId = args[1] ?? flag("harness") ?? "claude";
      const extra = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
      if (has("print")) {
        const cfg = loadConfig();
        const provider = resolveProvider(flag("provider"));
        const h = harnessById(harnessId) ?? die(`unknown harness: ${harnessId}`);
        if (!dialectsOf(provider).includes(h.dialect))
          die(`${h.label} speaks ${h.dialect}, which ${provider.name} does not serve (${dialectsOf(provider).join(", ")})`);
        const m = model ?? cfg.selected.model ?? die("run <model> [harness]");
        const plan = buildLaunch(
          harnessId,
          { endpoint: provider.apiUrl, key: provider.apiKey, model: m, reasoning: provider.reasoning, ...(await modelTraits(m)) },
          flag("dir") ?? process.cwd(),
        );
        console.log([plan.bin, ...plan.args, ...extra].join(" "));
        const secret = /(_KEY|_TOKEN|^KEY|^TOKEN|APIKEY)$/;
        for (const [k, v] of Object.entries(plan.env)) console.log(dim(`${k}=${secret.test(k) ? "…" : v}`));
        return;
      }
      // a missing harness is installed, then launched — unless --no-install says otherwise
      const target = harnessById(harnessId) ?? die(`unknown harness: ${harnessId}`);
      if (!harnessInstalled(target)) {
        if (has("no-install")) die(`${target.label} is not installed (run: harness-bridge install ${target.id})`);
        console.log(`installing ${bold(target.label)}…`);
        const { command } = installHarness(target.id);
        console.log(dim(`installed with ${command}`));
      }
      const cwd = sessionDir(flag("dir"));
      const res = await run({ harnessId, model, providerId: flag("provider"), cwd, extraArgs: extra, ...(await modelTraits(model)) });
      if (has("exec")) {
        // run the harness here and now, with the same environment a terminal launch would get
        const r = spawnSync(res.plan.bin, res.plan.args, { stdio: "inherit", env: { ...process.env, ...res.plan.env }, cwd: res.plan.cwd });
        process.exit(r.status ?? 0);
      }
      console.log(`launching ${bold(res.plan.harness.label)} on ${bold(model ?? loadConfig().selected.model!)}`);
      const opened = openSession(harnessId, cwd, res.plan.harness.label);
      console.log(dim(`  ${opened.terminal} · ${opened.command}`));
      if (!opened.opened) die(`no terminal responded — try: terminal <id>`);
      return;
    }

    case "install": {
      const id = args[0] ?? die("install <harness>");
      const h = harnessById(id) ?? die(`unknown harness: ${id}`);
      const had = harnessInstalled(h);
      if (had) {
        console.log(`${bold(h.label)} is already installed at ${had}`);
        return;
      }
      const { path, command } = installHarness(id);
      console.log(`installed ${bold(h.label)} with ${dim(command)} → ${path}`);
      return;
    }

    case "status": {
      const cfg = loadConfig();
      console.log(`${bold("config")}    ${CONFIG_PATH}`);
      console.log(`${bold("agents")}    ${AGENT_DIR}`);
      console.log(`${bold("providers")} ${cfg.providers.length}`);
      console.log(`${bold("selected")}  ${cfg.selected.model ?? dim("none")} ${cfg.selected.provider ? dim("on " + cfg.selected.provider) : ""}`);
      return;
    }

    case "dir": {
      const cfg = loadConfig();
      if (!args[0]) {
        console.log(`sessions open in ${bold(sessionDir())}${cfg.cwd ? "" : dim(" (the shell's directory)")}`);
        return;
      }
      const next = setCwd(args[0]);
      console.log(`sessions open in ${bold(next.cwd ?? sessionDir())}`);
      return;
    }

    case "terminal": {
      const cfg = loadConfig();
      const id = args[0] ?? flag("set");
      if (!id) {
        const active = resolveTerminal(cfg.terminal, cfg.terminalCommand).id;
        console.log(`${bold("sessions open in")} ${bold(active)}${cfg.terminal ? "" : dim(" (detected)")}`);
        for (const t of TERMINALS) {
          const mark = t.id === active ? bold("→") : " ";
          const state = terminalInstalled(t) ? "" : dim("  not installed");
          console.log(`${mark} ${t.id.padEnd(20)} ${t.label}${state}`);
        }
        console.log(dim(`\n  terminal <id|auto|custom>   --command "<template>" for custom`));
        return;
      }
      if (id === "custom") {
        const template = flag("command") ?? cfg.terminalCommand ?? die('terminal custom --command "open -a WezTerm {script}"');
        setTerminal("custom", template);
        console.log(`sessions open with: ${bold(template)}`);
        return;
      }
      setTerminal(id, flag("command"));
      console.log(`sessions open in: ${bold(resolveTerminal(id, flag("command")).label)}`);
      return;
    }

    case "snapshot": {
        const view = await snapshot(args[0]);
        if (has("json")) return console.log(JSON.stringify(view, null, 2));
        console.log(`${bold(view.selected.model ?? "no model")} on ${bold(view.selected.provider ?? "no provider")}`);
        console.log(dim(`${view.providers.length} providers · ${view.models.length} models · reasoning ${view.providers[0]?.reasoning ?? "auto"}`));
        return;
      }

    case "config":
      console.log(CONFIG_PATH);
      return;

    case "serve": {
      const port = flag("port") ?? "4141";
      console.log(`web UI: http://127.0.0.1:${port}`);
      const r = spawnSync("bun", [join(import.meta.dir, "..", "..", "web", "src", "server.ts")], {
        stdio: "inherit",
        env: { ...process.env, PORT: port },
      });
      process.exit(r.status ?? 0);
    }

    default:
      console.log(usage);
  }
}

/** the selected model's real limits, so harnesses are not told to assume 200k */
async function modelTraits(model?: string): Promise<{ context?: number; vision?: boolean }> {
  if (!model) return {};
  try {
    const found = (await listModels()).find((m) => m.id === model);
    return found ? { context: found.contextWindow, vision: found.vision } : {};
  } catch {
    return {};
  }
}

await main();