# harness-bridge

Point any coding harness at any OpenAI-, Anthropic- or Responses-compatible inference
endpoint. Configure a provider once, discover its live models, then open the harness you
want on the model you picked.

Four independent packages, one core:

| Package | What it is | Lines |
|---|---|---|
| `packages/core` | the whole idea: providers, model discovery, harness launch plans | ~460 |
| `packages/cli` | terminal wrapper — the `harness-bridge` / `hbr` executables | ~290 |
| `packages/tray` | macOS menu bar app (Swift/AppKit), shells out to the CLI | ~250 |
| `packages/web` | browser UI on `127.0.0.1`, same core | ~250 |

The core is a library. Everything else is a thin shell over it.

## Install

```bash
git clone https://github.com/0xSero/harness-bridge && cd harness-bridge
bun install
cd packages/cli && bun link        # puts `harness-bridge` and `hbr` on your PATH
```

Requires [Bun](https://bun.sh) ≥ 1.1. The tray additionally requires Xcode command line
tools (`swiftc`); macOS only.

## Configure

```bash
harness-bridge providers add --name HomeLab --url http://host:8080/v1 --key sk-…
```

The key is written to `~/.config/harness-bridge/config.json` with mode `0600`. It is never
passed on a command line, never logged, and never committed.

A provider that serves more than one dialect says so:

```bash
harness-bridge providers add --name Gateway --url https://gw/v1 --key sk-… --apis chat,messages,responses
```

Without `--apis`, a provider is assumed to serve only its `--api` dialect (default `chat`).

## Use

```bash
harness-bridge models                     # live models from the selected provider
harness-bridge use deepseek-v4.1-flash    # select one
harness-bridge harnesses                  # what is installed, and what this endpoint can drive
harness-bridge run deepseek-v4.1-flash claude
```

`run` opens the harness in a new terminal window with the endpoint, key and model in its
environment. Nothing you own is edited — your `~/.claude.json`, `~/.codex/config.toml` and
`~/.config/opencode` are untouched. The only thing that changes is this tool's own
selection.

Useful flags:

| Flag | Effect |
|---|---|
| `--print` | print the resolved argv and environment instead of launching |
| `--exec` | run the harness in this terminal (no new window) |
| `--harness <id>` | pick the harness without a positional argument |
| `--provider <id>` | launch against a provider other than the selected one |
| `--dir <path>` | working directory for the harness |
| `-- <flags…>` | append flags to the harness argv (e.g. `-- --yolo`) |

## Dialects

A harness only gets offered when the endpoint speaks its dialect. This is a correctness
rule, not a preference: sending Responses-shaped traffic to a Chat endpoint fails at the
first turn.

| Harness | Dialect | How it is pointed at the endpoint |
|---|---|---|
| `claude` | `messages` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `--model` |
| `codex` | `responses` | `-c model_providers.local.*`, `-c model_provider=local`, `LOCAL_AI_KEY` |
| `opencode` | `chat` | inline `OPENCODE_CONFIG_CONTENT` provider, key via `{env:…}` |
| `pi`, `omp` | `chat` | plugin-owned `models.json`/`models.yml` + `*_CODING_AGENT_DIR` |
| `crush` | `chat` | plugin-owned `XDG_CONFIG_HOME` |
| `copilot` | `chat` | `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY` |
| `grok` | `chat` | plugin-owned `GROK_HOME/config.toml` |
| `aider`, `hermes`, and everything else | `chat` | `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_API_KEY`, `OPENAI_MODEL` |

Harnesses that cannot take a key from the environment are given a `0600` file under
`~/.config/harness-bridge/agents/`. The context window advertised to a harness is the
model's real one, read from the provider's `/models`, so nothing assumes 128k.

Claude Code does not know locally served model names; the bridge sets
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`
so it uses the real window instead of warning and compacting early.

## Web

```bash
bun packages/web/src/server.ts        # http://127.0.0.1:4141
```

Add and select providers, browse live models, and launch any installed harness. Bound to
loopback; no authentication beyond that.

## Tray (macOS)

```bash
bash packages/tray/build.sh
packages/tray/dist/harness-bridge-tray
```

A `⇄` item in the menu bar with Providers / Models / Harnesses submenus, an *Add provider…*
flow, and *Open web UI*. Every action shells out to the CLI, so there is no second copy of
the logic.

## Layout

```
packages/core/src/core.ts      library: config, providers, /models, launch plans
packages/cli/src/cli.ts        commands, terminal selection, --print/--exec
packages/tray/main.swift       NSStatusItem app
packages/web/src/server.ts     Bun.serve + single-page UI
```

Configuration lives only in `~/.config/harness-bridge/`. Delete that directory and the tool
has no footprint.

## Testing

```bash
bun test
```

The suite covers dialect gating, argv/env construction per harness, secret handling, and
config round-tripping. End-to-end checks were run against a live llama.cpp-family server on
three machines — macOS arm64 (Claude Code and OMP), Pop!_OS x86_64 (Claude Code and OMP),
and DGX Spark aarch64 (OMP) — each returning a completion through the generated launch
environment.

## Licence

MIT