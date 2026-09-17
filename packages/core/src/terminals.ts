/**
 * Which terminal a session opens in, and how a command is handed to it.
 *
 * A session is a plain command — `harness-bridge run --harness omp --exec --dir <path>` — never
 * a generated script, so what runs is visible in the terminal's own history. Only Warp needs a
 * file: its documented automation is a Launch Configuration, which is written to Warp's own
 * configuration directory and simply contains that same command.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Session {
  /** the command to run, e.g. `harness-bridge run --harness omp --exec --dir /work` */
  command: string;
  /** the directory the session should start in */
  dir: string;
  /** a short label for the tab title */
  name: string;
}

export interface Terminal {
  id: string;
  label: string;
  /** argv that opens a session running this command */
  command: (s: Session) => string[];
  /** files the terminal needs before it can be opened, for the one that cannot take a command */
  prepare?: (s: Session) => string[];
  /** an app bundle or binary that proves this terminal is on the machine */
  probe: string;
}

const appleScript = (source: string) => ["osascript", "-e", source];
/** an AppleScript string literal: backslashes and quotes are the only hazards */
const asLiteral = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Warp's automation is a Launch Configuration; `exec` carries the command itself. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const warpConfig = (name: string) => join(homedir(), ".warp", "launch_configurations", `${slug(name)}.yaml`);

const warp: Terminal = {
  id: "warp",
  label: "Warp",
  probe: "/Applications/Warp.app",
  prepare: ({ command, dir, name }) => {
    const path = warpConfig(name);
    mkdirSync(join(homedir(), ".warp", "launch_configurations"), { recursive: true });
    // cwd must be absolute or Warp will not list the configuration
    writeFileSync(
      path,
      `---\nname: ${slug(name)}\nwindows:\n  - tabs:\n      - title: ${name}\n        layout:\n          cwd: ${dir || homedir()}\n          commands:\n            - exec: ${command}\n`,
    );
    return [path];
  },
  // the URI takes the configuration's name; a path there silently does nothing
  command: (s) => ["open", `warp://launch/${slug(s.name)}`],
};

const macOS: Terminal[] = [
  {
    id: "terminal",
    label: "Terminal",
    probe: "/System/Applications/Utilities/Terminal.app",
    command: (s) => appleScript(`tell application "Terminal" to do script ${asLiteral(s.command)}`),
  },
  {
    id: "iterm",
    label: "iTerm",
    probe: "/Applications/iTerm.app",
    command: (s) => appleScript(`tell application "iTerm" to create window with default profile command ${asLiteral(s.command)}`),
  },
  warp,
  {
    id: "ghostty",
    label: "Ghostty",
    probe: "/Applications/Ghostty.app",
    command: (s) => ["open", "-na", "Ghostty", "--args", "-e", "/bin/bash", "-lc", s.command],
  },
];

/** Anything that takes a command as argv behaves the same way; `-lc` keeps the login PATH. */
const unix: Terminal[] = [
  { id: "ghostty", label: "Ghostty", probe: "ghostty", command: (s) => ["ghostty", "-e", "bash", "-lc", s.command] },
  { id: "kitty", label: "kitty", probe: "kitty", command: (s) => ["kitty", "bash", "-lc", s.command] },
  { id: "alacritty", label: "Alacritty", probe: "alacritty", command: (s) => ["alacritty", "-e", "bash", "-lc", s.command] },
  { id: "wezterm", label: "WezTerm", probe: "wezterm", command: (s) => ["wezterm", "start", "--cwd", s.dir, "--", "bash", "-lc", s.command] },
  { id: "gnome-terminal", label: "GNOME Terminal", probe: "gnome-terminal", command: (s) => ["gnome-terminal", `--working-directory=${s.dir}`, "--", "bash", "-lc", s.command] },
  { id: "konsole", label: "Konsole", probe: "konsole", command: (s) => ["konsole", "--workdir", s.dir, "-e", "bash", "-lc", s.command] },
  { id: "x-terminal-emulator", label: "x-terminal-emulator", probe: "x-terminal-emulator", command: (s) => ["x-terminal-emulator", "-e", "bash", "-lc", s.command] },
  { id: "xterm", label: "xterm", probe: "xterm", command: (s) => ["xterm", "-e", "bash", "-lc", s.command] },
];

/** macOS and the unix list overlap (Ghostty has both a bundle and a CLI), so ids are unique. */
const seen: Record<string, true> = {};
export const TERMINALS: Terminal[] = [...(process.platform === "darwin" ? macOS : []), ...unix].filter((t) =>
  seen[t.id] ? false : (seen[t.id] = true),
);

export const terminalInstalled = (t: Terminal): boolean => !!t.probe && existsSync(t.probe);

/** A template the user supplies, e.g. `open -a WezTerm {dir}` — {command} {dir} {name} substitute. */
export const customTerminal = (template: string): Terminal => ({
  id: "custom",
  label: "custom",
  probe: "",
  command: (s) =>
    template
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.replaceAll("{command}", s.command).replaceAll("{dir}", s.dir).replaceAll("{name}", s.name)),
});

/** A terminal named by the environment the user is already in. */
const BY_TERM_PROGRAM: Record<string, string> = {
  WarpTerminal: "warp",
  "iTerm.app": "iterm",
  Apple_Terminal: "terminal",
  ghostty: "ghostty",
  WezTerm: "wezterm",
  kitty: "kitty",
  Alacritty: "alacritty",
};

/**
 * The terminal to open sessions in: the configured one, else the one the user is running in,
 * else the first that is actually installed.
 */
export function resolveTerminal(configured?: string, template?: string): Terminal {
  if (configured === "custom") {
    if (!template?.trim()) throw new Error("terminal is set to custom but terminalCommand is empty");
    return customTerminal(template);
  }
  if (configured && configured !== "auto") {
    const found = TERMINALS.find((t) => t.id === configured);
    if (!found) throw new Error(`unknown terminal: ${configured} (one of ${TERMINALS.map((t) => t.id).join(", ")}, custom)`);
    return found;
  }
  const detected =
    (process.env.TERM_PROGRAM && BY_TERM_PROGRAM[process.env.TERM_PROGRAM]) ??
    (process.env.__CFBundleIdentifier?.toLowerCase().includes("warp") ? "warp" : undefined);
  const match = detected && TERMINALS.find((t) => t.id === detected);
  if (match) return match;
  const fallback = TERMINALS.find(terminalInstalled);
  if (!fallback) throw new Error(`no terminal found — set one with: terminal <${TERMINALS.map((t) => t.id).join("|")}>`);
  return fallback;
}