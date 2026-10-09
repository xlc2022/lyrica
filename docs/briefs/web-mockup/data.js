// Example data and pure helpers for the mockup. All of it is invented.
window.LYRICA = (function () {
  const models = [
    { id: "ds-or", name: "DeepSeek 4.1 Flash", endpoint: "OpenRouter", kind: "cloud" },
    { id: "glm-or", name: "GLM 5.3 Flash", endpoint: "OpenRouter", kind: "cloud" },
    { id: "qwen27-bw", name: "Qwen 3.8 27B", endpoint: "Blackwell host", kind: "local" },
    { id: "ds-bw", name: "DeepSeek 4.1 Flash", endpoint: "Blackwell host", kind: "local" },
    { id: "qfn-3090", name: "Qwen 3.8 Flash Next", endpoint: "3090 VM", kind: "local" },
  ];

  const threads = [
    {
      id: "t1", title: "Node-2 backup job", pool: "general", updated: "09:41",
      models: { main: "ds-or", cheap: "qfn-3090", strong: "glm-or" },
      localOnly: false, internet: true, services: false, hosts: ["192.168.1.40:8006"],
      folders: [{ path: "/srv/homelab", mode: "rw" }], perm: "Auto", unlogged: false, hidden: false,
      children: [
        { id: "t1a", title: "scout · read node-2 backup logs", role: "scout", tier: "cheap", status: "done", model: "Qwen 3.8 Flash Next", kind: "local", secs: 14 },
        { id: "t1b", title: "worker · keep the last 14 backups", role: "worker", tier: "strong", status: "running", model: "GLM 5.3 Flash", kind: "cloud", secs: 38 },
      ],
    },
    {
      id: "t2", title: "Letter to Mira", pool: "private", updated: "Yesterday",
      models: { main: "qwen27-bw", cheap: "qfn-3090", strong: "ds-bw" },
      localOnly: true, internet: false, services: false, hosts: [],
      folders: [{ path: "~/home/letters", mode: "rw" }], perm: "Ask before changes", unlogged: false, hidden: false,
      children: [],
    },
    {
      id: "t3", title: "Next week's calendar", pool: "general", updated: "Mon",
      models: { main: "glm-or", cheap: "qfn-3090", strong: "glm-or" },
      localOnly: false, internet: true, services: false, hosts: [],
      folders: [], perm: "Ask before changes", unlogged: false, hidden: false, children: [],
    },
    {
      id: "t4", title: "Reading: The Rings of Saturn", pool: "general", updated: "Sun",
      models: { main: "qwen27-bw", cheap: "qfn-3090", strong: "qwen27-bw" },
      localOnly: true, internet: false, services: false, hosts: [],
      folders: [], perm: "Auto", unlogged: false, hidden: false, children: [],
    },
    {
      id: "t5", title: "Scratch: pasta test", pool: "general", updated: "Oct 2",
      models: { main: "ds-or", cheap: "qfn-3090", strong: "glm-or" },
      localOnly: false, internet: false, services: true, hosts: [],
      folders: [], perm: "Auto", unlogged: true, hidden: true, children: [],
    },
  ];

  const messages = {
    t1: [
      { type: "recall", items: ["Node-2 is the oldest of the three Proxmox nodes.", "Li wants backups off the old NAS before winter."] },
      { type: "user", text: "The node-2 backup job failed again last night. Can you look at the logs and stop it filling the disk?" },
      { type: "lyrica", text: "I'll have a scout read the logs first, so we're not guessing." },
      { type: "sub", ref: "t1a", summary: "Retention is set to keep everything. The datastore is at 94%, and last night's job stopped when it ran out of space." },
      { type: "tool", name: "read", arg: "/srv/homelab/backup/node2.conf", state: "done", out: "storage: nas-old\nschedule: 02:30\nkeep-all: 1\nmode: snapshot" },
      { type: "tool", name: "edit", arg: "/srv/homelab/backup/node2.conf", state: "done", out: "- keep-all: 1\n+ keep-last: 14" },
      { type: "memory", text: "Li wants node-2 backups kept for 14 days." },
      { type: "lyrica", text: "Node-2 now keeps its last 14 backups. I left the older archives in place. Do you want me to prune them now, or after you've looked at the list?" },
    ],
    t1a: [
      { type: "user", who: "Lyrica", text: "Read the node-2 backup logs from the last three nights and tell me why the job fails." },
      { type: "tool", name: "bash", arg: "tail -n 40 /var/log/pve/backup-node2.log", state: "done", out: "INFO: starting new backup job: vzdump 101 102 --storage nas-old\nINFO: creating archive '/mnt/nas-old/dump/vzdump-qemu-101.vma.zst'\nERROR: write failed: No space left on device\nINFO: Backup job finished with errors" },
      { type: "lyrica", who: "scout", text: "Retention is set to keep everything. The datastore is at 94%, and last night's job stopped when it ran out of space." },
    ],
    t1b: [
      { type: "user", who: "Lyrica", text: "Change node-2's retention to keep the last 14 backups. Don't delete anything yet." },
      { type: "lyrica", who: "worker", text: "Checking the config format before editing…", streaming: true },
    ],
    t2: [
      { type: "user", text: "Help me start the letter to Mira. I don't want it to sound like an apology." },
      { type: "lyrica", text: "Then let's open with the walk by the canal rather than the argument. You told me that's the part you still think about. Something like: \"I keep coming back to that evening by the water.\"" },
    ],
    t3: [
      { type: "user", text: "What does next week look like?" },
      { type: "lyrica", text: "Calendar isn't connected yet, so I can't see it. Once it is, I'll read it from there." },
    ],
    t4: [
      { type: "user", text: "Why does Sebald keep returning to silk?" },
      { type: "lyrica", text: "Silk ties the book's wandering together. It runs from the Norwich weavers to the silkworms of the last chapter, and each return makes the earlier digressions look less like digressions." },
    ],
    t5: [
      { type: "user", text: "Can you reach the dev server on localhost:5173?" },
      { type: "tool", name: "bash", arg: "curl -sI http://127.0.0.1:5173", state: "done", out: "HTTP/1.1 200 OK\ncontent-type: text/html" },
      { type: "lyrica", text: "Yes, it's answering. This thread allows this machine's services." },
    ],
  };

  const replies = {
    t1: "Noted. I'll list the archives older than 14 days first, so you can check them before anything is deleted.",
    t2: "I'll keep the tone warm and plain. Shall I draft the next paragraph, or would you rather write it and have me read it?",
    t3: "Once the calendar is connected I'll summarise the week each Sunday evening, if you'd like that.",
    t4: "I'd like to come back to this after the chapter on Thomas Browne. It changes how the silk reads.",
    t5: "Got it.",
  };

  const byId = (id) => models.find((m) => m.id === id);

  return {
    clone() {
      return {
        threads: JSON.parse(JSON.stringify(threads)),
        messages: JSON.parse(JSON.stringify(messages)),
      };
    },
    models,
    model: byId,
    /** Models a thread may use: local only when the thread is private or local-only. */
    modelOptions(t) {
      return t.pool === "private" || t.localOnly ? models.filter((m) => m.kind === "local") : models;
    },
    /** After turning local-only on, swap any cloud choice for a local one. */
    enforceLocal(t) {
      if (!(t.pool === "private" || t.localOnly)) return;
      for (const k of ["main", "cheap", "strong"]) {
        if (byId(t.models[k]).kind === "cloud") t.models[k] = k === "cheap" ? "qfn-3090" : "qwen27-bw";
      }
    },
    /** Finds a thread or a subagent thread by ID, with its parent. */
    find(threads, id) {
      for (const t of threads) {
        if (t.id === id) return { thread: t, parent: null };
        for (const c of t.children) if (c.id === id) return { thread: { ...t, ...c, children: [], title: c.title }, parent: t };
      }
      return { thread: threads[0], parent: null };
    },
    visible(threads, f) {
      return threads.filter((t) => (t.pool === "general" ? f.general : f.private) && (!t.hidden || f.hidden));
    },
    reply(id) { return replies[id] || "Understood."; },
    subOf(threads, ref) {
      for (const t of threads) for (const c of t.children) if (c.id === ref) return c;
      return null;
    },
  };
})();
