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

const ICONS = { more: "M5 12h.01M12 12h.01M19 12h.01", close: "M6 6l12 12M18 6L6 18" };
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

function show(error) {
  $("error").textContent = error ? error.message ?? String(error) : "";
  $("error").hidden = !error;
}

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
const act = (fn) => () => Promise.resolve(fn()).then(() => refresh(true), show);
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
  form.onkeydown = (e) => e.key === "Escape" && closeDrawer();
  drawer = [h("div", { class: "scrim", onclick: closeDrawer }), form];
  document.body.append(...drawer);
  form.querySelector("input, select, textarea")?.focus();
}

const field = (label, input, title) => h("label", { class: "field", title }, h("span", {}, label), input);

// ---- State and refreshing ----

const S = { me: null, status: null, models: [], downloads: [], recipes: [], starters: [], usage: [], clients: [], code: null, hub: { source: "huggingface", repo: "", token: "", url: "", sha: "", listing: null } };

const SECTIONS = [
  ["gpus", "GPUs"], ["models", "Models"], ["images", "Image models"], ["downloads", "Downloads"], ["usage", "Usage"], ["servers", "Lyrica servers"], ["password", "Password"],
];
const ownerOnly = new Set(["servers", "password"]);
const section = () => {
  const want = location.hash.slice(1);
  const allowed = SECTIONS.filter(([k]) => S.me?.access !== "client" || !ownerOnly.has(k)).map(([k]) => k);
  return allowed.includes(want) ? want : "gpus";
};
window.addEventListener("hashchange", () => {
  closeMenu();
  if (drawer) closeDrawer();
  else render();
});

/** Something the user has open, which a timed refresh mustn't redraw under them. */
const busy = () => !!(drawer || openMenu || $("confirm").open || document.activeElement?.closest?.("#content form"));

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
  const [status, models, downloads, recipes, starters, usage, clients] = await Promise.all([
    api("/host/v1/status"),
    api("/host/v1/models").catch(() => ({ models: [] })),
    api("/host/v1/downloads").catch(() => ({ downloads: [] })),
    api("/host/v1/recipes").catch(() => ({ recipes: [] })),
    api("/host/v1/starters").catch(() => ({ starters: [] })),
    api("/host/v1/usage").catch(() => ({ models: [] })),
    me.access === "client" ? { clients: [] } : api("/dashboard/clients"),
  ]);
  Object.assign(S, { status, models: models.models, downloads: downloads.downloads, recipes: recipes.recipes.filter((r) => r.state !== "ignored"), starters: starters.starters, usage: usage.models, clients: clients.clients });
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

  const counts = { models: S.models.length, images: S.recipes.length, downloads: S.downloads.filter((d) => ["queued", "downloading", "verifying"].includes(d.state)).length || null };
  const current = section();
  $("subnav").replaceChildren(...SECTIONS.filter(([k]) => me.access !== "client" || !ownerOnly.has(k)).map(([k, label]) =>
    h("a", { href: `#${k}`, "aria-current": k === current ? "page" : undefined }, label, counts[k] ? h("span", { class: "count" }, String(counts[k])) : null)));
}

function render() {
  if (!S.status) return;
  renderHead();
  const draw = { gpus: gpus, models: textModels, images: imageModels, downloads: downloadsSection, usage: usageSection, servers: serversSection, password: passwordSection }[section()];
  $("content").replaceChildren(...draw().filter(Boolean));
}

// ---- GPUs ----

const SERVERS = [["llamacpp", "llama.cpp"], ["vllm", "vLLM"], ["images", "Images"], ["speech", "Speech"]];

function gpus() {
  const { gpus: list, servers } = S.status;
  const head = h("div", { class: "section-head" }, h("h2", {}, "GPUs"),
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "seg-pinned" }), "Pinned"), h("span", {}, h("i", { class: "seg-loaded" }), "Loaded on demand")));
  if (!list.length) return [head, h("p", { class: "empty" }, "No GPUs found.")];
  return [head, ...list.map((g) => {
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
        g.models.map((m) => h("span", { class: m.pinned ? "seg-pinned" : "seg-loaded", style: `width:${Math.min(100, (100 * m.vram) / g.vram.total)}%`, title: `${m.id}: ${size(m.vram)}` }))),
      g.models.length ? h("ul", { class: "model-list" }, g.models.map((m) =>
        h("li", {}, h("code", {}, m.id),
          h("span", { class: "muted" }, [m.pinned ? "pinned" : m.state === "loading" ? "loading" : "loaded", m.busy ? "busy" : null, m.gpus.length > 1 ? `split over GPUs ${m.gpus.join(" and ")}` : null].filter(Boolean).join(" · ")),
          h("span", { class: "num muted" }, size(m.vram)),
          m.pinned ? null : button("Unload", () => post("/host/v1/models/unload", { model: m.id }))))) : null,
      waiting.length ? h("p", { class: "facts" }, `Waiting: ${waiting.join(", ")}`) : null);
  })];
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

function textModels() {
  const head = h("div", { class: "section-head" }, h("h2", {}, "Models"), button("Scan the folder", () => post("/host/v1/scan")));
  if (!S.models.length) return [head, h("ul", { class: "list" }, h("li", { class: "empty" }, "No text or voice models in the models folder.")), ...starters()];
  const cpu = S.status.cpuServers ?? [];
  return [head, h("ul", { class: "list" }, S.models.map((m) => {
    const where = cpu.includes(m.server) ? "CPU" : m.placement.mode === "auto" ? "placed automatically" : `GPU ${m.placement.gpus.join("+")}`;
    const [word, dot] = m.state === "loaded" ? ["Loaded", "up"] : m.state === "loading" ? ["Loading", "info"] : ["Unloaded", ""];
    return h("li", {},
      h("div", { class: "main" },
        h("div", { class: "name" }, h("code", {}, m.id)),
        facts(h("span", {}, KINDS[m.kind] ?? m.kind), h("span", {}, SERVER_NAMES[m.server] ?? m.server), num(size(m.size)), h("span", {}, where),
          m.capabilities?.speak ? h("span", {}, num(m.capabilities.speak.voices.length), " voices") : null,
          m.contextLength ? h("span", {}, num(m.contextLength), " context") : null,
          m.stretch ? h("span", {}, "stretch ×", num(m.stretch)) : null,
          m.kvBytes ? h("span", {}, "KV ", num(size(m.kvBytes))) : null)),
      h("div", { class: "actions" },
        state(word, dot), m.pinned ? h("span", { class: "pill" }, "pinned") : null,
        m.state === "unloaded" ? button("Load", () => post("/host/v1/models/load", { model: m.id }))
          : h("button", { type: "button", class: "sm", disabled: m.pinned, title: m.pinned ? "Unpin it first." : undefined, onclick: act(() => post("/host/v1/models/unload", { model: m.id })) }, "Unload"),
        h("button", { type: "button", class: "sm", onclick: () => editModel(m).catch(show) }, "Settings"),
        rowMenu(m.id, [
          [m.pinned ? "Unpin" : "Pin", () => post("/host/v1/models/pin", { model: m.id, pinned: !m.pinned })],
          m.state !== "unloaded" && ["Reload", () => post("/host/v1/models/reload", { model: m.id })],
        ])));
  })), ...starters()];
}

/**
 * Models worth starting with, downloaded at a pinned revision into the models folder. `id` is the model id
 * the file or folder gets; `also` matches the rest of a folder's files; `needs` is the GPU memory it wants loaded.
 */
const STARTERS = [
  { id: "lyrica/huggingface/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf", name: "Qwen3.8 27B", kind: "chat", server: "llamacpp",
    repo: "unsloth/Qwen3.8-27B-GGUF", revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502", files: ["Qwen3.8-27B-UD-Q4_K_M.gguf", "mmproj-F16.gguf"],
    size: 16_464_440_224 + 927_607_488, needs: 22 * 2 ** 30 },
  { id: "lyrica/huggingface/unsloth/GLM-5.3-Flash-GGUF/UD-Q3_K_XL/GLM-5.3-Flash-UD-Q3_K_XL-00001-of-00004.gguf", name: "GLM 5.3 Flash", kind: "chat", server: "llamacpp",
    repo: "unsloth/GLM-5.3-Flash-GGUF", revision: "a38483c8cd5df544f53d70fb281afe97369d5ab6",
    files: [1, 2, 3, 4].map((n) => `UD-Q3_K_XL/GLM-5.3-Flash-UD-Q3_K_XL-0000${n}-of-00004.gguf`).concat("mmproj-F16.gguf"),
    size: 147_535_922_080 + 1_128_047_296, needs: 160 * 2 ** 30 },
  { id: "lyrica/huggingface/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf", name: "Qwen3.5 9B", kind: "chat", server: "llamacpp",
    repo: "unsloth/Qwen3.5-9B-GGUF", revision: "3885219b6810b007914f3a7950a8d1b469d598a5", files: ["Qwen3.5-9B-Q4_K_M.gguf", "mmproj-F16.gguf"],
    size: 5_680_522_464 + 918_166_080, needs: 8 * 2 ** 30 },
  { id: "lyrica/huggingface/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf", name: "Qwen3 Embedding 0.6B", kind: "embedding", server: "llamacpp",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", revision: "370f27d7550e0def9b39c1f16d3fbaa13aa67728", files: ["Qwen3-Embedding-0.6B-Q8_0.gguf"],
    size: 639_150_592, needs: 1 * 2 ** 30 },
  { id: "lyrica/huggingface/onnx-community/Kokoro-82M-v1.1-zh-ONNX", name: "Kokoro 82M", kind: "speak", server: "speech",
    repo: "onnx-community/Kokoro-82M-v1.1-zh-ONNX", revision: "6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3",
    files: ["onnx/model.onnx", "config.json", "tokenizer.json", "tokenizer_config.json", "voices/zm_010.bin", "voices/zf_001.bin", "voices/af_maple.bin"], size: 0.33 * 2 ** 30, needs: 1 * 2 ** 30 },
  { id: "lyrica/huggingface/ggerganov/whisper.cpp/ggml-large-v3-turbo-q8_0.bin", name: "Whisper large-v3 turbo", kind: "transcribe", server: "whispercpp",
    repo: "ggerganov/whisper.cpp", revision: "5359861c739e955e79d9a303bcbc70fb988958b1", files: ["ggml-large-v3-turbo-q8_0.bin"], size: 874_188_075, needs: 1.5 * 2 ** 30 },
  { id: "lyrica/huggingface/openai/whisper-large-v3-turbo", name: "Whisper large-v3 turbo", kind: "transcribe", server: "vllm",
    repo: "openai/whisper-large-v3-turbo", revision: "41f01f3fe87f28c78e2fbf8b568835947dd65ed9",
    files: ["model.safetensors"], also: /^[^/]+\.(json|txt)$/, size: 1.6 * 2 ** 30, needs: 2.4 * 2 ** 30 },
];

/** Downloads a starter's files, read from the repository's listing at its revision. */
async function getStarter(s) {
  const listing = await api(`/host/v1/hub/files?source=huggingface&repo=${encodeURIComponent(s.repo)}&revision=${s.revision}`);
  const missing = s.files.filter((f) => !listing.files.some((x) => x.path === f));
  if (missing.length) throw new Error(`${s.repo} no longer has ${missing.join(", ")}.`);
  const files = listing.files.filter((f) => f.allowed && !f.present && (s.files.includes(f.path) || s.also?.test(f.path))).map((f) => f.path);
  if (files.length) await post("/host/v1/downloads", { source: "huggingface", repo: s.repo, revision: listing.revision, files });
}

/** The starters this host can serve: its servers run them, on a GPU or the CPU, with each one's state here. */
function starters() {
  const { servers, cpuServers = [], gpus, dictation = "vllm" } = S.status;
  // What GPUs that allow a starter's server can give it: llama.cpp splits a model over all of them, the others use one.
  const rooms = (server) => gpus.filter((g) => !g.settings.excluded && g.settings.servers.includes(server === "whispercpp" ? "speech" : server)).map((g) => g.vram.total - g.settings.keepFree);
  const room = (server) => server === "llamacpp" ? rooms(server).reduce((a, b) => a + b, 0) : Math.max(0, ...rooms(server));
  // Dictation runs on one server here: whisper.cpp beside a CMP 100-210, else vLLM.
  const serves = (s) => (s.kind !== "transcribe" || s.server === dictation) && (s.server === "whispercpp" || servers.includes(s.server) || cpuServers.includes(s.server));
  const rows = STARTERS.filter(serves).map((s) => {
    const here = S.models.some((m) => m.id === s.id);
    const coming = S.downloads.some((d) => ["queued", "downloading", "verifying"].includes(d.state) && d.path.startsWith(`lyrica/huggingface/${s.repo}/`));
    const fits = cpuServers.includes(s.server) || s.needs <= room(s.server);
    return h("li", {},
      h("div", { class: "main" }, h("div", { class: "name" }, s.name),
        facts(h("span", {}, KINDS[s.kind]), h("span", {}, SERVER_NAMES[s.server]), h("span", {}, "about ", num(size(s.size))),
          cpuServers.includes(s.server) ? h("span", {}, "CPU") : h("span", {}, "needs ", num(size(s.needs)), " of GPU memory"))),
      h("div", { class: "actions" },
        here ? state("Here", "up") : coming ? state("Downloading", "info")
          : !fits ? h("span", { class: "pill warn", title: "More than any GPU here can give it." }, "too big for these GPUs")
          : button("Download", () => getStarter(s))));
  });
  return rows.length ? [h("h3", {}, "Starters"), h("ul", { class: "list" }, rows)] : [];
}

/** A model's placement and serving settings; what isn't a field stays as JSON under Other settings. */
async function editModel(m) {
  const info = await api(`/host/v1/models/settings?model=${encodeURIComponent(m.id)}`);
  const { placement = { mode: "auto" }, contextLength, stretch, parallel, maxSeqs, kvCacheType, memoryShare, ...rest } = info.settings;
  const { mode, gpus: chosen = [], ...placementRest } = placement;
  const llama = m.server === "llamacpp", vllm = m.server === "vllm", chat = m.kind === "chat";
  const usable = S.status.gpus.filter((g) => !g.settings.excluded);

  const where = h("select", {}, h("option", { value: "auto" }, "Automatic"), h("option", { value: "gpus" }, "These GPUs"));
  where.value = mode === "gpus" ? "gpus" : "auto";
  const picks = usable.map((g) => [g.index, h("input", { type: "checkbox", checked: chosen.includes(g.index) })]);
  const pickBox = h("fieldset", { hidden: where.value !== "gpus" }, h("legend", {}, "GPUs"), picks.map(([i, box]) => h("label", { class: "check" }, box, `GPU ${i} · ${usable.find((g) => g.index === i).name}`)));
  where.onchange = () => (pickBox.hidden = where.value !== "gpus");

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
    if (ctx.value) settings.contextLength = Number(ctx.value);
    if (chat && Number(factor.value) > 1) settings.stretch = { ...stretch, type: "yarn", factor: Number(factor.value) };
    if (atOnce.value) settings[llama ? "parallel" : "maxSeqs"] = Number(atOnce.value);
    if (llama && kv.value) settings.kvCacheType = kv.value;
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

function imageModels() {
  const list = h("ul", { class: "list" }, S.recipes.length ? S.recipes.map((r) => {
    const missing = r.parts.filter((p) => !p.file || p.missing).length;
    const badge = r.state === "proposed" ? h("span", { class: "pill info", title: "Found in the models folder; Use adds it." }, "proposed")
      : missing ? h("span", { class: "pill warn" }, `${missing} part${missing > 1 ? "s" : ""} missing`)
      : r.ready ? state("Ready", "up") : state("Not ready", "away");
    const del = ["Delete…", async () => (await confirmFirst(`Delete ${r.name}? Parts the host downloaded that no other recipe uses are deleted too.`, "Delete", true)) && api(`/host/v1/recipes/${r.id}`, { method: "DELETE" }), { danger: true }];
    const parts = ["Download parts", () => post(`/host/v1/recipes/${r.id}/download-parts`)];
    return h("li", {},
      h("div", { class: "main" }, h("div", { class: "name" }, r.name), facts(h("span", {}, r.arch), h("span", {}, r.does.join(" and ")))),
      h("div", { class: "actions" }, badge,
        r.state === "proposed" ? button("Use", () => post(`/host/v1/recipes/${r.id}/confirm`)) : missing ? button(...parts) : null,
        rowMenu(r.name, [
          r.state === "proposed" && ["Ignore", () => post(`/host/v1/recipes/${r.id}/ignore`)],
          r.state === "proposed" && missing && parts,
          del,
        ])));
  }) : h("li", { class: "empty" }, "None yet."));
  return [
    h("div", { class: "section-head" }, h("h2", {}, "Image models"), button("Scan the folder", () => post("/host/v1/scan"))),
    list,
    S.starters.length ? h("h3", {}, "Starters") : null,
    S.starters.length ? h("ul", { class: "list" }, S.starters.map((s) => {
      const have = s.parts.filter((p) => p.present).length;
      return h("li", {}, h("div", { class: "main" }, h("div", { class: "name" }, s.name), facts(h("span", {}, num(have), " of ", num(s.parts.length), " parts here"))),
        h("div", { class: "actions" }, button("Install", () => post(`/host/v1/starters/${s.id}/install`))));
    })) : null,
  ];
}

// ---- Downloads ----

const hubHeaders = () => ({ ...(S.hub.token ? { "x-hub-token": S.hub.token } : {}) });
const bound = (key, props = {}) => h("input", { ...props, value: S.hub[key], oninput: (e) => (S.hub[key] = e.target.value) });

function downloadsSection() {
  const hub = S.hub;
  const pick = (source) => h("button", { type: "button", "aria-pressed": String(hub.source === source), onclick: () => { hub.source = source; hub.listing = null; render(); } }, { huggingface: "Hugging Face", modelscope: "ModelScope", url: "Link" }[source]);
  const form = hub.source === "url"
    ? h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); act(async () => { await post("/host/v1/downloads", { source: "url", url: hub.url.trim(), ...(hub.sha.trim() ? { sha256: hub.sha.trim() } : {}) }); hub.url = hub.sha = ""; })(); } },
      field("Link", bound("url", { type: "url", required: true, placeholder: "https://…/model.gguf" }), "A .gguf or .safetensors file."),
      field("SHA-256", bound("sha", { class: "num" }), "If the page lists one."),
      h("button", { type: "submit", class: "primary" }, "Download"))
    : h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); listFiles().catch(show); } },
      field("Repository", bound("repo", { required: true, placeholder: "owner/name" })),
      field("Access token", bound("token", { type: "password", autocomplete: "off" }), "Only for a gated repository. Used for this download, never kept."),
      h("button", { type: "submit", class: "primary" }, "List files"));
  const listing = hub.listing;
  return [
    h("div", { class: "section-head" }, h("h2", {}, "Downloads"), h("span", { class: "facts" }, num(size(S.status.modelsFolder.free)), " free")),
    h("section", { class: "card" }, h("div", { class: "seg", role: "group", "aria-label": "Source" }, pick("huggingface"), pick("modelscope"), pick("url")), form),
    listing ? h("div", { class: "section-head" }, h("h3", {}, h("code", {}, listing.repo)), h("span", { class: "facts" }, "revision ", h("code", {}, listing.revision.slice(0, 12)))) : null,
    listing ? h("ul", { class: "list" }, listing.files.length ? listing.files.map((f) =>
      h("li", {}, h("div", { class: "main" }, h("div", { class: "name" }, h("code", {}, f.path)), facts(num(size(f.size)))),
        h("div", { class: "actions" }, !f.allowed ? h("span", { class: "facts" }, f.reason) : f.present ? state("Here", "up") : !f.fits ? h("span", { class: "pill warn" }, "too big for the free space")
          : button("Download", () => fetch("/host/v1/downloads", { method: "POST", headers: { "content-type": "application/json", ...hubHeaders() }, credentials: "same-origin", body: JSON.stringify({ source: hub.source, repo: listing.repo, revision: listing.revision, files: [f.path] }) })
            .then((r) => r.json().then((b) => (r.ok ? b : Promise.reject(new Error(b.error?.message)))))))))
      : h("li", { class: "empty" }, "No files.")) : null,
    S.downloads.length ? h("h3", {}, "On this host") : null,
    S.downloads.length ? h("ul", { class: "list" }, S.downloads.map(downloadRow)) : null,
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

function downloadRow(d) {
  const going = ["queued", "downloading", "verifying"].includes(d.state);
  const pct = d.size ? Math.floor((100 * d.received) / d.size) : null;
  const word = d.state === "downloading" ? state(pct == null ? "Downloading" : h("span", {}, "Downloading ", num(`${pct}%`)), "info")
    : d.state === "queued" ? state("Queued", "") : d.state === "verifying" ? state("Verifying", "info")
    : d.state === "done" ? (d.verified === false ? state("Done, unverified", "away", "No SHA-256 to check it against.") : state("Done", "up"))
    : state(d.state === "failed" ? "Failed" : d.state, "down");
  return h("li", {},
    h("div", { class: "main" }, h("div", { class: "name" }, h("code", {}, d.path)), d.url ? h("p", { class: "facts" }, h("code", { class: "muted" }, d.url)) : null),
    h("div", { class: "actions" }, word, button(going ? "Cancel" : "Clear", () => api(`/host/v1/downloads/${d.id}`, { method: "DELETE" }))),
    d.state === "downloading" && pct != null ? h("div", { class: "progress wide" }, h("span", { style: `width:${pct}%` })) : null,
    d.error ? h("p", { class: "warn-text wide" }, d.error) : null);
}

// ---- Usage ----

function usageSection() {
  return [
    h("div", { class: "section-head" }, h("h2", { title: "Counts only: never prompts, results or who asked. Nothing leaves this machine." }, "Usage")),
    h("ul", { class: "list" }, S.usage.length ? S.usage.map((u) => h("li", {},
      h("div", { class: "main" }, h("div", { class: "name" }, h("code", {}, u.id)),
        facts(h("span", {}, num(u.requests), " requests"),
          u.promptTokens + u.completionTokens ? h("span", {}, num(u.promptTokens + u.completionTokens), " tokens") : null,
          u.images ? h("span", {}, num(u.images), " images") : null,
          u.audioSeconds ? h("span", {}, num(duration(u.audioSeconds)), " of audio") : null,
          h("span", {}, num(duration(u.seconds)), " busy"))))) : h("li", { class: "empty" }, "Nothing yet.")),
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
