// The host dashboard. Plain DOM, no build step.
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "content-type": "application/json" }, credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status}).`);
  return body;
}

function show(error) {
  $("error").textContent = error ? error.message ?? String(error) : "";
}

function gib(bytes) {
  return bytes == null ? "?" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

async function refresh() {
  const me = await api("/dashboard/me");
  $("name").textContent = me.name;
  $("fingerprint").textContent = me.fingerprint;
  if (me.access === null) {
    $("login").hidden = false;
    $("main").hidden = true;
    $("login-note").textContent = me.passwordSet ? "" : "No password is set yet. Set one on the dashboard at the machine (http://127.0.0.1:7236).";
    return;
  }
  $("login").hidden = true;
  $("main").hidden = false;
  $("signout-row").hidden = me.access !== "password";
  $("password-current").hidden = me.access !== "password";
  $("password-note").textContent = me.passwordSet ? "Needed to open this dashboard from another machine." : "Not set: the dashboard opens only at this machine until you set one.";

  const status = await api("/host/v1/status");
  const states = { running: "Running", pausing: "Pausing: finishing the current job", paused: "Paused", restarting: "Restarting" };
  $("status").textContent = `${states[status.state] ?? status.state}. Models folder ${status.modelsFolder.path}, ${gib(status.modelsFolder.free)} free (to change it, run host/install.sh --models /new/path on this machine).`;
  if (status.problems?.length) $("status").textContent += ` Problems: ${status.problems.join(" ")}`;
  $("pause").hidden = status.state !== "running";
  $("resume").hidden = status.state === "running" || status.state === "restarting";
  renderGpus(status.gpus);
  const { models } = await api("/host/v1/models");
  renderModels(models, status.gpus);
  await renderDownloads();
  await renderRecipes();
  const usage = await api("/host/v1/usage");
  const table = $("usage");
  table.replaceChildren();
  if (!usage.models.length) table.insertRow().insertCell().textContent = "Nothing yet.";
  for (const u of usage.models) {
    const row = table.insertRow();
    row.insertCell().textContent = u.id;
    row.insertCell().textContent = `${u.requests} requests, ${u.promptTokens + u.completionTokens} tokens${u.images ? `, ${u.images} images` : ""}, ${Math.round(u.seconds)} s`;
  }
  $("pairing-section").hidden = me.access === "client";
  $("password-section").hidden = me.access === "client";
  if (me.access !== "client") await renderClients();
}

function button(label, onclick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => Promise.resolve(onclick()).then(refresh, show);
  return b;
}

const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

function renderGpus(gpus) {
  const box = $("gpus");
  box.replaceChildren();
  if (!gpus.length) box.textContent = "No GPUs found.";
  for (const g of gpus) {
    const div = document.createElement("div");
    const head = document.createElement("p");
    head.textContent = `GPU ${g.index}: ${g.name}, ${gib(g.vram.used)} of ${gib(g.vram.total)} used. Queue: ${g.queue.chat} chat, ${g.queue.image} image, ${g.queue.background} background. `;
    // What it may run, how much it keeps free, or left out entirely.
    const put = (change) => api(`/host/v1/gpus/${g.index}`, { method: "PUT", body: JSON.stringify({ ...g.settings, ...change }) }).then(refresh, (e) => { show(e); refresh(); });
    for (const [server, label] of [["llamacpp", "llama.cpp"], ["vllm", "vLLM"], ["images", "images"]]) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = g.settings.servers.includes(server);
      box.onchange = () => put({ servers: box.checked ? [...g.settings.servers, server] : g.settings.servers.filter((x) => x !== server) });
      const tag = document.createElement("label");
      tag.append(box, ` ${label} `);
      head.append(tag);
    }
    const out = document.createElement("input");
    out.type = "checkbox";
    out.checked = g.settings.excluded;
    out.onchange = () => put({ excluded: out.checked });
    const outLabel = document.createElement("label");
    outLabel.append(out, " left out ");
    head.append(outLabel, ` keeps ${gib(g.settings.keepFree)} free`);
    div.append(head);
    const list = document.createElement("ul");
    for (const m of g.models) {
      const li = document.createElement("li");
      li.textContent = `${m.id} (${m.state}${m.gpus.length > 1 ? `, split over GPUs ${m.gpus.join(" and ")}` : ""}${m.pinned ? ", pinned" : ""}${m.busy ? ", busy" : ""}, ${gib(m.vram)} here) `;
      if (!m.pinned) li.append(button("Unload", () => post("/host/v1/models/unload", { model: m.id })));
      list.append(li);
    }
    div.append(list);
    box.append(div);
  }
}

function renderModels(models, gpus) {
  const table = $("models");
  table.replaceChildren();
  if (!models.length) table.insertRow().insertCell().textContent = "No text models found in the models folder.";
  void gpus;
  for (const m of models) {
    const row = table.insertRow();
    row.insertCell().textContent = m.id;
    const where = m.placement.mode === "auto" ? "auto" : `GPU ${m.placement.gpus.join("+")}`;
    row.insertCell().textContent = `${m.kind}, ${m.server}, ${gib(m.size)}, ${where}, ${m.contextLength ?? "?"} context`;
    const actions = row.insertCell();
    if (m.state === "unloaded") actions.append(button("Load", () => post("/host/v1/models/load", { model: m.id })));
    else actions.append(button("Reload", () => post("/host/v1/models/reload", { model: m.id })));
    actions.append(" ", button(m.pinned ? "Unpin" : "Pin", () => post("/host/v1/models/pin", { model: m.id, pinned: !m.pinned })));
    actions.append(" ", button("Settings", () => editSettings(m)));
  }
}

/** Placement and serving settings, edited as JSON; the host says why a change can't work. */
async function editSettings(m) {
  const { settings } = await api(`/host/v1/models/settings?model=${encodeURIComponent(m.id)}`);
  const text = prompt(`Settings for ${m.id} (placement { "mode": "auto" } or { "mode": "gpus", "gpus": [0, 1] }; contextLength, and more in the host's API.md). They apply at the next load, or on Reload.`, JSON.stringify(settings));
  if (text === null) return;
  let next;
  try {
    next = JSON.parse(text);
  } catch {
    throw new Error("That isn't valid JSON.");
  }
  await api("/host/v1/models/settings", { method: "PUT", body: JSON.stringify({ model: m.id, settings: next }) });
}

async function renderRecipes() {
  const { recipes } = await api("/host/v1/recipes").catch(() => ({ recipes: [] }));
  const table = $("recipes");
  table.replaceChildren();
  if (!recipes.length) table.insertRow().insertCell().textContent = "None yet: install a starter, or put image models in the models folder and scan.";
  for (const r of recipes.filter((x) => x.state !== "ignored")) {
    const row = table.insertRow();
    row.insertCell().textContent = r.name;
    const missing = r.parts.filter((p) => !p.file || p.missing).length;
    row.insertCell().textContent = `${r.arch}, ${r.does.join(" and ")}${r.state === "proposed" ? ", proposed" : ""}${r.ready ? "" : missing ? `, ${missing} part${missing > 1 ? "s" : ""} missing` : ", not ready"}`;
    const actions = row.insertCell();
    if (r.state === "proposed") {
      actions.append(button("Use", () => post(`/host/v1/recipes/${r.id}/confirm`)), " ", button("Ignore", () => post(`/host/v1/recipes/${r.id}/ignore`)));
    }
    if (missing) actions.append(" ", button("Download parts", () => post(`/host/v1/recipes/${r.id}/download-parts`)));
    actions.append(" ", button("Delete", () => confirm(`Delete ${r.name}? Parts the host downloaded that no other recipe uses are deleted too.`) && api(`/host/v1/recipes/${r.id}`, { method: "DELETE" })));
  }
  const { starters } = await api("/host/v1/starters").catch(() => ({ starters: [] }));
  const st = $("starters");
  st.replaceChildren();
  for (const s of starters) {
    const row = st.insertRow();
    row.insertCell().textContent = s.name;
    const have = s.parts.filter((p) => p.present).length;
    row.insertCell().textContent = `${have} of ${s.parts.length} parts here`;
    row.insertCell().append(button("Install", () => post(`/host/v1/starters/${s.id}/install`)));
  }
}

async function renderDownloads() {
  const { downloads } = await api("/host/v1/downloads").catch(() => ({ downloads: [] }));
  const table = $("downloads");
  table.replaceChildren();
  for (const d of downloads) {
    const row = table.insertRow();
    row.insertCell().textContent = d.path;
    const pct = d.size ? ` ${Math.floor((100 * d.received) / d.size)}%` : "";
    row.insertCell().textContent = d.state === "downloading" ? `downloading${pct}` : d.state === "done" && d.verified === false ? "done, unverified" : d.error ?? d.state;
    row.insertCell().append(button(["queued", "downloading", "verifying"].includes(d.state) ? "Cancel" : "Clear", () => api(`/host/v1/downloads/${d.id}`, { method: "DELETE" })));
  }
}

$("hub-form").onsubmit = (e) => {
  e.preventDefault();
  const source = $("hub-source").value;
  const repo = $("hub-repo").value.trim();
  const token = $("hub-token").value;
  const headers = { "content-type": "application/json", ...(token ? { "x-hub-token": token } : {}) };
  fetch(`/host/v1/hub/files?source=${source}&repo=${encodeURIComponent(repo)}`, { headers, credentials: "same-origin" })
    .then((r) => r.json().then((b) => (r.ok ? b : Promise.reject(new Error(b.error?.message)))))
    .then((listing) => {
      const table = $("hub-files");
      table.replaceChildren();
      for (const f of listing.files) {
        const row = table.insertRow();
        row.insertCell().textContent = f.path;
        row.insertCell().textContent = gib(f.size);
        const cell = row.insertCell();
        if (!f.allowed) cell.textContent = f.reason;
        else if (f.present) cell.textContent = "already here";
        else if (!f.fits) cell.textContent = "too big for the free space";
        else cell.append(button("Download", () =>
          fetch("/host/v1/downloads", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ source, repo, revision: listing.revision, files: [f.path] }) })
            .then((r) => r.json().then((b) => (r.ok ? b : Promise.reject(new Error(b.error?.message)))))));
      }
      show();
    }, show);
};
$("link-form").onsubmit = (e) => {
  e.preventDefault();
  const sha256 = $("link-sha").value.trim();
  post("/host/v1/downloads", { source: "url", url: $("link-url").value.trim(), ...(sha256 ? { sha256 } : {}) }).then(refresh, show);
};

async function renderClients() {
  const { clients } = await api("/dashboard/clients");
  const table = $("clients");
  table.replaceChildren();
  if (!clients.length) table.insertRow().insertCell().textContent = "None paired yet.";
  for (const c of clients) {
    const row = table.insertRow();
    row.insertCell().textContent = c.name;
    const fp = row.insertCell();
    fp.className = "mono muted";
    fp.textContent = `${c.fingerprint.slice(0, 16)}…`;
    row.insertCell().textContent = c.lastSeen ? `seen ${new Date(c.lastSeen).toLocaleString()}` : `paired ${new Date(c.pairedAt).toLocaleString()}`;
    const revoke = document.createElement("button");
    revoke.textContent = "Revoke";
    revoke.onclick = () => {
      if (confirm(`Revoke ${c.name}? It will need to pair again.`)) api(`/dashboard/clients/${c.fingerprint}`, { method: "DELETE" }).then(refresh, show);
    };
    row.insertCell().append(revoke);
  }
}

$("login").onsubmit = (e) => {
  e.preventDefault();
  api("/dashboard/login", { method: "POST", body: JSON.stringify({ password: $("login-password").value }) })
    .then(() => { $("login-password").value = ""; show(); return refresh(); }, show);
};
$("pause").onclick = () => post("/host/v1/pause").then(refresh, show);
$("resume").onclick = () => post("/host/v1/resume").then(refresh, show);
$("restart").onclick = () => confirm("Restart? Queued requests fail, and pinned models load again.") && post("/host/v1/restart").then(refresh, show);
$("scan").onclick = () => post("/host/v1/scan").then(refresh, show);
$("signout").onclick = () => api("/dashboard/logout", { method: "POST" }).then(refresh, show);
$("pair").onclick = () =>
  api("/dashboard/pairing", { method: "POST" }).then((made) => {
    $("code").textContent = made.code;
    $("code-expires").textContent = new Date(made.expiresAt).toLocaleTimeString();
    $("code-box").hidden = false;
  }, show);
$("password-form").onsubmit = (e) => {
  e.preventDefault();
  const body = { password: $("password-new").value };
  if (!$("password-current").hidden) body.current = $("password-current").value;
  api("/dashboard/password", { method: "POST", body: JSON.stringify(body) })
    .then(() => { $("password-new").value = ""; $("password-current").value = ""; show(); return refresh(); }, show);
};

refresh().catch(show);
setInterval(() => refresh().catch(show), 10_000);
