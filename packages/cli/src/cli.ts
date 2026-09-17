#!/usr/bin/env bun
/**
 * harness-bridge CLI — a thin shell over @harness-bridge/core.
 * Configuration, model discovery, selection, and launching a harness on a model.
 */
import {
  AGENT_DIR,
  CONFIG_PATH,
  HARNESSES,
  addProvider,
  buildLaunch,
  dialectsOf,
  harnessById,
  harnessInstalled,
  listModels,
  loadConfig,
  planToScript,
  removeProvider,
  resolveProvider,
  run,
  saveConfig,
  selectModel,
} from "@harness-bridge/core";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
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

  providers                          list configured providers
  providers add --name N --url U --key K [--api chat|messages|responses] [--apis chat,messages]
  providers rm <id>
  models [provider]                  list live models from the provider
  use <model> [provider]             select the model (only selection is persisted)
  harnesses [provider]               installed harnesses and which the endpoint can drive
  run [model] [harness]              open the harness on the selected model
        --provider <id>  --dir <cwd>
        --print                      print the command instead of launching
        --exec                       run the harness in this terminal
        -- <extra flags…>            append flags to the harness argv
  status                             what is configured and selected
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
        const p = addProvider({ name: flag("name"), id: flag("id"), apiUrl: url, apiKey: key, api, apis });
        console.log(`added ${bold(p.id)}  ${dim(p.apiUrl)}  ${dim(p.api)}`);
        return;
      }
      if (args[0] === "rm" || args[0] === "remove") {
        const id = args[1] ?? die("providers rm <id>");
        console.log(removeProvider(id) ? `removed ${id}` : die(`no provider ${id}`));
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
        const plan = buildLaunch(harnessId, { endpoint: provider.apiUrl, key: provider.apiKey, model: m, ...(await modelTraits(m)) }, flag("dir") ?? process.cwd());
        console.log([plan.bin, ...plan.args, ...extra].join(" "));
        const secret = /(_KEY|_TOKEN|^KEY|^TOKEN|APIKEY)$/;
        for (const [k, v] of Object.entries(plan.env)) console.log(dim(`${k}=${secret.test(k) ? "…" : v}`));
        return;
      }
      const res = await run({ harnessId, model, providerId: flag("provider"), cwd: flag("dir"), extraArgs: extra, ...(await modelTraits(model)) });
      if (has("exec")) {
        // run the harness here and now, with the same environment a terminal launch would get
        const r = spawnSync(res.plan.bin, res.plan.args, { stdio: "inherit", env: { ...process.env, ...res.plan.env }, cwd: res.plan.cwd });
        process.exit(r.status ?? 0);
      }
      console.log(`launching ${bold(res.plan.harness.label)} on ${bold(model ?? loadConfig().selected.model!)}`);
      await openInTerminal(res.script, res.plan.harness.label);
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

/** macOS opens Terminal.app on the script; Linux picks an installed emulator. */
async function openInTerminal(script: string, label: string) {
  const dir = join(AGENT_DIR, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${label.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.sh`);
  writeFileSync(path, script, { mode: 0o700 });
  chmodSync(path, 0o700);
  if (process.platform === "darwin") {
    spawnSync("open", ["-a", "Terminal", path], { stdio: "ignore" });
    return;
  }
  for (const term of ["x-terminal-emulator", "kgx", "gnome-terminal", "konsole", "kitty", "alacritty", "xterm"]) {
    const r = spawnSync("bash", ["-lc", `command -v ${term}`], { stdio: "ignore" });
    if (r.status === 0) {
      spawnSync(term, ["-e", "bash", path], { detached: true, stdio: "ignore" });
      return;
    }
  }
  console.log(dim(`no terminal emulator found; run: bash ${path}`));
}

await main();