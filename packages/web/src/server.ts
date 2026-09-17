#!/usr/bin/env bun
/** harness-bridge web — the same core, in a browser. No build step, no framework. */
import type { Dialect, ReasoningLevel } from "@harness-bridge/core";
import {
  HARNESSES,
  REASONING_LEVELS,
  addProvider,
  harnessInstalled,
  installHarness,
  listModels,
  loadConfig,
  openSession,
  removeProvider,
  resolveProvider,
  run,
  selectModel,
  sessionDir,
  setCwd,
  snapshot,
} from "@harness-bridge/core";

const PORT = Number(process.env.PORT ?? 4141);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const DIALECTS: Dialect[] = ["chat", "messages", "responses"];
const isDialect = (v: unknown): v is Dialect => typeof v === "string" && (DIALECTS as string[]).includes(v);
const isLevel = (v: unknown): v is ReasoningLevel => typeof v === "string" && (REASONING_LEVELS as string[]).includes(v);

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>harness-bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--fg:#1a1a1a;--dim:#6b6b6b;--line:#d8d8d8;--bg:#fdfdfc;--accent:#3a5a40}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 2rem;background:var(--bg);color:var(--fg);
  font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:76rem}
h1{font-size:1.05rem;margin:0 0 .2rem;letter-spacing:.02em}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);
  margin:2.2rem 0 .6rem;font-weight:600}
p.note{color:var(--dim);margin:0 0 1.4rem;font-size:.82rem}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:.32rem .7rem .32rem 0;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--dim);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em}
tr.sel td{background:#f2f5f2}
td.id{white-space:nowrap}
button{font:inherit;font-size:.78rem;background:none;border:1px solid var(--line);
  border-radius:2px;padding:.12rem .5rem;cursor:pointer;color:var(--fg)}
button:hover:not([disabled]){border-color:var(--accent);color:var(--accent)}
button[disabled]{opacity:.35;cursor:default}
form.grid{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:.45rem .7rem;
  align-items:center;margin:.4rem 0;max-width:60rem}
label{color:var(--dim);font-size:.78rem;text-align:right}
input,select{font:inherit;font-size:.8rem;padding:.28rem .45rem;border:1px solid var(--line);
  border-radius:2px;background:#fff;color:var(--fg);width:100%}
.dialects{display:flex;gap:.9rem;font-size:.8rem;color:var(--fg)}
.dialects label{text-align:left;color:inherit;display:flex;gap:.3rem;align-items:center}
.dialects input{width:auto}
.err{color:#8a2b2b;font-size:.82rem;margin:.5rem 0}
.muted{color:var(--dim)}
code{background:#f4f4f2;padding:.05rem .25rem}
.actions{grid-column:2/4;display:flex;gap:.5rem}
</style></head><body>
<h1>harness-bridge</h1>
<p class="note">One endpoint. Live models. Any installed harness. Configuration lives in
<code>~/.config/harness-bridge/config.json</code> (0600); nothing else on disk is edited.</p>
<div id="root">loading…</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function api(path, body) {
  const r = await fetch(path, body ? { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) } : {});
  const d = await r.json(); if (!r.ok) alert(d.error || r.statusText); return d;
}
const LEVELS = ${JSON.stringify(REASONING_LEVELS)};
const DIALECTS = ["chat","messages","responses"];

async function render() {
  const s = await api("/api/state");
  const p = s.providers.find((x) => x.selected);
  document.getElementById("root").innerHTML = \`
  <h2>Provider</h2>
  <table><tr><th></th><th>id</th><th>endpoint</th><th>dialects</th><th>reasoning</th><th></th></tr>
  \${s.providers.map((x) => \`<tr class="\${x.selected ? "sel" : ""}">
    <td><button data-use="\${esc(x.id)}" \${x.selected ? "disabled" : ""}>use</button></td>
    <td class="id">\${esc(x.id)}</td>
    <td>\${esc(x.apiUrl)}</td>
    <td class="muted">\${esc(x.apis.join(", "))}</td>
    <td><select data-reason="\${esc(x.id)}">\${LEVELS.map((l) =>
        \`<option \${l === x.reasoning ? "selected" : ""}>\${l}</option>\`).join("")}</select></td>
    <td><button data-rm="\${esc(x.id)}">remove</button></td></tr>\`).join("")
      || \`<tr><td colspan="6" class="muted">none configured</td></tr>\`}
  </table>

  <h2>Add provider</h2>
  <form class="grid" id="add">
    <label for="n">name</label><input id="n" name="name" placeholder="HomeLab">
    <span></span>
    <label for="u">base url</label><input id="u" name="url" placeholder="http://host:8080/v1">
    <span></span>
    <label for="k">api key</label><input id="k" name="key" type="password" placeholder="sk-…">
    <span></span>
    <label>dialects</label>
    <div class="dialects">\${DIALECTS.map((d) => \`<label><input type="checkbox" name="api" value="\${d}"
      \${d === "chat" ? "checked" : ""}>\${d}</label>\`).join("")}</div>
    <span></span>
    <label for="r">reasoning</label><select id="r" name="reasoning">\${LEVELS.map((l) =>
      \`<option \${l === "auto" ? "selected" : ""}>\${l}</option>\`).join("")}</select>
    <span></span>
    <div class="actions"><button type="submit">add provider</button></div>
  </form>
  \${s.error ? \`<p class="err">\${esc(s.error)}</p>\` : ""}

  <h2>Models \${p ? \`<span class="muted">· \${esc(p.name)}</span>\` : ""}</h2>
  <table><tr><th></th><th>model</th><th>context</th><th>vision</th></tr>
  \${s.models.map((m) => \`<tr class="\${m.id === s.selected.model ? "sel" : ""}">
    <td><button data-model="\${esc(m.id)}" \${m.id === s.selected.model ? "disabled" : ""}>use</button></td>
    <td class="id">\${esc(m.id)}</td>
    <td class="muted">\${m.contextWindow ? Math.round(m.contextWindow / 1024) + "k" : ""}</td>
    <td class="muted">\${m.vision ? "yes" : ""}</td></tr>\`).join("")
      || \`<tr><td colspan="4" class="muted">select a provider</td></tr>\`}
  </table>

  <h2>Session directory</h2>
  <form class="grid" id="dirform">
    <label for="d">sessions open in</label>
    <input id="d" name="dir" value="\${esc(s.sessionDir)}" placeholder="\${esc(s.defaultDir)}">
    <button type="submit">save</button>
  </form>

  <h2>Harnesses</h2>
  <table><tr><th></th><th>harness</th><th>dialect</th><th>reasoning</th><th>state</th><th></th></tr>
  \${s.harnesses.map((h) => \`<tr>
    <td>\${h.installed ? "●" : "<span class='muted'>○</span>"}</td>
    <td>\${esc(h.label)} <span class="muted">\${esc(h.id)}</span></td>
    <td class="muted">\${esc(h.dialect)}</td>
    <td class="muted">\${h.reasons ? "configurable" : "n/a"}</td>
    <td class="muted">\${h.installed ? (h.compatible ? "ready" : "dialect not served")
        : (h.installable ? "not installed — will install" : esc(h.hint))}</td>
    <td><button data-run="\${esc(h.id)}" \${h.compatible && s.selected.model && (h.installed || h.installable) ? "" : "disabled"}>\${h.installed ? "launch" : "install &amp; launch"}</button></td>
  </tr>\`).join("")}
  </table>\`;

  document.querySelectorAll("[data-use]").forEach((b) => b.onclick = async () => { await api("/api/provider", { id: b.dataset.use }); render(); });
  document.querySelectorAll("[data-model]").forEach((b) => b.onclick = async () => { await api("/api/model", { model: b.dataset.model }); render(); });
  document.querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => { await api("/api/remove", { id: b.dataset.rm }); render(); });
  document.querySelectorAll("[data-reason]").forEach((sel) => sel.onchange = async () => {
    await api("/api/reasoning", { id: sel.dataset.reason, reasoning: sel.value }); render();
  });
  document.querySelectorAll("[data-run]").forEach((b) => b.onclick = async () => {
    const r = await api("/api/run", { harness: b.dataset.run });
    if (r.error) return;
    alert((r.installed ? "installed via " + r.installed + "\\n" : "") +
          (r.opened ? "launched " + r.harness + " in a terminal" : "no terminal found; run: bash " + r.script));
  });
  document.getElementById("dirform").onsubmit = async (e) => {
    e.preventDefault();
    await api("/api/dir", { dir: new FormData(e.target).get("dir") });
    render();
  };
  document.getElementById("add").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const apis = [...e.target.querySelectorAll("input[name=api]:checked")].map((c) => c.value);
    await api("/api/add", { name: f.get("name"), url: f.get("url"), key: f.get("key"),
                            apis, reasoning: f.get("reasoning") });
    e.target.reset(); render();
  };
}
render();
</script></body></html>`;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(page(), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/state") return json(await snapshot());
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? body[k] : "");
    const dialects = (k: string) => (Array.isArray(body[k]) ? body[k].filter(isDialect) : []);
    const level = (k: string) => (isLevel(body[k]) ? body[k] : "auto");
    try {
      switch (url.pathname) {
        case "/api/add": {
          const apis = dialects("api");
          addProvider({
            name: str("name") || "provider",
            apiUrl: str("url"),
            apiKey: str("key"),
            api: apis[0] ?? "chat",
            apis,
            reasoning: level("reasoning"),
          });
          return json({ ok: true });
        }
        case "/api/dir": {
          const next = setCwd(str("dir"));
          return json({ ok: true, cwd: next.cwd ?? "" });
        }
        case "/api/remove":
          removeProvider(str("id"));
          return json({ ok: true });
        case "/api/reasoning": {
          const p = resolveProvider(str("id"));
          addProvider({ ...p, reasoning: level("reasoning") });
          return json({ ok: true });
        }
        case "/api/provider": {
          const cfg = loadConfig();
          cfg.selected = { provider: str("id"), model: null };
          selectModel("", cfg.selected.provider!);
          return json({ ok: true });
        }
        case "/api/model":
          selectModel(str("model"));
          return json({ ok: true });
        case "/api/run": {
          const provider = resolveProvider();
          const model = loadConfig().selected.model ?? "";
          if (!model) throw new Error("select a model first");
          const harnessId = str("harness");
          if (!HARNESSES.some((x) => x.id === harnessId)) throw new Error(`unknown harness: ${harnessId}`);
          let installed = "";
          const h = HARNESSES.find((x) => x.id === harnessId)!;
          if (!harnessInstalled(h)) installed = installHarness(harnessId).command;
          const found = (await listModels(provider.id)).find((m) => m.id === model);
          const cwd = sessionDir(str("dir"));
          const res = await run({ harnessId, model, context: found?.contextWindow, vision: found?.vision, cwd });
          const opened = openSession(harnessId, cwd, res.plan.harness.label);
          return json({ ok: true, installed, opened: opened.opened, terminal: opened.terminal, harness: res.plan.harness.id, command: opened.command });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  },
});

console.log(`harness-bridge web on http://127.0.0.1:${PORT}`);