#!/usr/bin/env bun
/** harness-bridge web — the same core, in a browser. Wiki-style, no build step. */
import {
  HARNESSES,
  INSTALLERS,
  addProvider,
  dialectsOf,
  harnessInstalled,
  installHarness,
  listModels,
  loadConfig,
  openScriptInTerminal,
  removeProvider,
  resolveProvider,
  run,
  selectModel,
} from "@harness-bridge/core";

const PORT = Number(process.env.PORT ?? 4141);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function state() {
  const cfg = loadConfig();
  const providers = cfg.providers.map((p) => ({ id: p.id, name: p.name, apiUrl: p.apiUrl, api: p.api, hasKey: !!p.apiKey }));
  let models: unknown[] = [];
  let error = "";
  if (cfg.selected.provider) {
    try {
      models = await listModels(cfg.selected.provider);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const provider = cfg.providers.find((p) => p.id === cfg.selected.provider);
  return {
    providers,
    selected: cfg.selected,
    models,
    error,
    harnesses: HARNESSES.map((h) => {
      const bin = harnessInstalled(h);
      return {
        id: h.id,
        label: h.label,
        dialect: h.dialect,
        installed: !!bin,
        installable: !!INSTALLERS[h.id] && INSTALLERS[h.id].manager !== "manual",
        hint: INSTALLERS[h.id]?.hint ?? "",
        compatible: !!provider && dialectsOf(provider).includes(h.dialect),
      };
    }),
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>harness-bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--fg:#1a1a1a;--dim:#6b6b6b;--line:#d8d8d8;--bg:#fdfdfc;--accent:#3a5a40}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 2rem;background:var(--bg);color:var(--fg);
  font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:74rem}
h1{font-size:1.05rem;margin:0 0 .2rem;letter-spacing:.02em}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);
  margin:2.2rem 0 .6rem;font-weight:600}
p.note{color:var(--dim);margin:0 0 1.4rem;font-size:.82rem}
table{border-collapse:collapse;width:100%;margin:.2rem 0 .4rem}
td,th{text-align:left;padding:.3rem .7rem .3rem 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em}
tr.sel td{background:#f2f5f2}
td.id{white-space:nowrap}
button{font:inherit;font-size:.78rem;background:none;border:1px solid var(--line);
  border-radius:2px;padding:.12rem .5rem;cursor:pointer;color:var(--fg)}
button:hover{border-color:var(--accent);color:var(--accent)}
button[disabled]{opacity:.35;cursor:default}
form{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.4rem 0}
input,select{font:inherit;font-size:.8rem;padding:.25rem .4rem;border:1px solid var(--line);
  border-radius:2px;background:#fff;color:var(--fg)}
input[name=key]{width:22rem}
.err{color:#8a2b2b;font-size:.82rem;margin:.5rem 0}
.muted{color:var(--dim)}
code{background:#f4f4f2;padding:.05rem .25rem}
</style></head><body>
<h1>harness-bridge</h1>
<p class="note">One endpoint. Live models. Any installed harness. Configuration lives in
<code>~/.config/harness-bridge/config.json</code> (0600) and nothing else on disk is edited.</p>
<div id="root">loading…</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body) } : {});
  const d = await r.json(); if (!r.ok) alert(d.error || r.statusText); return d;
}
async function render() {
  const s = await api("/api/state");
  const p = s.providers.find((x) => x.id === s.selected.provider);
  document.getElementById("root").innerHTML = \`
  <h2>Providers</h2>
  <table><tr><th></th><th>id</th><th>name</th><th>endpoint</th><th>api</th><th></th></tr>
  \${s.providers.map((x) => \`<tr class="\${x.id===s.selected.provider?"sel":""}">
    <td><button data-sel="\${esc(x.id)}" \${x.id===s.selected.provider?"disabled":""}>select</button></td>
    <td class="id">\${esc(x.id)}</td><td>\${esc(x.name)}</td><td>\${esc(x.apiUrl)}</td>
    <td class="muted">\${esc(x.api)}</td>
    <td><button data-rm="\${esc(x.id)}">remove</button></td></tr>\`).join("") || \`<tr><td colspan="6" class="muted">none configured</td></tr>\`}
  </table>
  <form id="add"><input name="name" placeholder="name" size="12">
    <input name="url" placeholder="https://host/v1" size="30">
    <input name="key" placeholder="api key" type="password">
    <select name="api"><option>chat</option><option>messages</option><option>responses</option></select>
    <button type="submit">add provider</button></form>
  \${s.error ? \`<p class="err">\${esc(s.error)}</p>\` : ""}
  <h2>Models \${p ? \`<span class="muted">· \${esc(p.name)}</span>\` : ""}</h2>
  <table><tr><th></th><th>model</th><th>context</th><th>vision</th></tr>
  \${s.models.map((m) => \`<tr class="\${m.id===s.selected.model?"sel":""}">
    <td><button data-model="\${esc(m.id)}" \${m.id===s.selected.model?"disabled":""}>select</button></td>
    <td class="id">\${esc(m.id)}</td>
    <td class="muted">\${m.contextWindow ? Math.round(m.contextWindow/1024)+"k" : ""}</td>
    <td class="muted">\${m.vision ? "yes" : ""}</td></tr>\`).join("") || \`<tr><td colspan="4" class="muted">select a provider</td></tr>\`}
  </table>
  <h2>Harnesses</h2>
  <table><tr><th></th><th>harness</th><th>dialect</th><th>state</th><th></th></tr>
  \${s.harnesses.map((h) => \`<tr>
    <td>\${h.installed ? "●" : "<span class='muted'>○</span>"}</td>
    <td>\${esc(h.label)} <span class="muted">\${esc(h.id)}</span></td>
    <td class="muted">\${esc(h.dialect)}</td>
    <td class="muted">\${h.installed ? (h.compatible ? "ready" : "dialect not served")
        : (h.installable ? "not installed — will install" : esc(h.hint))}</td>
    <td><button data-run="\${esc(h.id)}" \${h.compatible && s.selected.model && (h.installed || h.installable) ? "" : "disabled"}>\${h.installed ? "launch" : "install &amp; launch"}</button></td></tr>\`).join("")}
  </table>\`;
  document.querySelectorAll("[data-sel]").forEach((b) => b.onclick = async () => { await api("/api/provider", {id:b.dataset.sel}); render(); });
  document.querySelectorAll("[data-model]").forEach((b) => b.onclick = async () => { await api("/api/model", {model:b.dataset.model}); render(); });
  document.querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => { await api("/api/remove", {id:b.dataset.rm}); render(); });
  document.querySelectorAll("[data-run]").forEach((b) => b.onclick = async () => {
    const r = await api("/api/run", {harness:b.dataset.run});
    if (r.error) return;
    alert((r.installed ? "installed via " + r.installed + "\\n" : "") +
          (r.opened ? "launched " + r.harness + " in a terminal" : "no terminal found; run: bash " + r.script));
  });
  document.getElementById("add").onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    await api("/api/add", {name:f.get("name"), url:f.get("url"), key:f.get("key"), api:f.get("api")});
    e.target.reset(); render();
  };
}
render();
</script></body></html>`;

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(PAGE, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/state") return json(await state());
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    try {
      switch (url.pathname) {
        case "/api/add": {
          const api = str("api");
          addProvider({
            name: str("name") || "provider",
            apiUrl: str("url"),
            apiKey: str("key"),
            api: api === "messages" || api === "responses" ? api : "chat",
          });
          return json({ ok: true });
        }
        case "/api/remove":
          removeProvider(str("id"));
          return json({ ok: true });
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
          const h = HARNESSES.find((x) => x.id === harnessId);
          if (!h) throw new Error(`unknown harness: ${harnessId}`);
          let installed = "";
          if (!harnessInstalled(h)) {
            const r = installHarness(harnessId);
            installed = r.command;
          }
          const found = (await listModels(provider.id)).find((m) => m.id === model);
          const res = await run({ harnessId, model, context: found?.contextWindow, vision: found?.vision });
          const opened = openScriptInTerminal(res.script, res.plan.harness.label);
          return json({ ok: true, installed, opened: opened.opened, harness: res.plan.harness.id, script: opened.path });
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