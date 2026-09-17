# harness-bridge

**Local AI** — point any coding harness at any OpenAI-, Anthropic- or Responses-compatible
inference endpoint. Configure a provider once, discover its live models, then open the
harness you want on the model you picked. The menu bar app is called Local AI; the package
and CLI are `harness-bridge`.

Four independent packages, one core:

| Package | What it is | Largest file |
|---|---|---|
| `packages/core` | providers, models, launch plans, sessions | 436 |
| `packages/cli` | terminal wrapper — the `harness-bridge` / `hbr` executables | 287 |
| `packages/tray` | Local AI — the macOS menu bar app (SwiftUI + AppKit) | 240 |
| `packages/web` | browser UI on `127.0.0.1` | 246 |

The core is a library. Everything else is a thin shell over it. Each package is split into
small modules rather than one long file: `harnesses.ts` (what each agent is), `terminals.ts`
(how a session is opened), `core.ts` (providers and launches), `snapshot.ts` (the read model
every UI renders).

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
environment. **If the harness is not installed, it is installed first** (`npm`/`bun`/`pipx`,
per harness), then launched; `--no-install` refuses instead. `harness-bridge install <id>`
installs one on its own.

A few harnesses (OMP, Grok, Hermes) ship as downloaded native binaries rather than published
packages. For those the tool prints the vendor's install hint instead of inventing a URL.

| Flag | Effect |
|---|---|
| `--print` | print the resolved argv and environment instead of launching |
| `--exec` | run the harness in this terminal (no new window) |
| `--harness <id>` | pick the harness without a positional argument |
| `--provider <id>` | launch against a provider other than the selected one |
| `--dir <path>` | working directory for the harness (overrides `dir`) |
| `--fresh` | ignore the cached model list and refetch |
| `--no-install` | fail instead of installing a missing harness |
| `-- <flags…>` | append flags to the harness argv (e.g. `-- --yolo`) |

Nothing you own is edited — your `~/.claude.json`, `~/.codex/config.toml` and
`~/.config/opencode` are untouched. The only thing that changes is this tool's own selection.

Listings are coloured only when stdout is a terminal, so a pipe, a log or the macOS tray
gets plain text; `NO_COLOR` forces plain output.

## The panel

The menu bar panel is one screen:

- **Models** — the model in use, plus anything pinned beside it. The live model is pinned by
  definition, so it never appears twice and cannot be unpinned. *All models…* opens the
  catalogue.
- **Session opens in** — the folder (click to choose another) and the terminal.
- **Harnesses** — click to launch; a harness the endpoint cannot drive is shown but inert, so
  the reason is visible.

Settings holds two panes: **Providers** (select one to edit it — name, URL, key, dialects,
reasoning; the key is never displayed, and leaving it blank keeps the stored one) and
**Models** (the full catalogue, with pin toggles).

The model list is cached on disk for 30s, so the panel opens instantly instead of waiting on
the endpoint; `--fresh`, or 30 seconds, forces a refetch.

## Sessions

A session is a **command**, not a generated script:

```
harness-bridge run --harness omp --exec --dir /Users/you/project
```

The terminal is handed exactly that, so what runs is visible in its own history. The command
re-enters the CLI, which builds the launch environment at run time from the 0600 config — so
**no key is ever written to a file**, and a session always uses your current selection rather
than one frozen when a command was composed.

### Which terminal

```bash
pin <model> | unpin <model> | pins      # what the panel shows
harness-bridge terminal                 # the list, with what is installed
harness-bridge terminal ghostty         # or: warp, terminal, iterm, kitty, wezterm, …
harness-bridge terminal custom --command 'open -a WezTerm {dir}'
```

`auto` (the default) follows `$TERM_PROGRAM`, so launching from Warp opens in Warp, and from
Ghostty opens in Ghostty. Each entry knows its own mechanism: Ghostty, kitty, Alacritty and
WezTerm take a command as argv; Terminal.app and iTerm are driven by AppleScript; Warp has no
`-e` and is opened through a Launch Configuration, which is the only thing this tool writes
into another app's directory. `{command}`, `{dir}` and `{name}` substitute into a custom
template.

### Where a session opens

```bash
harness-bridge dir ~/code         # remembered; used when a run names no directory
harness-bridge run --dir /tmp omp # one-off
```

Unset, sessions open wherever the shell started. The tray has a *Choose…* folder picker and
the web UI a text field for the same setting.

## Reasoning

`auto` by default, which changes nothing — the harness and the engine keep their own settings.
Choose a level to have the bridge ask for it:

```bash
harness-bridge providers reasoning high
```

| Harness | How the level is passed |
|---|---|
| Claude Code | `MAX_THINKING_TOKENS` (4096 / 16384 / 32768) |
| Codex | `-c model_reasoning_effort=<low\|medium\|high>`, and `minimal` for `off` |
| Pi, OMP | the `supportsReasoningParams` compat flag is lifted, so params are sent |
| others | no reasoning knob; the setting is ignored |

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
bash packages/tray/build.sh          # builds "Local AI.app" and "Local AI.dmg"
open "packages/tray/dist/Local AI.dmg"   # drag to Applications
open -a "/Applications/Local AI.app"
```

The build renders the Local AI mark (`packages/tray/assets/logo.svg`, the same vector the
plugin uses) into `AppIcon.icns` and the panel's header image, then packages the app with an
`/Applications` shortcut into a compressed DMG.

A `⇄` item in the menu bar with Providers / Models / Harnesses submenus, an *Add provider…*
flow, and *Open web UI*. It is an `LSUIElement` bundle, so there is no Dock icon.

Every action shells out to the CLI, so there is no second copy of the logic. Because a
bundle opened from Finder inherits a minimal `PATH`, the tray resolves the CLI by absolute
path (`$HOME/.bun/bin`, `~/.local/bin`, Homebrew, `/usr/local`) and hands the child an
augmented `PATH` — without that, both `harness-bridge` and the `bun` its shim needs would be
unreachable. Set `HB_BIN` to override the CLI, and `HB_DEBUG=1` to log every invocation to
`~/.config/harness-bridge/tray.log`.

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
config round-tripping.

End-to-end checks ran against a live llama.cpp-family server on three machines, each
returning a completion through the environment the tool generates:

| Machine | Architecture | Harnesses exercised |
|---|---|---|
| macOS | arm64 | Claude Code (`messages`), OMP (`chat`) |
| Pop!_OS 22.04 | x86_64 | Claude Code, OMP |
| DGX Spark, Ubuntu 24.04 | aarch64 | OMP; and Claude Code from a clean image, which was installed by `run` before launching |

## Licence

MIT