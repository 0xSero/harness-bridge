/**
 * The read model: one call that returns everything a front end renders. The CLI, the web UI
 * and the menu bar app all read this instead of each composing its own view of the config.
 */
import {
  CONFIG_PATH,
  HARNESSES,
  INSTALLERS,
  TERMINALS,
  dialectsOf,
  harnessInstalled,
  listModels,
  loadConfig,
  resolveTerminal,
  sessionDir,
  terminalInstalled,
} from "./core.ts";
import type { Dialect, ModelInfo, ReasoningLevel } from "./core.ts";

export interface Snapshot {
  config: string;
  providers: { id: string; name: string; apiUrl: string; apis: Dialect[]; reasoning: ReasoningLevel; selected: boolean }[];
  selected: { provider: string | null; model: string | null };
  models: ModelInfo[];
  harnesses: HarnessView[];
  terminal: { active: string; configured: string; options: { id: string; label: string; installed: boolean }[] };
  sessionDir: string;
  defaultDir: string;
  error: string;
}

export interface HarnessView {
  id: string; label: string; dialect: Dialect; reasons: boolean;
  installed: boolean; installable: boolean; hint: string; compatible: boolean;
}

/** Everything a front end needs, in one read — the tray, web UI and CLI all render this. */
export async function snapshot(providerId?: string): Promise<Snapshot> {
  const cfg = loadConfig();
  const active = providerId ?? cfg.selected.provider;
  const provider = cfg.providers.find((p) => p.id === active);
  let models: ModelInfo[] = [];
  let error = "";
  if (active) {
    try {
      models = await listModels(active);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const served = provider ? dialectsOf(provider) : [];
  return {
    config: CONFIG_PATH,
    providers: cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      apiUrl: p.apiUrl,
      apis: dialectsOf(p),
      reasoning: p.reasoning ?? "auto",
      selected: p.id === active,
    })),
    selected: cfg.selected,
    models,
    harnesses: HARNESSES.map((h) => {
      const inst = INSTALLERS[h.id];
      return {
        id: h.id,
        label: h.label,
        dialect: h.dialect,
        reasons: !!h.reasons,
        installed: !!harnessInstalled(h),
        installable: !!inst && inst.manager !== "manual",
        hint: inst?.hint ?? "",
        compatible: served.includes(h.dialect),
      };
    }),
    sessionDir: sessionDir(),
    defaultDir: process.cwd(),
    terminal: {
      active: resolveTerminal(cfg.terminal, cfg.terminalCommand).id,
      configured: cfg.terminal ?? "auto",
      options: TERMINALS.map((t) => ({ id: t.id, label: t.label, installed: terminalInstalled(t) })),
    },
    error,
  };
}
