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
  $("status").textContent = `${status.state === "paused" ? "Paused" : "Running"}. Models folder ${status.modelsFolder.path}, ${gib(status.modelsFolder.free)} free.`;

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
    const button = document.createElement("button");
    button.textContent = "Revoke";
    button.onclick = () => {
      if (confirm(`Revoke ${c.name}? It will need to pair again.`)) api(`/dashboard/clients/${c.fingerprint}`, { method: "DELETE" }).then(refresh, show);
    };
    row.insertCell().append(button);
  }
}

$("login").onsubmit = (e) => {
  e.preventDefault();
  api("/dashboard/login", { method: "POST", body: JSON.stringify({ password: $("login-password").value }) })
    .then(() => { $("login-password").value = ""; show(); return refresh(); }, show);
};
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
