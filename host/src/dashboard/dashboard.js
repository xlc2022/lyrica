// The host dashboard. Plain DOM, no build step; it follows Lyrica's interface rules (docs/ux.md).
const $ = (id) => document.getElementById(id);

/** An element: h("button", { class: "sm", onclick }, "Load"). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el[k] = v;
    else if (k === "class") el.className = v;
    else if (k === "hidden" || k === "disabled" || k === "checked" || k === "required") el[k] = !!v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const ICONS = { more: "M5 12h.01M12 12h.01M19 12h.01", close: "M6 6l12 12M18 6L6 18", right: "M9 5l7 7-7 7" };
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": name === "more" ? 3 : 1.75, "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "content-type": "application/json", ...options.headers }, credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `Request failed (${res.status}).`), { code: body.error?.code });
  return body;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

// An action's error stays in the banner until the user clicks it away or acts again; a refresh's error clears with the next good refresh.
let kept = false;
function show(error, keep = false) {
  if (!error && kept) return;
  kept = !!error && keep;
  $("error-text").textContent = error ? error.message ?? String(error) : "";
  $("error").hidden = !error;
}
const failed = (error) => show(error, true);
function dismiss() {
  kept = false;
  show();
}
$("error-dismiss").replaceChildren(icon("close"));
$("error-dismiss").addEventListener("click", dismiss);

/** Sizes as Lyrica writes them: "812.0 GB", "1.31 TB", "420 MB". */
function size(bytes) {
  if (bytes == null) return "?";
  if (bytes <= 0) return "0 GB";
  if (bytes >= 2 ** 40) return `${(bytes / 2 ** 40).toFixed(2)} TB`;
  if (bytes >= 0.1 * 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
}
const num = (n) => h("span", { class: "num" }, typeof n === "number" ? n.toLocaleString("en") : n);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function duration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
/** A facts line: values joined by " · ". */
const facts = (...parts) => h("p", { class: "facts" }, parts.filter(Boolean).flatMap((p, i) => (i ? [h("span", {}, "·"), p] : [p])));
const state = (word, dot, title) => h("span", { class: "state", title }, h("span", { class: `dot ${dot}` }), word);

/** Runs an action, then refreshes; a failure shows in the banner. */
const act = (fn) => () => {
  dismiss();
  return Promise.resolve(fn()).then(() => refresh(true), failed);
};
const button = (label, fn, cls = "sm") => h("button", { type: "button", class: cls, onclick: act(fn) }, label);

// ---- Menus, the drawer and the confirmation dialog ----

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.parentElement.contains(e.target)) closeMenu();
});

/** The ⋯ menu for a row's rare actions: [label, action, { danger }]. */
function rowMenu(label, items) {
  const wrap = h("div", { class: "row-menu" });
  const toggle = h("button", { type: "button", class: "icon sm", "aria-label": `More for ${label}`, "aria-haspopup": "menu" }, icon("more"));
  toggle.onclick = () => {
    const was = openMenu?.parentElement === wrap;
    closeMenu();
    if (was) return;
    openMenu = h("div", { class: "menu", role: "menu" },
      items.filter(Boolean).map(([text, fn, opts = {}]) => h("button", { type: "button", role: "menuitem", class: opts.danger ? "danger" : undefined, onclick: () => { closeMenu(); act(fn)(); } }, text)));
    wrap.append(openMenu);
  };
  wrap.append(toggle);
  return wrap;
}

/** Asks first: the sentence and two buttons. Resolves true on the action. */
function confirmFirst(text, ok, danger = false) {
  const dlg = $("confirm");
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = ok;
  $("confirm-ok").className = danger ? "danger primary" : "primary";
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true }));
}

let drawer = null;
function closeDrawer() {
  drawer?.forEach((el) => el.remove());
  drawer = null;
  render();
}
/** Edits one thing in context: a title, its facts, the fields and one Save. save() throws to keep it open. */
function openDrawer({ title, sub, fields, save, saveLabel = "Save", saveTitle }) {
  closeDrawer();
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const form = h("form", { class: "drawer", role: "dialog", "aria-label": title },
    h("div", { class: "drawer-head" },
      h("div", { class: "head-title" }, h("h2", {}, title), sub ? h("p", { class: "facts" }, sub) : null),
      h("button", { type: "button", class: "icon sm", "aria-label": "Close", onclick: closeDrawer }, icon("close"))),
    h("div", { class: "drawer-body" }, fields, error),
    h("div", { class: "drawer-foot" }, h("button", { type: "submit", class: "primary", title: saveTitle }, saveLabel)));
  form.onsubmit = (e) => {
    e.preventDefault();
    error.hidden = true;
    Promise.resolve(save()).then((keep) => {
      if (keep === false) return;
      closeDrawer();
      refresh(true);
    }, (err) => {
      error.textContent = err.message;
      error.hidden = false;
    });
  };
  // A block body: a handler property that returns false cancels the key, so no field could be typed in.
  form.onkeydown = (e) => {
    if (e.key === "Escape") closeDrawer();
  };
  drawer = [h("div", { class: "scrim", onclick: closeDrawer }), form];
  document.body.append(...drawer);
  form.querySelector("input, select, textarea")?.focus();
}

const field = (label, input, title) => h("label", { class: "field", title }, h("span", {}, label), input);

// ---- State and refreshing ----

const S = { me: null, status: null, models: [], downloads: [], recipes: [], starters: [], textStarters: [], usage: [], clients: [], code: null, hub: { source: "huggingface", repo: "", token: "", url: "", sha: "", listing: null } };
// What the user has set on the page: searches, chips, open groups (true or false once toggled), the picked starters.
const UI = { textQ: "", textShow: "all", open: new Map(), source: "starters", q: "", show: "all", does: "all", pick: {} };

const SECTIONS = [
  ["overview", "Overview"], ["text", "Text models"], ["images", "Image models"], ["downloads", "Downloads"], ["usage", "Usage"], ["servers", "Lyrica servers"], ["password", "Password"],
];
// Pages under a section: the two download pages.
const PAGES = { "download-text": "text", "download-image": "images" };
const ownerOnly = new Set(["servers", "password"]);
const page = () => (location.hash.slice(1) in PAGES ? location.hash.slice(1) : null);
const section = () => {
  const want = PAGES[location.hash.slice(1)] ?? location.hash.slice(1);
  const allowed = SECTIONS.filter(([k]) => S.me?.access !== "client" || !ownerOnly.has(k)).map(([k]) => k);
  return allowed.includes(want) ? want : "overview";
};
window.addEventListener("hashchange", () => {
  closeMenu();
  // A download page starts from its starters, with nothing searched or picked.
  Object.assign(UI, { source: "starters", q: "", show: "all", does: "all", pick: {} });
  S.hub.listing = null;
  if (drawer) closeDrawer();
  else render();
});

/** Something the user has open, which a timed refresh mustn't redraw under them. */
const busy = () => !!(drawer || openMenu || $("confirm").open || document.activeElement?.closest?.("#content form"));
const going = (d) => ["queued", "downloading", "uploading", "verifying"].includes(d.state);

async function refresh(force = false) {
  if (!force && busy()) return;
  const me = await api("/dashboard/me");
  S.me = me;
  if (me.access === null) {
    $("login").hidden = false;
    $("main").hidden = true;
    $("login-name").textContent = me.name;
    $("login-fingerprint").textContent = me.fingerprint;
    $("login-unset").hidden = me.passwordSet;
    return;
  }
  const [status, models, downloads, recipes, starters, textStarters, usage, clients] = await Promise.all([
    api("/host/v1/status"),
    api("/host/v1/models").catch(() => ({ models: [] })),
    api("/host/v1/downloads").catch(() => ({ downloads: [] })),
    api("/host/v1/recipes").catch(() => ({ recipes: [] })),
    api("/host/v1/starters").catch(() => ({ starters: [] })),
    api("/host/v1/text-starters").catch(() => ({ starters: [] })),
    api("/host/v1/usage").catch(() => ({ models: [] })),
    me.access === "client" ? { clients: [] } : api("/dashboard/clients"),
  ]);
  Object.assign(S, { status, models: models.models, downloads: downloads.downloads, recipes: recipes.recipes.filter((r) => r.state !== "ignored"), starters: starters.starters, textStarters: textStarters.starters, usage: usage.models, clients: clients.clients });
  show();
  if (!busy() || force) render();
}

// ---- The header ----

const STATES = { running: ["Running", "up"], pausing: ["Pausing", "away", "Finishing the current job."], paused: ["Paused", "away"], restarting: ["Restarting", "info"] };
const BACKENDS = { cuda: "CUDA", rocm: "ROCm", vulkan: "Vulkan" };

function renderHead() {
  const { me, status } = S;
  $("login").hidden = true;
  $("main").hidden = false;
  document.title = `${me.name} · Lyrica model host`;
  $("name").textContent = me.name;
  $("fingerprint").textContent = me.fingerprint;
  const [word, dot, why] = STATES[status.state] ?? [status.state, ""];
  $("state").replaceWith(Object.assign(state(word, dot, why), { id: "state" }));
  $("facts").replaceChildren(...facts(
    status.version ? h("span", {}, "version ", h("code", {}, status.version)) : null,
    h("span", { title: "To change it, run host/install.sh --models /new/path on this machine, or use Edit on this host in Lyrica." }, "models folder ", h("code", {}, status.modelsFolder.path)),
    h("span", {}, num(size(status.modelsFolder.free)), " free"),
    status.backend ? h("span", {}, BACKENDS[status.backend] ?? status.backend) : null,
  ).childNodes);
  const running = status.state === "running";
  $("head-actions").replaceChildren(
    h("button", { type: "button", class: "sm", disabled: status.state === "restarting", onclick: act(() => post(running ? "/host/v1/pause" : "/host/v1/resume")) }, running ? "Pause" : "Resume"),
    rowMenu(me.name, [
      ["Restart…", async () => (await confirmFirst(`Restart ${me.name}? Queued requests fail, and pinned models load again.`, "Restart")) && post("/host/v1/restart")],
      me.access === "password" && ["Sign out", () => post("/dashboard/logout")],
    ]),
  );
  const problems = status.problems ?? [];
  $("problems").hidden = !problems.length;
  $("problems").replaceChildren(...problems.map((p) => h("p", { class: "warn-text" }, p)));

  const queue = S.downloads.filter(going).length;
  const current = section();
  $("subnav").replaceChildren(...SECTIONS.filter(([k]) => me.access !== "client" || !ownerOnly.has(k)).map(([k, label]) =>
    h("a", { href: `#${k}`, "aria-current": k === current ? "page" : undefined }, label,
      k === "downloads" && queue ? h("span", { class: "badge", "aria-label": `${queue} running` }, String(queue)) : null)));
  // On a phone the sections are a scrolling row: the current one stays in view.
  $("subnav").querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function render() {
  if (!S.status) return;
  renderHead();
  const draw = page() ? () => downloadPage(page() === "download-text" ? "text" : "image")
    : { overview, text: textModels, images: imageModels, downloads: downloadsSection, usage: usageSection, servers: serversSection, password: passwordSection }[section()];
  // A redraw keeps the keyboard where it was: the search box and its caret, a chip, a group's heading.
  const at = document.activeElement?.closest?.("#content") ? document.activeElement : null;
  const caret = at?.type === "search" ? at.selectionStart : null;
  $("content").replaceChildren(...draw().filter(Boolean));
  const again = at?.id ? document.getElementById(at.id) : null;
  again?.focus();
  if (again && caret != null) again.setSelectionRange(caret, caret);
}

/** A section's head: its title, a facts line under it, its actions at the right. */
const sectionHead = (title, sub, ...actions) => h("div", { class: "section-head" }, h("div", { class: "st" }, title, sub), actions);
/** A model as a line shows it, as Lyrica does: its file's name without the extension, the whole ID as the tooltip. */
const short = (id) => id.split("/").pop().replace(/\.(gguf|safetensors|bin)$/i, "") || id;
const shortName = (id) => h("span", { title: short(id) === id ? undefined : id }, short(id));
const plural = (count, one, many) => [num(count), ` ${count === 1 ? one : many}`];
/** A toggle that stays pressed: a chip, or a button of a segmented control. Its id lets a redraw keep the focus on it. */
const toggle = (id, label, pressed, on, cls) => h("button", { type: "button", id, class: cls, "aria-pressed": String(pressed), onclick: () => { on(); render(); } }, label);
const search = (id, key, label, placeholder) => h("input", { type: "search", id, "aria-label": label, placeholder, value: UI[key], oninput: (e) => { UI[key] = e.target.value; render(); } });
/** A collapsible group: open by `open` until the user toggles it, then as they left it; `force` opens it whatever they did. */
function group(key, open, name, count, rows, force = false) {
  const isOpen = force || (UI.open.get(key) ?? open);
  const summary = h("summary", { id: `group-${key}`, onclick: (e) => { e.preventDefault(); UI.open.set(key, !isOpen); render(); } }, icon("right"), h("span", { class: "group-name" }, name), h("span", { class: "cap" }, count));
  return h("details", { class: "group", open: isOpen ? "" : undefined }, summary, isOpen ? rows : null);
}

// ---- GPUs ----

const SERVERS = [["llamacpp", "llama.cpp"], ["vllm", "vLLM"], ["images", "Images"], ["speech", "Speech"]];

/** "loading, 64%", as Lyrica's host card says it: how much of the model's files the server has read from disk. */
function loadingWord(id) {
  const l = S.models.find((m) => m.id === id)?.loading;
  return l?.of ? `loading, ${Math.min(100, Math.floor((100 * l.read) / l.of))}%` : "loading";
}

function overview() {
  const { gpus: list, servers, modelsFolder } = S.status;
  const loaded = S.models.filter((m) => m.state === "loaded").length, loading = S.models.filter((m) => m.state === "loading").length;
  const pinned = S.models.filter((m) => m.pinned).length, images = S.recipes.filter((r) => r.state === "confirmed").length;
  const used = list.reduce((n, g) => n + g.vram.used, 0), total = list.reduce((n, g) => n + g.vram.total, 0);
  const running = S.downloads.filter(going).length;
  const tile = (href, label, value, sub) => h(href ? "a" : "div", { class: "tile", href }, h("span", { class: "k" }, label), h("span", { class: "v" }, value), h("span", { class: "s" }, sub));
  const dots = (...parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [" · ", p] : [p])).flat();
  const head = sectionHead(h("h2", {}, "Overview"), null,
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "seg-pinned" }), "Pinned"), h("span", {}, h("i", { class: "seg-loaded" }), "Loaded on demand"),
      S.status.systemRam?.allowance ? h("span", {}, h("i", { class: "seg-ram" }), "In system RAM") : null));
  const tiles = h("div", { class: "tiles" },
    list.length ? tile(null, "GPU memory", [h("b", {}, size(used).split(" ")[0]), " of ", num(size(total))], plural(list.length, "GPU", "GPUs")) : null,
    tile("#text", "Models", [h("b", {}, String(loaded)), " of ", num(S.models.length), " loaded"],
      dots(pinned ? [num(pinned), " pinned"] : null, loading ? [num(loading), " loading"] : null, plural(images, "image model", "image models"))),
    tile("#downloads", "Models folder", [h("b", {}, size(modelsFolder.free).split(" ")[0]), " ", num(size(modelsFolder.free).split(" ")[1]), " free"], running ? [num(running), " downloading"] : "no downloads running"));
  if (!list.length) return [head, tiles, h("p", { class: "empty" }, "No GPUs found."), ...cpu(), ...systemRam()];
  return [head, tiles, ...list.map((g) => {
    const allowed = SERVERS.filter(([s]) => servers.includes(s) && g.settings.servers.includes(s)).map(([, l]) => l);
    const waiting = [["chat", g.queue.chat], ["image", g.queue.image], ["background", g.queue.background]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
    return h("section", { class: "card" },
      h("div", { class: "gpu-line" },
        h("h3", {}, "GPU ", num(g.index), ` · ${g.name}`, ...(g.pciId ? [" · ", num(g.pciId)] : [])),
        g.settings.excluded ? h("span", { class: "pill warn", title: "Nothing loads on it." }, "left out") : null,
        h("button", { type: "button", class: "sm", onclick: () => editGpu(g) }, "Edit")),
      facts(h("span", {}, num(size(g.vram.used)), " of ", num(size(g.vram.total)), " used"),
        g.integrated ? h("span", {}, "integrated") : null,
        h("span", {}, allowed.length ? allowed.join(", ") : "no servers"),
        h("span", {}, "keeps ", num(size(g.settings.keepFree)), " free")),
      h("div", { class: "bar", role: "img", "aria-label": `${size(g.vram.used)} of ${size(g.vram.total)} used` },
        g.models.map((m) => h("span", { class: m.pinned ? "seg-pinned" : "seg-loaded", style: `width:${Math.min(100, (100 * m.vram) / g.vram.total)}%`, title: `${short(m.id)}: ${size(m.vram)}` }))),
      g.models.length ? h("ul", { class: "model-list" }, g.models.map((m) =>
        h("li", {}, shortName(m.id),
          h("span", { class: "muted" }, `(${[m.pinned ? "pinned" : m.state === "loading" ? loadingWord(m.id) : "loaded", m.busy ? "busy" : null, m.gpus.length > 1 ? `split over GPUs ${m.gpus.join(" and ")}` : null].filter(Boolean).join(" · ")})`),
          h("span", { class: "num muted" }, size(m.vram)),
          m.pinned ? null : button(m.state === "loading" ? "Cancel" : "Unload", () => post("/host/v1/models/unload", { model: m.id }))))) : null,
      waiting.length ? h("p", { class: "facts" }, `Waiting: ${waiting.join(", ")}`) : null);
  }), ...cpu(), ...systemRam()];
}

/** The CPU, as a card after the GPUs: its cores and threads, the machine's memory, and the servers that run on it. */
function cpu() {
  const m = S.status.machine;
  if (!m) return [];
  const on = SERVERS.filter(([s]) => (S.status.cpuServers ?? []).includes(s)).map(([, l]) => l);
  return [h("section", { class: "card" },
    h("div", { class: "gpu-line" }, h("h3", {}, "CPU", ...(m.cpu ? [` · ${m.cpu}`] : []))),
    facts(h("span", {}, num(m.cores), " cores"), h("span", {}, num(m.threads), " threads"), h("span", {}, num(size(m.memory)), " RAM"),
      on.length ? h("span", {}, on.join(", ")) : null))];
}

const RAM_TIP = "Memory a llama.cpp model may keep in system RAM when it doesn't fit the GPUs. It runs slower. Empty is off. vLLM and image models don't use it.";

/** The system RAM allowance, as a card after the GPUs: what spilled models keep there, and Edit. */
function systemRam() {
  const r = S.status.systemRam;
  if (!r || !S.status.servers.includes("llamacpp")) return [];
  return [h("section", { class: "card" },
    h("div", { class: "gpu-line" }, h("h3", { title: RAM_TIP }, "System RAM"),
      r.allowance ? null : h("span", { class: "pill" }, "off"),
      h("button", { type: "button", class: "sm", onclick: () => editRam(r) }, "Edit")),
    facts(r.allowance ? h("span", {}, num(size(r.used)), " of ", num(size(r.allowance)), " used") : null, h("span", {}, "llama.cpp")),
    r.allowance ? h("div", { class: "bar", role: "img", "aria-label": `${size(r.used)} of ${size(r.allowance)} used` },
      r.models.map((m) => h("span", { class: "seg-ram", style: `width:${Math.min(100, (100 * m.ram) / r.allowance)}%`, title: `${short(m.id)}: ${size(m.ram)}` }))) : null,
    r.models.length ? h("ul", { class: "model-list" }, r.models.map((m) => h("li", {}, shortName(m.id), h("span", { class: "num muted" }, size(m.ram))))) : null)];
}

function editRam(r) {
  const most = Math.floor(r.most / 2 ** 30);
  const input = h("input", { type: "number", min: "0", max: String(most), step: "1", placeholder: "Off", value: r.allowance ? String(Math.round(r.allowance / 2 ** 30)) : "", class: "num" });
  openDrawer({
    title: "System RAM",
    sub: [h("span", {}, num(size(r.total)), " in this machine")],
    fields: [field("System RAM (GB)", h("span", { class: "with-unit" }, input, h("span", { class: "muted" }, "of ", num(most))), RAM_TIP)],
    save: () => {
      const gb = input.value.trim() ? Math.min(most, Math.max(0, Math.round(Number(input.value) || 0))) : 0;
      return api("/host/v1/memory", { method: "PUT", body: JSON.stringify({ systemRam: gb * 2 ** 30 }) });
    },
  });
}

function editGpu(g) {
  const boxes = SERVERS.filter(([s]) => S.status.servers.includes(s)).map(([s, label]) => [s, h("input", { type: "checkbox", checked: g.settings.servers.includes(s) }), label]);
  const keep = h("input", { type: "number", min: "0", step: "0.5", value: (g.settings.keepFree / 2 ** 30).toFixed(1), class: "num" });
  const out = h("input", { type: "checkbox", checked: g.settings.excluded });
  openDrawer({
    title: `GPU ${g.index}`,
    sub: [h("span", {}, g.name)],
    fields: [
      h("fieldset", {}, h("legend", {}, "Servers"), boxes.map(([, box, label]) => h("label", { class: "check" }, box, label))),
      field("Keep free (GB)", keep, "Memory loads leave unused, for the system or other programs."),
      h("label", { class: "check", title: "Nothing loads on it." }, out, "Left out"),
    ],
    save: () => api(`/host/v1/gpus/${g.index}`, { method: "PUT", body: JSON.stringify({ servers: boxes.filter(([, b]) => b.checked).map(([s]) => s), keepFree: Math.round(Number(keep.value) * 2 ** 30), excluded: out.checked }) }),
  });
}

// ---- Models ----

const KINDS = { chat: "chat", embedding: "embedding", transcribe: "transcription", speak: "voice" };
const SERVER_NAMES = { ...Object.fromEntries(SERVERS), whispercpp: "whisper.cpp" };
/** A model's or starter's server, by name; GLM-SGLang for one SGLang serves in vLLM's place. */
const serverName = (x) => (x.engine === "sglang" ? "GLM-SGLang" : SERVER_NAMES[x.server] ?? x.server);

/** Load waits for the whole load; one stopped with Cancel is no error to show. */
const loadModel = (id) => post("/host/v1/models/load", { model: id }).catch((e) => {
  if (e.code !== "load_cancelled") throw e;
});

function textModels() {
  const loaded = S.models.filter((m) => m.state !== "unloaded");
  const head = sectionHead(h("h2", {}, "Text models"), facts(h("span", {}, plural(S.models.length, "model", "models")), h("span", {}, num(S.models.filter((m) => m.state === "loaded").length), " loaded"),
    loaded.length - S.models.filter((m) => m.state === "loaded").length ? h("span", {}, num(S.models.filter((m) => m.state === "loading").length), " loading") : null),
    h("button", { type: "button", onclick: act(() => post("/host/v1/scan")) }, "Scan the folder"), h("a", { class: "button primary", href: "#download-text" }, "Download text model"));
  if (!S.models.length) return [head, h("ul", { class: "list" }, h("li", { class: "empty" }, "No text or voice models in the models folder."))];
  const cpu = S.status.cpuServers ?? [];
  const words = UI.textQ.trim().toLowerCase().split(" ").filter(Boolean);
  const kept = (UI.textShow === "loaded" ? loaded : S.models).filter((m) => words.every((w) => `${m.id} ${KINDS[m.kind] ?? m.kind} ${serverName(m)}`.toLowerCase().includes(w)));
  const filters = h("div", { class: "filters" }, search("text-q", "textQ", "Search text models", "Search by name"),
    h("div", { class: "chip-row", role: "group", "aria-label": "Show" },
      [["all", "All", S.models.length], ["loaded", "Loaded", loaded.length]].map(([k, label, count]) => toggle(`text-show-${k}`, [label, " ", num(count)], UI.textShow === k, () => (UI.textShow = k), "chip"))));
  return [head, filters, h("ul", { class: "list" }, kept.length ? kept.map((m) => {
    const where = cpu.includes(m.server) ? "CPU" : m.placement.mode === "auto" ? "placed automatically" : `GPU ${m.placement.gpus.join("+")}`;
    // While loading, how much of the model has been read from disk; a model already in the page cache reads nothing and shows no percent.
    const pct = m.state === "loading" && m.loading?.of ? Math.min(100, Math.floor((100 * m.loading.read) / m.loading.of)) : null;
    const [word, dot] = m.state === "loaded" ? ["Loaded", "up"] : m.state === "loading" ? [pct == null ? "Loading" : h("span", {}, "Loading ", num(`${pct}%`)), "info"] : ["Unloaded", ""];
    const reading = pct == null ? undefined : `${size(m.loading.read)} of ${size(m.loading.of)} read from disk`;
    return h("li", {},
      h("div", { class: "main" },
        h("div", { class: "name" }, shortName(m.id), m.pinned ? h("span", { class: "pill" }, "pinned") : null),
        facts(h("span", {}, KINDS[m.kind] ?? m.kind), h("span", {}, serverName(m)), num(size(m.size)), h("span", {}, where),
          m.capabilities?.speak ? h("span", {}, num(m.capabilities.speak.voices.length), " voices") : null,
          m.contextLength ? h("span", {}, num(m.contextLength), " context") : null,
          m.stretch ? h("span", {}, "stretch ×", num(m.stretch)) : null,
          m.kvBytes ? h("span", {}, "KV ", num(size(m.kvBytes))) : null)),
      h("div", { class: "actions" },
        state(word, dot, reading),
        m.state === "unloaded" ? button("Load", () => loadModel(m.id))
          : h("button", { type: "button", class: "sm", disabled: m.pinned, title: m.pinned ? "Unpin it first." : undefined, onclick: act(() => post("/host/v1/models/unload", { model: m.id })) }, m.state === "loading" ? "Cancel" : "Unload"),
        h("button", { type: "button", class: "sm", onclick: () => editModel(m).catch(failed) }, "Settings"),
        rowMenu(short(m.id), [
          [m.pinned ? "Unpin" : "Pin", () => post("/host/v1/models/pin", { model: m.id, pinned: !m.pinned })],
          m.state !== "unloaded" && ["Reload", () => post("/host/v1/models/reload", { model: m.id })],
        ])));
  }) : h("li", { class: "empty" }, "No models match."))];
}

/** Downloads a starter's files at its pinned revision (host/src/text-starters.ts). */
const getStarter = (s) => post(`/host/v1/text-starters/${encodeURIComponent(s.id)}/download`, {});

const STARTER_GROUPS = { chat: "Chat", embedding: "Embedding", speak: "Voice", transcribe: "Voice" };

/** The text starters the host lists for its servers (host/API.md, "Text starters"), as the download page's choices: a model's sizes share a row. */
function textStarters() {
  const free = S.status.modelsFolder.free;
  return S.textStarters.map((s) => {
    const kinds = [KINDS[s.kind], s.vision ? "vision" : null];
    const installed = s.state !== "available";
    return {
      id: s.id, name: s.name, row: s.variantOf ?? s.name, variant: s.variant, group: STARTER_GROUPS[s.kind], words: [...kinds, serverName(s), s.variantOf, s.variant], bytes: s.size, installed,
      facts: [...kinds, serverName(s), [num(size(s.size)), " to download"], s.fits === "cpu" ? "CPU" : ["needs ", num(size(s.needs)), " of GPU memory"]],
      pill: s.state === "here" ? h("span", { class: "pill" }, "existing") : s.state === "downloading" ? h("span", { class: "pill info" }, "downloading")
        : s.size > free ? h("span", { class: "pill warn", title: `${size(s.size)} to download, ${size(free)} free.` }, "not enough space")
        : s.fits === "too_big" ? h("span", { class: "pill warn", title: "More than any GPU here can give it." }, "too big for these GPUs")
        : s.fits === "ram" ? h("span", { class: "pill warn", title: "Runs slower: part of it stays in system RAM." }, "uses system RAM") : null,
      off: installed || s.size > free || s.fits === "too_big",
      get: () => getStarter(s),
    };
  });
}

/** A model's placement and serving settings; what isn't a field stays as JSON under Other settings. */
async function editModel(m) {
  const info = await api(`/host/v1/models/settings?model=${encodeURIComponent(m.id)}`);
  const { placement = { mode: "auto" }, contextLength, stretch, parallel, maxSeqs, kvCacheType, memoryShare, systemRam: ramSetting, batchSize, ...rest } = info.settings;
  const { mode, gpus: chosen = [], ...placementRest } = placement;
  const llama = m.server === "llamacpp", vllm = m.server === "vllm", chat = m.kind === "chat";
  const usable = S.status.gpus.filter((g) => !g.settings.excluded);

  const where = h("select", {}, h("option", { value: "auto" }, "Automatic"), h("option", { value: "gpus" }, "Custom allocation"));
  where.value = mode === "gpus" ? "gpus" : "auto";
  const picks = usable.map((g) => [g.index, h("input", { type: "checkbox", checked: chosen.includes(g.index) })]);
  const gpuChecks = picks.map(([i, box]) => h("label", { class: "check", hidden: where.value !== "gpus" }, box, `GPU ${i} · ${usable.find((g) => g.index === i).name}`));
  // llama.cpp can keep part of a model in the host's System RAM allowance, up to the model's own limit in GB, when ticked.
  const allowance = S.status.systemRam?.allowance ?? 0;
  const allowGb = Math.floor(allowance / 2 ** 30);
  const ramBox = h("input", { type: "checkbox", checked: typeof ramSetting === "number", disabled: !allowance && typeof ramSetting !== "number" });
  const ramGb = h("input", { type: "number", min: "1", max: String(Math.max(1, allowGb)), step: "1", class: "num", "aria-label": "System RAM limit (GB)",
    value: typeof ramSetting === "number" ? Math.round(ramSetting / 2 ** 30) : Math.max(1, allowGb) });
  const ramLimit = h("span", { hidden: !ramBox.checked }, " up to ", ramGb, " of ", num(allowGb), " GB");
  ramBox.onchange = () => (ramLimit.hidden = !ramBox.checked);
  const ramCheck = llama ? h("div", { class: "row", style: "align-items: center" },
    h("label", { class: "check", title: allowance ? "Lets this model keep part of itself in system RAM, which is slower, for a longer context or a model too big for its GPUs. Unticked, it stays on its GPUs." : "The host's System RAM allowance is off; set it in the System RAM card on Overview." },
      ramBox, h("span", {}, "System RAM", allowance ? "" : " · off")), ramLimit) : null;
  const pickBox = h("fieldset", { hidden: where.value !== "gpus" && !llama }, h("legend", {}, "Memory"), gpuChecks, ramCheck);
  where.onchange = () => {
    gpuChecks.forEach((l) => (l.hidden = where.value !== "gpus"));
    pickBox.hidden = where.value !== "gpus" && !llama;
  };

  const ctx = h("input", { type: "number", min: "512", step: "1024", class: "num", value: contextLength ?? "", placeholder: String(info.contextLength ?? "") });
  const factor = h("input", { type: "number", min: "1", max: "8", step: llama ? "1" : "0.5", class: "num", value: stretch?.factor ?? "", placeholder: "none" });
  const card = h("p", { class: "facts" });
  const repo = h("input", { placeholder: "owner/name", hidden: true });
  const describe = (r) => card.replaceChildren(...facts(
    r ? h("span", {}, "card ", num(r.native ?? "?"), r.factor ? h("span", {}, " tokens, or ", num(r.stretched), " with a stretch of ", num(r.factor)) : " tokens, no stretch documented") : h("span", {}, "card not read"),
    h("button", { type: "button", class: "link", onclick: () => lookUp().catch((e) => { card.append(h("span", { class: "error" }, e.message)); }) }, "Look up")).childNodes);
  async function lookUp() {
    try {
      const entry = await post("/host/v1/models/lookup", { model: m.id, ...(repo.value.trim() ? { repo: repo.value.trim() } : {}) });
      repo.hidden = true;
      describe(entry.recommended);
    } catch (e) {
      if (e.code !== "need_repo") throw e;
      repo.hidden = false;
      repo.focus();
    }
  }
  describe(info.recommended);
  const atOnce = h("input", { type: "number", min: "1", class: "num", value: (llama ? parallel : maxSeqs) ?? "", placeholder: m.parallel ? String(m.parallel) : "" });
  const batch = h("input", { type: "number", min: "32", max: "65536", step: "32", class: "num", value: batchSize ?? "", placeholder: "llama.cpp's" });
  const kv = h("select", {}, ["", "f16", "q8_0", "q4_0"].map((v) => h("option", { value: v }, v || "Default (f16)")));
  kv.value = kvCacheType ?? "";
  const share = h("input", { type: "number", min: "5", max: "95", step: "5", class: "num", value: memoryShare ? Math.round(memoryShare * 100) : "", placeholder: "what it needs" });
  const other = h("textarea", { rows: "5", spellcheck: "false" });
  other.value = Object.keys(rest).length || Object.keys(placementRest).length ? JSON.stringify({ ...rest, ...(Object.keys(placementRest).length ? { placement: placementRest } : {}) }, null, 2) : "";

  const build = () => {
    let extra = {};
    if (other.value.trim()) {
      try { extra = JSON.parse(other.value); } catch { throw new Error("Other settings isn't valid JSON."); }
    }
    const { placement: extraPlacement, ...extraRest } = extra;
    const settings = { ...extraRest };
    settings.placement = where.value === "gpus" ? { ...extraPlacement, mode: "gpus", gpus: picks.filter(([, b]) => b.checked).map(([i]) => i) } : { mode: "auto" };
    if (llama && ramBox.checked) settings.systemRam = Math.max(1, Math.round(Number(ramGb.value) || allowGb)) * 2 ** 30;
    if (ctx.value) settings.contextLength = Number(ctx.value);
    if (chat && Number(factor.value) > 1) settings.stretch = { ...stretch, type: "yarn", factor: Number(factor.value) };
    if (atOnce.value) settings[llama ? "parallel" : "maxSeqs"] = Number(atOnce.value);
    if (llama && kv.value) settings.kvCacheType = kv.value;
    if (llama && batch.value) settings.batchSize = Number(batch.value);
    if (vllm && share.value) settings.memoryShare = Number(share.value) / 100;
    return settings;
  };
  const put = (anyway) => api("/host/v1/models/settings", { method: "PUT", body: JSON.stringify({ model: m.id, settings: build(), ...(anyway ? { anyway } : {}) }) });

  openDrawer({
    title: "Model settings",
    saveTitle: "They apply at the next load, or on Reload.",
    sub: [h("code", {}, m.id)],
    fields: [
      field("Placement", where), pickBox,
      info.contextLength != null ? field("Context length", ctx, "Unset: the largest that fits.") : null,
      chat ? h("div", { class: "field" }, field("Stretch", factor, info.stretchUntested ? "A YaRN factor, 1 to 8. Untested on vLLM for this model." : "A YaRN factor, 1 to 8."), card, repo) : null,
      chat && (llama || vllm) ? field("Requests at once", atOnce, "Unset: by its context, 1 below 200k tokens.") : null,
      llama ? field("Batch size", batch, "Tokens per step, 32 to 65,536. Unset: llama.cpp's default.") : null,
      llama ? field("KV cache", kv, "q8_0 and q4_0 need flashAttention on, under Other settings.") : null,
      vllm ? field("Memory share (%)", share, "Of each of its GPUs. Unset: what it needs.") : null,
      field("Other settings", other, "JSON: flashAttention, gpuLayers, batchSize, chatTemplate and the rest in the host's API.md."),
    ],
    save: async () => {
      try {
        await put(false);
      } catch (e) {
        // A stretch past the publisher's: saved only on purpose.
        if (e.code !== "above_recommended") throw e;
        if (!(await confirmFirst(`${e.message} Save the stretch anyway?`, "Save anyway"))) return false;
        await put(true);
      }
    },
  });
}

// ---- Image models ----

const doesWord = (d) => (d === "create" ? "generate" : d === "upscale_video" ? "upscale clips" : d === "edit_video" ? "edit clips" : d);
/** Which Does an action falls under: clips, animating and motion are all Video. */
const doesKind = (d) => (d === "create" || d === "edit" ? d : d === "upscale" || d === "upscale_video" ? "upscale" : "video");
const unique = (list) => [...new Set(list)];

function imageModels() {
  const head = sectionHead(h("h2", {}, "Image models"), facts(h("span", {}, plural(S.recipes.length, "model", "models")), h("span", {}, plural(unique(S.recipes.map((r) => r.arch)).length, "group", "groups"))),
    h("button", { type: "button", onclick: act(() => post("/host/v1/scan")) }, "Scan the folder"), h("a", { class: "button primary", href: "#download-image" }, "Download image model"));
  if (!S.recipes.length) return [head, h("ul", { class: "list" }, h("li", { class: "empty" }, "None yet."))];
  const missing = (r) => r.parts.filter((p) => !p.file || p.missing).length;
  const review = (r) => r.state === "proposed" || missing(r) > 0;
  const row = (r) => {
    const lacks = missing(r);
    const badge = r.state === "proposed" ? h("span", { class: "pill info", title: "Found in the models folder; Use adds it." }, "proposed")
      : lacks ? h("span", { class: "pill warn" }, `${lacks} part${lacks > 1 ? "s" : ""} missing`)
      : r.ready ? state("Ready", "up") : state("Not ready", "away");
    const del = ["Delete…", async () => (await confirmFirst(`Delete ${r.name}? Parts the host downloaded that no other recipe uses are deleted too.`, "Delete", true)) && api(`/host/v1/recipes/${r.id}`, { method: "DELETE" }), { danger: true }];
    const parts = ["Download parts", () => post(`/host/v1/recipes/${r.id}/download-parts`)];
    return h("li", {},
      h("div", { class: "main" }, h("div", { class: "name" }, r.name), facts(h("span", {}, r.does.map(doesWord).join(" · ")), r.useFor && r.useFor !== "both" ? h("span", {}, r.useFor) : null)),
      h("div", { class: "actions" }, badge,
        r.state === "proposed" ? button("Use", () => post(`/host/v1/recipes/${r.id}/confirm`)) : lacks ? button(...parts) : null,
        rowMenu(r.name, [
          r.state === "proposed" && ["Ignore", () => post(`/host/v1/recipes/${r.id}/ignore`)],
          r.state === "proposed" && lacks && parts,
          del,
        ])));
  };
  const arches = unique(S.recipes.map((r) => r.arch)).sort((a, b) => a.localeCompare(b));
  // A group opens by itself while one of its models waits for the user, or while it is the only group.
  return [head, h("div", { class: "groups" }, arches.map((arch) => {
    const mine = S.recipes.filter((r) => r.arch === arch).sort((a, b) => a.name.localeCompare(b.name));
    const waiting = mine.filter(review).length;
    return group(`arch-${arch}`, waiting > 0 || arches.length === 1, [arch, " ", h("span", { class: "cap" }, unique(mine.flatMap((r) => r.does.map(doesWord))).join(" · "))],
      [...plural(mine.length, "model", "models"), ...(waiting ? [" · ", num(waiting), " to review"] : [])], h("ul", { class: "rows" }, mine.map(row)));
  }))];
}

/** The host's starter recipes, as the download page's choices: a model's variants share a row. */
function imageStarters() {
  const free = S.status.modelsFolder.free;
  return S.starters.map((s) => {
    const lacks = s.parts.filter((p) => !p.present);
    const bytes = lacks.reduce((n, p) => n + (p.size ?? 0), 0);
    const here = S.recipes.some((r) => r.starter === s.id);
    const does = unique((s.does ?? []).map(doesWord));
    return {
      id: s.id, name: s.name, row: s.variantOf ?? s.name, variant: s.variant, group: s.family || s.template, does: s.does ?? [], words: [s.variantOf, s.variant, s.useFor, ...does], bytes, installed: here,
      facts: [...does, s.useFor, plural(s.parts.length, "part", "parts"), lacks.length ? [num(size(bytes)), " to download"] : "every part is on this host"],
      pill: here ? h("span", { class: "pill" }, "existing") : bytes > free ? h("span", { class: "pill warn", title: `${size(bytes)} to download, ${size(free)} free.` }, "not enough space") : null,
      off: here || bytes > free,
      get: () => post(`/host/v1/starters/${s.id}/install`),
    };
  });
}

// ---- The download pages ----

/**
 * The starters to pick one from: a search box, Does for image starters, All and Not currently installed, then a
 * collapsed group per kind or family. A model's variants fold into one row, with a Variant switch once it is picked.
 */
function starterPicker(kind, all) {
  if (!all.length) return [h("p", { class: "empty" }, kind === "text" ? "This host's servers run none of the starters." : "This host ships no starter recipes.")];
  if (all.find((s) => s.id === UI.pick[kind])?.off) delete UI.pick[kind];
  const picked = all.find((s) => s.id === UI.pick[kind]);
  const ofKind = all.filter((s) => UI.does === "all" || !s.does || s.does.some((d) => doesKind(d) === UI.does));
  const shows = (s, x) => x === "all" || !s.installed;
  const words = UI.q.trim().toLowerCase().split(" ").filter(Boolean);
  const kept = ofKind.filter((s) => shows(s, UI.show) && words.every((w) => [s.name, s.group, ...s.words].join(" ").toLowerCase().includes(w)));
  const filtering = words.length > 0 || UI.show !== "all";
  const joined = (parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [" · ", p] : [p])).flat();
  const choice = (row, n) => {
    const many = row.length > 1, isPicked = row.includes(picked);
    const s = isPicked ? picked : row.find((x) => !x.off) ?? row[0];
    const sizes = row.map((x) => x.bytes);
    const lo = Math.min(...sizes), hi = Math.max(...sizes);
    const summary = many && !isPicked
      ? joined([...s.facts.slice(0, kind === "text" ? 3 : 1), plural(row.length, "variant", "variants"), hi === 0 ? null : lo === hi ? [num(size(lo)), " to download"] : [num(size(lo)), " to ", num(size(hi)), " to download"]])
      : joined(s.facts);
    const allOff = row.every((x) => x.off);
    const pill = many && !isPicked ? (allOff ? s.pill : row.find((x) => x.installed)?.pill) : s.pill;
    return h("div", { class: "starter" },
      h("label", { class: "choice" },
        h("input", { type: "radio", name: "starter", id: `starter-${kind}-${n}`, checked: isPicked, disabled: many ? allOff : s.off, onchange: () => { UI.pick[kind] = s.id; render(); } }),
        h("span", { class: "choice-file" }, h("span", { class: "choice-name" }, many ? s.row : s.name, pill ? pill.cloneNode(true) : null), h("span", { class: "cap" }, summary))),
      many && isPicked ? h("div", { class: "seg variant", role: "group", "aria-label": "Variant" },
        row.map((x, i) => h("button", { type: "button", id: `variant-${kind}-${i}`, "aria-pressed": String(x === s), disabled: x.off, title: x.off ? x.pill?.textContent : undefined, onclick: () => { UI.pick[kind] = x.id; render(); } }, x.variant ?? x.name))) : null);
  };
  let n = 0;
  const groups = unique(kept.map((s) => s.group)).sort((a, b) => (kind === "text" ? 0 : a.localeCompare(b))).map((g) => {
    const items = kept.filter((s) => s.group === g);
    // Image variants in name order, as Lyrica lists them ("Full size" before "Q5").
    const rows = unique(items.map((s) => s.row)).map((r) => items.filter((s) => s.row === r).sort((a, b) => (kind === "text" ? 0 : a.name.localeCompare(b.name))));
    const existing = items.filter((s) => s.pill?.textContent === "existing").length;
    return group(`${kind}-${g}`, false, [g, ...(kind === "image" ? [" ", h("span", { class: "cap" }, unique(items.flatMap((s) => s.does.map(doesWord))).join(" · "))] : [])],
      [...plural(items.length, "starter", "starters"), ...(existing ? [" · ", num(existing), " existing"] : [])], rows.map((row) => choice(row, n++)),
      filtering || items.includes(picked));
  });
  const clear = () => { Object.assign(UI, { q: "", show: "all", does: "all" }); render(); };
  return [
    h("div", { class: "filters" }, search(`${kind}-q`, "q", "Search starters", kind === "text" ? "Search by name" : "Search by name or family"),
      kind === "image" ? h("div", { class: "seg", role: "group", "aria-label": "Does" },
        [["all", "All"], ["create", "Generate"], ["edit", "Edit"], ["video", "Video"], ["upscale", "Upscale"]].map(([k, label]) => toggle(`does-${k}`, label, UI.does === k, () => (UI.does = k)))) : null),
    h("div", { class: "chip-row", role: "group", "aria-label": "Show" },
      [["all", "All"], ["new", "Not currently installed"]].map(([x, label]) => toggle(`show-${x}`, [label, " ", num(ofKind.filter((s) => shows(s, x)).length)], UI.show === x, () => (UI.show = x), "chip"))),
    h("p", { class: "sr-only", "aria-live": "polite" }, `${kept.length} ${kept.length === 1 ? "starter" : "starters"}`),
    groups.length ? h("div", { class: "groups", role: "radiogroup", "aria-label": kind === "text" ? "Starters" : "Starter recipes" }, groups)
      : h("p", { class: "empty" }, "No starters match. ", h("button", { type: "button", class: "link", onclick: clear }, "Clear")),
    h("div", { class: "foot" },
      h("span", { class: "picked" }, picked ? [h("b", {}, picked.name), h("br"), h("span", { class: "cap" }, picked.bytes ? [num(size(picked.bytes)), " to download"] : "nothing to download")] : h("span", { class: "cap" }, "No starter picked")),
      // The page stays put, as Lyrica's does: the row turns to downloading or existing, and Downloads counts it.
      h("button", { type: "button", id: `get-${kind}`, class: "primary", disabled: !picked, onclick: act(async () => { await picked.get(); delete UI.pick[kind]; }) }, kind === "text" ? "Download" : "Add model"),
      h("a", { class: "button", href: kind === "text" ? "#text" : "#images" }, "Cancel")),
  ];
}

const hubHeaders = () => ({ ...(S.hub.token ? { "x-hub-token": S.hub.token } : {}) });
const bound = (key, props = {}) => h("input", { ...props, id: `hub-${key}`, value: S.hub[key], oninput: (e) => (S.hub[key] = e.target.value) });

/** Download text model and Download image model: the starters first, then a repository's files or a link. */
function downloadPage(kind) {
  const hub = S.hub;
  const pick = ([source, label]) => toggle(`source-${source}`, label, UI.source === source, () => { UI.source = source; hub.listing = null; if (source !== "starters") hub.source = source; });
  const form = UI.source === "starters" ? starterPicker(kind, kind === "text" ? textStarters() : imageStarters())
    : UI.source === "url"
    ? [h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(async () => { await post("/host/v1/downloads", { source: "url", url: hub.url.trim(), ...(hub.sha.trim() ? { sha256: hub.sha.trim() } : {}) }); hub.url = hub.sha = ""; location.hash = "#downloads"; })(); } },
      field("Link", bound("url", { type: "url", required: true, placeholder: "https://…/model.gguf" }), "A .gguf or .safetensors file."),
      field("SHA-256", bound("sha", { class: "num" }), "If the page lists one."),
      h("button", { type: "submit", class: "primary" }, "Download"))]
    : [h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); listFiles().catch(failed); } },
      field("Repository", bound("repo", { required: true, placeholder: "owner/name" })),
      field("Access token", bound("token", { type: "password", autocomplete: "off" }), "Only for a gated repository. Used for this download, never kept."),
      h("button", { type: "submit", class: "primary" }, "List files"))];
  const listing = UI.source === "starters" ? null : hub.listing;
  const folder = S.status.modelsFolder;
  return [
    h("a", { class: "link back", href: kind === "text" ? "#text" : "#images" }, icon("right"), kind === "text" ? "Text models" : "Image models"),
    sectionHead(h("h2", {}, kind === "text" ? "Download text model" : "Download image model"), facts(h("span", {}, num(size(folder.free)), " free in ", h("code", {}, folder.path)))),
    h("section", { class: `card download${UI.source === "starters" ? " picking" : ""}` },
      h("div", { class: "seg", role: "group", "aria-label": "Source" }, [["starters", kind === "text" ? "Starters" : "Starter recipes"], ["huggingface", "Hugging Face"], ["modelscope", "ModelScope"], ["url", "Link"]].map(pick)), form),
    listing ? h("div", { class: "section-head" }, h("h3", {}, h("code", {}, listing.repo)), h("span", { class: "facts" }, "revision ", h("code", {}, listing.revision.slice(0, 12)))) : null,
    listing ? h("ul", { class: "list" }, listing.files.length ? listing.files.map((f) =>
      h("li", {}, h("div", { class: "main" }, h("div", { class: "name" }, h("code", {}, f.path)), facts(num(size(f.size)))),
        h("div", { class: "actions" }, !f.allowed ? h("span", { class: "facts" }, f.reason) : f.present ? state("Here", "up") : !f.fits ? h("span", { class: "pill warn" }, "too big for the free space")
          : button("Download", () => fetch("/host/v1/downloads", { method: "POST", headers: { "content-type": "application/json", ...hubHeaders() }, credentials: "same-origin", body: JSON.stringify({ source: hub.source, repo: listing.repo, revision: listing.revision, files: [f.path] }) })
            .then((r) => r.json().then((b) => (r.ok ? b : Promise.reject(new Error(b.error?.message)))))))))
      : h("li", { class: "empty" }, "No files.")) : null,
  ];
}

async function listFiles() {
  const { source, repo } = S.hub;
  const res = await fetch(`/host/v1/hub/files?source=${source}&repo=${encodeURIComponent(repo.trim())}`, { headers: hubHeaders(), credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status}).`);
  S.hub.listing = { ...body, repo: repo.trim() };
  show();
  render();
}

// ---- Downloads ----

const SOURCES = { huggingface: "Hugging Face", modelscope: "ModelScope", civitai: "Civitai", upload: "an upload" };

/** The queue: what is on its way, then what finished, as Lyrica's Downloads lists them. */
function downloadsSection() {
  const running = S.downloads.filter(going), finished = S.downloads.filter((d) => !going(d));
  const clear = () => Promise.all(finished.map((d) => api(`/host/v1/downloads/${encodeURIComponent(d.id)}`, { method: "DELETE" })));
  const part = (label, list) => (list.length ? h("ul", { class: "list" }, h("li", { class: "eyebrow part" }, label), list.map(downloadRow)) : null);
  return [
    sectionHead(h("h2", {}, "Downloads"), facts(h("span", {}, num(running.length), " running"), h("span", {}, num(finished.length), " finished"), h("span", {}, num(size(S.status.modelsFolder.free)), " free")),
      h("a", { class: "button", href: "#download-text" }, "Download text model"), h("a", { class: "button", href: "#download-image" }, "Download image model")),
    h("div", { class: "section-head" }, h("h3", {}, "Queue"), finished.length ? h("button", { type: "button", class: "link", onclick: act(clear) }, "Clear finished") : null),
    S.downloads.length ? null : h("ul", { class: "list" }, h("li", { class: "empty" }, "Nothing downloaded yet.")),
    part("In progress", running), part("History", finished),
  ];
}

function downloadRow(d) {
  const pct = d.size ? Math.floor((100 * d.received) / d.size) : null;
  const moving = d.state === "downloading" || d.state === "uploading";
  // An upload is sent from a browser through Lyrica; it waits here between pieces.
  const word = moving ? state(pct == null ? "Downloading" : h("span", {}, d.state === "uploading" ? "Uploading " : "Downloading ", num(`${pct}%`)), "info")
    : d.state === "queued" ? state("Queued", "") : d.state === "verifying" ? state("Verifying", "info")
    : d.state === "done" ? (d.source === "upload" ? state("Uploaded", "up") : d.verified === false ? state("Done, unverified", "away", "No SHA-256 to check it against.") : state("Done", "up"))
    : state(d.state === "failed" ? "Failed" : d.state, "down");
  let from = SOURCES[d.source] ?? d.source;
  if (d.url) try { from = new URL(d.url).hostname; } catch { /* keeps the source's name */ }
  return h("li", {},
    h("div", { class: "main" }, h("div", { class: "name" }, h("span", { title: d.url ?? d.path }, d.path.split("/").pop()), from ? h("span", { class: "cap" }, `from ${from}`) : null),
      moving && pct != null ? h("div", { class: "progress" }, h("span", { style: `width:${pct}%` })) : null,
      facts(word, d.size ? h("span", {}, ...(moving ? [num(size(d.received)), " of "] : []), num(size(d.size))) : null)),
    h("div", { class: "actions" }, button(going(d) ? "Cancel" : "Clear", () => api(`/host/v1/downloads/${encodeURIComponent(d.id)}`, { method: "DELETE" }))),
    d.error ? h("p", { class: "warn-text wide" }, d.error) : null);
}

// ---- Usage ----

function usageSection() {
  const cell = (label, value) => h("td", { class: "num", "data-label": label }, value ?? "");
  return [
    sectionHead(h("h2", { title: "Counts only: never prompts, results or who asked. Nothing leaves this machine." }, "Usage"), null),
    S.usage.length ? h("div", { class: "table" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Model"), ["Requests", "Tokens", "Images", "Audio", "Busy"].map((l) => h("th", { scope: "col", class: "num" }, l)))),
      h("tbody", {}, S.usage.map((u) => h("tr", {}, h("th", { scope: "row" }, shortName(u.id)),
        cell("Requests", u.requests.toLocaleString("en")),
        cell("Tokens", u.promptTokens + u.completionTokens ? (u.promptTokens + u.completionTokens).toLocaleString("en") : null),
        cell("Images", u.images ? u.images.toLocaleString("en") : null),
        cell("Audio", u.audioSeconds ? duration(u.audioSeconds) : null),
        cell("Busy", duration(u.seconds)))))))
      : h("ul", { class: "list" }, h("li", { class: "empty" }, "Nothing yet.")),
  ];
}

// ---- Lyrica servers and the password ----

function serversSection() {
  const code = S.code && Date.parse(S.code.expiresAt) > Date.now() ? S.code : null;
  return [
    h("div", { class: "section-head" }, h("h2", {}, "Lyrica servers"),
      h("button", { type: "button", class: "primary", onclick: () => post("/dashboard/pairing").then((made) => { S.code = made; render(); }, show) }, code ? "New code" : "Pair with Lyrica")),
    code ? h("section", { class: "card" }, h("div", { class: "code", title: "In Lyrica: Models, Hosts and endpoints, Add model host." }, code.code),
      facts(h("span", {}, "enter it on Lyrica's Add model host"), h("span", {}, "works once, until ", h("span", { class: "num" }, new Date(code.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" }))))) : null,
    h("ul", { class: "list" }, S.clients.length ? S.clients.map((c) => h("li", {},
      h("div", { class: "main" }, h("div", { class: "name" }, c.name),
        facts(h("code", { title: c.fingerprint }, `${c.fingerprint.slice(0, 16)}…`), h("span", {}, c.lastSeen ? "seen " : "paired ", h("span", { class: "num" }, when(c.lastSeen ?? c.pairedAt))))),
      h("div", { class: "actions" }, button("Revoke…", async () => (await confirmFirst(`Revoke ${c.name}? It will need to pair again.`, "Revoke", true)) && api(`/dashboard/clients/${c.fingerprint}`, { method: "DELETE" })))))
      : h("li", { class: "empty" }, "None paired yet.")),
  ];
}

function passwordSection() {
  const { me } = S;
  const current = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const save = h("button", { type: "submit", class: "primary" }, "Save");
  const form = h("form", { class: "card", onsubmit: (e) => {
    e.preventDefault();
    post("/dashboard/password", { password: next.value, ...(me.access === "password" ? { current: current.value } : {}) }).then(() => {
      current.value = next.value = "";
      document.activeElement?.blur();
      save.textContent = "Saved";
      setTimeout(() => refresh(true).catch(show), 2000);
    }, show);
  } },
    me.access === "password" ? field("Current password", current) : null,
    field(me.passwordSet ? "New password" : "Password", next, "10 or more characters."),
    h("div", {}, save));
  return [
    h("div", { class: "section-head" }, h("h2", {}, "Password"),
      me.passwordSet ? state("Set", "up", "Needed to open this dashboard from another machine.") : state("Not set", "away", "The dashboard opens only at this machine until one is set.")),
    form,
  ];
}

$("login-form").onsubmit = (e) => {
  e.preventDefault();
  post("/dashboard/login", { password: $("login-password").value })
    .then(() => { $("login-password").value = ""; show(); return refresh(true); }, show);
};

refresh(true).catch(show);
setInterval(() => refresh().catch(show), 10_000);
