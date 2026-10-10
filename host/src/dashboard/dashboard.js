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
  $("status").textContent = `${states[status.state] ?? status.state}. Models folder ${status.modelsFolder.path}, ${gib(status.modelsFolder.free)} free.`;
  $("pause").hidden = status.state !== "running";
  $("resume").hidden = status.state === "running" || status.state === "restarting";
  renderGpus(status.gpus);
  const { models } = await api("/host/v1/models");
  renderModels(models, status.gpus);
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
    const role = document.createElement("select");
    for (const [value, label] of [["shared", "Shared (llama.cpp, images)"], ["vllm", "vLLM (whole GPU)"]]) role.add(new Option(label, value, false, g.role === value));
    role.onchange = () => api(`/host/v1/gpus/${g.index}`, { method: "PUT", body: JSON.stringify({ role: role.value }) }).then(refresh, (e) => { show(e); refresh(); });
    head.append(role);
    div.append(head);
    const list = document.createElement("ul");
    for (const m of g.models) {
      const li = document.createElement("li");
      li.textContent = `${m.id} (${m.state}${m.pinned ? ", pinned" : ""}${m.busy ? ", busy" : ""}, ${gib(m.vram)}) `;
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
  const shared = gpus.filter((g) => g.role === "shared");
  for (const m of models) {
    const row = table.insertRow();
    row.insertCell().textContent = m.id;
    row.insertCell().textContent = `${m.kind}, ${m.server}, ${gib(m.size)}`;
    const actions = row.insertCell();
    if (m.state === "unloaded") actions.append(button("Load", () => post("/host/v1/models/load", { model: m.id })));
    if (m.server === "llamacpp" && shared.length) {
      actions.append(m.pinned
        ? button("Unpin", () => post("/host/v1/models/pin", { model: m.id, gpu: m.gpu ?? shared[0].index, pinned: false }))
        : button(`Pin on GPU ${m.gpu ?? shared[0].index}`, () => post("/host/v1/models/pin", { model: m.id, gpu: m.gpu ?? shared[0].index, pinned: true })));
    }
  }
}

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
