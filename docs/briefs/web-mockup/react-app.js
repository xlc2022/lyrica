// Reference only: the React mockup (htm, no build step). Delete with the Web UI's pull request.
(function () {
  const { useState, useMemo, useRef, useEffect } = React;
  const html = htm.bind(React.createElement);
  const L = window.LYRICA;
  const LABELS = { main: "Main conversation", cheap: "Cheap subagents", strong: "Strong subagents" };

  function ThreadRow({ t, sel, open, onToggle, onSelect }) {
    return html`<li>
      <div className=${"lyr-row" + (sel === t.id ? " on" : "")}>
        ${t.children.length
          ? html`<button className="lyr-chev" type="button" aria-expanded=${!!open}
              aria-label=${(open ? "Hide" : "Show") + " subagents"} onClick=${() => onToggle(t.id)}>›</button>`
          : html`<span className="lyr-chev-gap"></span>`}
        <button className="lyr-thread" type="button" onClick=${() => onSelect(t.id)}>
          <span className="lyr-pool" data-pool=${t.pool}></span>
          <span className="lyr-title">${t.title}</span>
          <span className="lyr-when">${t.hidden && html`<span className="lyr-flag">hidden</span>`} ${t.updated}</span>
        </button>
      </div>
      ${t.children.length > 0 && open && html`<ul className="lyr-children">
        ${t.children.map((c) => html`<li key=${c.id}>
          <button className=${"lyr-thread child" + (sel === c.id ? " on" : "")} type="button" onClick=${() => onSelect(c.id)}>
            <span className="lyr-status" data-status=${c.status}></span>
            <span className="lyr-title">${c.title}</span>
            <span className="lyr-when">${c.secs}s</span>
          </button></li>`)}
      </ul>`}
    </li>`;
  }

  function Message({ m, k, flags, toggle, threads, onSelect }) {
    if (m.type === "user") return html`<div className="lyr-msg" data-role="user"><div className="who">${m.who || "Li"}</div><div className="body">${m.text}</div></div>`;
    if (m.type === "lyrica") return html`<div className="lyr-msg" data-role="lyrica"><div className="who">${m.who || "Lyrica"}</div><div className="body">${m.text}${m.streaming && html`<span className="caret"></span>`}</div></div>`;
    if (m.type === "memory") return html`<div className="lyr-note memory">Remembered: ${m.text}</div>`;
    if (m.type === "recall") return html`<div className="lyr-note recall">
      <button type="button" aria-expanded=${!!flags[k]} onClick=${() => toggle(k)}>Recalled ${m.items.length} memories</button>
      ${flags[k] && html`<ul>${m.items.map((x) => html`<li key=${x}>${x}</li>`)}</ul>`}</div>`;
    if (m.type === "tool") return html`<div className="lyr-tool">
      <button className="lyr-tool-head" type="button" aria-expanded=${!!flags[k]} onClick=${() => toggle(k)}>
        <span className="name">${m.name}</span><code>${m.arg}</code><span className="state">${m.state}</span>
      </button>
      ${flags[k] && html`<pre>${m.out}</pre>`}</div>`;
    if (m.type === "sub") {
      const c = L.subOf(threads, m.ref);
      return html`<div className="lyr-sub">
        <div className="lyr-sub-head">
          <span className="lyr-status" data-status=${c.status}></span><b>${c.role}</b>
          <span>${c.tier} · ${c.model} · ${c.secs}s</span>
          <button type="button" onClick=${() => onSelect(m.ref)}>Open</button>
        </div><p>${m.summary}</p></div>`;
    }
    return null;
  }

  function Settings({ owner, isSub, update, onClose }) {
    const options = L.modelOptions(owner);
    const set = (fn) => update((o) => { fn(o); L.enforceLocal(o); });
    return html`<aside className="lyr-drawer" aria-label="Thread settings">
      <div className="lyr-drawer-head"><h3>Thread settings</h3><button type="button" onClick=${onClose}>Close</button></div>
      <div className="lyr-drawer-body">
        ${isSub && html`<p className="lyr-empty">A subagent inherits ${owner.title}'s settings and can only narrow them.</p>`}
        <div className="lyr-group"><span className="lbl">Models</span>
          ${["main", "cheap", "strong"].map((k) => html`<label className="lyr-field" key=${k}><span>${LABELS[k]}</span>
            <select value=${owner.models[k]} disabled=${isSub} onChange=${(e) => set((o) => { o.models[k] = e.target.value; })}>
              ${options.map((o) => html`<option key=${o.id} value=${o.id}>${o.name} · ${o.endpoint} (${o.kind})</option>`)}
            </select></label>`)}
        </div>
        <div className="lyr-group"><span className="lbl">Privacy and network</span>
          <label className="lyr-switch"><input type="checkbox" checked=${owner.localOnly} disabled=${owner.pool === "private" || isSub}
            onChange=${(e) => set((o) => { o.localOnly = e.target.checked; })} />
            <span>Local-only</span><small>${owner.pool === "private" ? "Always on in private threads." : "Every model call stays on your own machines."}</small></label>
          <label className="lyr-switch"><input type="checkbox" checked=${owner.internet} disabled=${isSub}
            onChange=${(e) => set((o) => { o.internet = e.target.checked; })} /><span>Internet</span><small>For her commands and fetches.</small></label>
          <label className="lyr-switch"><input type="checkbox" checked=${owner.services} disabled=${isSub}
            onChange=${(e) => set((o) => { o.services = e.target.checked; })} /><span>This machine's services</span><small>Local ports, except Lyrica's own.</small></label>
          <div className="lyr-field"><span>Allowed hosts</span>
            ${owner.hosts.length ? html`<div className="lyr-chips">${owner.hosts.map((h) => html`<span key=${h}>${h}</span>`)}</div>` : html`<span className="lyr-empty">None</span>`}
          </div>
        </div>
        <div className="lyr-group"><span className="lbl">Folders</span>
          ${owner.folders.map((f, i) => html`<div className="lyr-folder" key=${f.path}><span>${f.path}</span>
            <select value=${f.mode} disabled=${isSub} aria-label=${"Access to " + f.path} onChange=${(e) => set((o) => { o.folders[i].mode = e.target.value; })}>
              <option value="rw">read-write</option><option value="ro">read-only</option></select></div>`)}
          ${!owner.folders.length && html`<span className="lyr-empty">No folders granted</span>`}
        </div>
        <div className="lyr-group"><span className="lbl">Behaviour</span>
          <label className="lyr-field"><span>Permission mode</span>
            <select value=${owner.perm} disabled=${isSub} onChange=${(e) => set((o) => { o.perm = e.target.value; })}>
              <option>Auto</option><option>Ask before commands</option><option>Ask before changes</option></select></label>
          <label className="lyr-switch"><input type="checkbox" checked=${owner.unlogged} disabled=${isSub}
            onChange=${(e) => set((o) => { o.unlogged = e.target.checked; })} /><span>Do not log thread in memory</span><small>Subagents and forks inherit this.</small></label>
        </div>
      </div>
    </aside>`;
  }

  function App() {
    const initial = useMemo(() => L.clone(), []);
    const [threads, setThreads] = useState(initial.threads);
    const [msgs, setMsgs] = useState(initial.messages);
    const [sel, setSel] = useState("t1");
    const [open, setOpen] = useState({ t1: true });
    const [filters, setFilters] = useState({ general: true, private: true, hidden: false });
    const [sideOpen, setSideOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [flags, setFlags] = useState({});
    const scroller = useRef(null);

    const { thread: cur, parent } = L.find(threads, sel);
    const owner = parent || cur;
    const isSub = !!parent;
    const mainModel = L.model(owner.models.main);
    const list = msgs[sel] || [];

    useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [list, sel]);

    const select = (id) => { setSel(id); setSideOpen(false); };
    const toggleFlag = (k) => setFlags((f) => ({ ...f, [k]: !f[k] }));
    const update = (fn) => setThreads((ts) => {
      const next = JSON.parse(JSON.stringify(ts));
      fn(next.find((t) => t.id === owner.id));
      return next;
    });

    function send(e) {
      e.preventDefault();
      const text = draft.trim();
      if (!text) return;
      const id = sel;
      setDraft("");
      setMsgs((m) => ({ ...m, [id]: [...(m[id] || []), { type: "user", text }, { type: "lyrica", text: "", streaming: true }] }));
      const full = L.reply(id);
      let i = 0;
      const timer = setInterval(() => {
        i += 2;
        const done = i >= full.length;
        setMsgs((m) => {
          const arr = [...m[id]];
          arr[arr.length - 1] = { type: "lyrica", text: full.slice(0, i), streaming: !done };
          return { ...m, [id]: arr };
        });
        if (done) clearInterval(timer);
      }, 18);
    }

    const visible = L.visible(threads, filters);
    const flip = (k) => setFilters((f) => ({ ...f, [k]: !f[k] }));

    return html`<div className="lyr" data-side-open=${String(sideOpen)} data-settings-open=${String(settingsOpen)}>
      <aside className="lyr-side" aria-label="Threads">
        <div className="lyr-brand"><span className="lyr-name">Lyrica</span></div>
        <button className="lyr-persona" type="button">
          <span className="avatar">Li</span><span><b>Li</b><small>Signed in · switch persona</small></span><span className="caret-down" aria-hidden="true">▾</span>
        </button>
        <div className="lyr-filters">
          <label><input type="checkbox" checked=${filters.general} onChange=${() => flip("general")} /> Show general</label>
          <label><input type="checkbox" checked=${filters.private} onChange=${() => flip("private")} /> Show private</label>
          <label><input type="checkbox" checked=${filters.hidden} onChange=${() => flip("hidden")} /> Show hidden threads</label>
        </div>
        <button className="lyr-new" type="button">New thread</button>
        <ul className="lyr-threads">
          ${visible.map((t) => html`<${ThreadRow} key=${t.id} t=${t} sel=${sel} open=${open[t.id]}
            onToggle=${(id) => setOpen((o) => ({ ...o, [id]: !o[id] }))} onSelect=${select} />`)}
        </ul>
        <nav className="lyr-side-foot">
          <a href="#memory" onClick=${(e) => e.preventDefault()}>Memory</a>
          <a href="#sleep" onClick=${(e) => e.preventDefault()}>Sleep <small>04:02 · 3 pages · 1 dream</small></a>
          <a href="#panel" onClick=${(e) => e.preventDefault()}>Control panel</a>
        </nav>
      </aside>
      <div className="lyr-scrim" onClick=${() => { setSideOpen(false); setSettingsOpen(false); }}></div>
      <section className="lyr-main">
        <header className="lyr-head">
          <button className="lyr-menu" type="button" aria-label="Show threads" onClick=${() => setSideOpen(true)}>☰</button>
          <div className="lyr-head-title">
            <h2>${cur.title}</h2>
            <div className="lyr-badges">
              <span className="lyr-badge" data-kind=${owner.pool === "private" ? "private" : ""}><span className="k">${owner.pool}</span></span>
              ${isSub
                ? html`<span className="lyr-badge" data-kind=${cur.kind}><span className="k">${cur.kind}</span>${cur.tier} subagent · ${cur.model}</span>`
                : html`<span className="lyr-badge" data-kind=${mainModel.kind}><span className="k">${mainModel.kind}</span>${mainModel.name} · ${mainModel.endpoint}</span>`}
              ${owner.folders.map((f) => html`<span key=${f.path} className="lyr-badge folders">${f.path} ${f.mode}</span>`)}
            </div>
          </div>
          <button className="lyr-gear" type="button" aria-expanded=${settingsOpen} onClick=${() => setSettingsOpen(!settingsOpen)}>⚙ <span className="long">Thread settings</span></button>
        </header>
        <div className="lyr-scroll" ref=${scroller}>
          ${list.map((m, i) => html`<${Message} key=${sel + i} m=${m} k=${sel + i} flags=${flags} toggle=${toggleFlag} threads=${threads} onSelect=${select} />`)}
        </div>
        <form className="lyr-composer" onSubmit=${send}>
          <button className="lyr-attach" type="button" aria-label="Attach a file">+</button>
          <textarea id="react-draft" rows="1" placeholder="Message Lyrica" aria-label="Message" value=${draft}
            onChange=${(e) => setDraft(e.target.value)}
            onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) send(e); }}></textarea>
          <button className="lyr-send" type="submit" disabled=${!draft.trim()}>Send</button>
        </form>
      </section>
      <${Settings} owner=${owner} isSub=${isSub} update=${update} onClose=${() => setSettingsOpen(false)} />
    </div>`;
  }

  ReactDOM.createRoot(document.getElementById("react-root")).render(html`<${App} />`);
})();
