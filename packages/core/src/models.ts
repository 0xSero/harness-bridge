/**
 * The model list: what an endpoint offers, cached on disk so a menu bar panel opens instantly
 * and keeps working through a momentary network failure.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, apiBases, resolveProvider } from "./core.ts";
import type { Provider } from "./core.ts";

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  vision?: boolean;
}

/**
 * Model lists change rarely but every refresh wants one, and each CLI invocation is a fresh
 * process — so the cache is on disk, which is what makes the menu bar panel open instantly.
 */
const MODEL_TTL_MS = 30_000;
const cachePath = (id: string) => join(CONFIG_DIR, "cache", `models-${id}.json`);

/** The last list we fetched, however old: a stale list beats an empty panel. */
function cachedModels(provider: Provider, anyAge = false): ModelInfo[] | null {
  try {
    const c = JSON.parse(readFileSync(cachePath(provider.id), "utf8")) as { at: number; apiUrl: string; models: ModelInfo[] };
    if (c.apiUrl !== provider.apiUrl) return null;   // a changed endpoint invalidates the cache
    if (anyAge || Date.now() - c.at < MODEL_TTL_MS) return c.models;
  } catch {}
  return null;
}

export async function listModels(providerId?: string, fresh = false): Promise<ModelInfo[]> {
  const p = resolveProvider(providerId);
  if (!fresh) {
    const hit = cachedModels(p);
    if (hit) return hit;
  }
  let res: Response;
  try {
    res = await fetch(`${apiBases(p.apiUrl).v1}/models`, {
      headers: { Authorization: `Bearer ${p.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    // an endpoint that blinks must not empty the panel: serve the last list we had
    const stale = cachedModels(p, true);
    if (stale) return stale;
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!res.ok) {
    const stale = cachedModels(p, true);
    if (stale && res.status >= 500) return stale;
    throw new Error(`models: ${res.status} ${res.statusText}`);
  }
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
  mkdirSync(dirname(cachePath(p.id)), { recursive: true, mode: 0o700 });
  writeFileSync(cachePath(p.id), JSON.stringify({ at: Date.now(), apiUrl: p.apiUrl, models: out }), { mode: 0o600 });
  return out;
}
