import { describe, expect, it } from "vitest";
import { Forbidden, PairingFailed, normaliseCode, pairingProofs } from "../src/index.ts";
import { deadUrl } from "./fake-openai.ts";
import { fakeHost } from "./fake-host.ts";
import { profile, withModels } from "./helpers.ts";

async function setup() {
  const m = await withModels();
  const bob = await m.users.createUser("bob", "pw", profile("Bob"), { admin: false });
  await m.users.authenticate("bob", "pw");
  const host = await fakeHost({ name: "lyrica-blackwell" });
  return { ...m, bob, host };
}

describe("pairing", () => {
  it("matches the test vector in host/PAIRING.md", () => {
    expect(normaliseCode("7kq2-m9xd-4rtb-w1hz")).toBe("7KQ2M9XD4RTBW1HZ");
    expect(normaliseCode("7KQ2 M9XD 4RTB WIHZ")).toBe("7KQ2M9XD4RTBW1HZ");
    expect(pairingProofs("7KQ2M9XD4RTBW1HZ", "1".repeat(64), "2".repeat(64), "A".repeat(43))).toEqual({
      client: "acKMiH71_UsFFMT2FChTk49sf1unJSbzakH9g2jZpbY", host: "an8T3niOqqc4RbFGohVv7KASZd_iq2rLT4l6gaCy_l4",
    });
  });

  it("pins both sides, and the host's models become offerings", async () => {
    const s = await setup();
    const ep = await s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: s.host.newCode() });
    expect(ep).toMatchObject({ api: "host", kind: "local", fingerprint: s.host.fingerprint, addresses: [s.host.address], unencrypted: false });
    // The host pinned this lyricad's key, which lives in self.db.
    const mine = (s.keyring.self().prepare("SELECT cert FROM host_identity").get() as { cert: string }).cert;
    const { fingerprint } = await import("../src/index.ts");
    expect([...s.host.pinned.keys()]).toEqual([fingerprint(mine)]);
    const [o] = await s.models.discover(s.li, ep.id);
    expect(o).toMatchObject({ modelId: "lyrica/huggingface/Qwen/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf", contextWindow: 32768, tools: true, reasoning: ["medium"], digest: "ab".repeat(32) });
    expect(await s.models.probe(s.li.id, ep.id)).toEqual({ state: "up" });
  });

  it("refuses a malformed code without contacting the host, and a wrong one without pinning", async () => {
    const s = await setup();
    await expect(s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: "short" })).rejects.toThrow(PairingFailed);
    expect(s.host.requests).toBe(0);
    await expect(s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: "0000-0000-0000-0000" })).rejects.toThrow(/no pairing code/);
    s.host.newCode();
    await expect(s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: "0000-0000-0000-0000" })).rejects.toThrow(/didn't match/);
    expect(s.host.pinned.size).toBe(0);
    expect(s.models.endpoints(s.li.id).some((e) => e.api === "host")).toBe(false);
  });

  it("pins nothing when the host can't prove it knows the code", async () => {
    const s = await setup();
    s.host.lie();
    await expect(s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: s.host.newCode() })).rejects.toThrow(/couldn't prove/);
    expect(s.models.endpoints(s.li.id).some((e) => e.api === "host")).toBe(false);
  });
});

describe("calling a host", () => {
  it("tries the addresses in order, and an edited address keeps trust and IDs", async () => {
    const s = await setup();
    const dead = new URL(await deadUrl()).host;
    const ep = await s.models.pairHost(s.li, { name: "blackwell", addresses: [dead, s.host.address], code: s.host.newCode() });
    const [o] = await s.models.discover(s.li, ep.id);
    await s.host.move();
    expect(await s.models.probe(s.li.id, ep.id)).toMatchObject({ state: "down" });
    const moved = s.models.setHostAddresses(s.li, ep.id, [s.host.address]);
    expect(moved).toMatchObject({ id: ep.id, fingerprint: ep.fingerprint });
    expect(await s.models.probe(s.li.id, ep.id)).toEqual({ state: "up" });
    expect(s.models.offerings(s.li.id, ep.id).map((x) => x.id)).toEqual([o!.id]);
  });

  it("refuses a host whose key changed, with the plain reason, before sending anything, and pairing again keeps its IDs", async () => {
    const s = await setup();
    const ep = await s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: s.host.newCode() });
    const [o] = await s.models.discover(s.li, ep.id);
    await s.host.replaceKey();
    const before = s.host.requests;
    await expect(s.models.hostStatus(s.li.id, ep.id)).rejects.toThrow("This host's identity changed. Pair it again.");
    expect(s.host.requests).toBe(before);
    expect(await s.models.probe(s.li.id, ep.id)).toMatchObject({ state: "down" });
    const again = await s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: s.host.newCode() }, { endpointId: ep.id });
    expect(again).toMatchObject({ id: ep.id, fingerprint: s.host.fingerprint });
    await s.models.discover(s.li, ep.id);
    expect(s.models.offerings(s.li.id, ep.id).map((x) => x.id)).toEqual([o!.id]);
  });

  it("falls back when the host is paused, and back again when it resumes", async () => {
    const s = await setup();
    const ep = await s.models.pairHost(s.li, { name: "blackwell", addresses: [s.host.address], code: s.host.newCode() });
    const [o] = await s.models.discover(s.li, ep.id);
    s.models.setProfile(s.li.id, "local", "chat", [{ offeringId: o!.id }, s.localRef]);
    const priv = { userId: s.li.id, pool: "private" as const, localOnly: true };
    expect((await s.models.resolveLive("chat", priv)).ref).toEqual({ offeringId: o!.id });
    await s.models.hostControl(s.li, ep.id, "pause");
    const r = await s.models.resolveLive("chat", priv);
    expect(r.ref).toEqual(s.localRef);
    expect(r.skipped[0]).toEqual({ label: `blackwell/${o!.modelId}`, reason: "blackwell is down" });
    // A paused host answers its /v1 with "paused", which marks it down too.
    s.host.pause(false);
    await s.models.hostControl(s.li, ep.id, "resume");
    expect((await s.models.resolveLive("chat", priv)).ref).toEqual({ offeringId: o!.id });
    s.host.pause(true);
    const res = await s.models.fetchFor(ep)!(`https://${s.host.address}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: o!.modelId, messages: [] }) });
    expect(res.status).toBe(503);
    expect(s.models.resolve("chat", priv).ref).toEqual(s.localRef);
  });
});

describe("shared and personal hosts", () => {
  it("keeps a personal host to its user, and lets only administrators manage a shared one", async () => {
    const s = await setup();
    const mine = await s.models.pairHost(s.bob, { name: "laptop", addresses: [s.host.address], code: s.host.newCode() });
    expect(s.models.endpoint(s.li.id, mine.id)).toBeUndefined();
    await expect(s.models.hostStatus(s.li.id, mine.id)).rejects.toThrow(/no model host/);
    // Bob manages his own.
    expect(await s.models.hostControl(s.bob, mine.id, "pause")).toMatchObject({ state: "paused" });
    await s.models.hostControl(s.bob, mine.id, "resume");

    const other = await fakeHost({ name: "lyrica-3090" });
    await expect(s.models.pairHost(s.bob, { name: "gpu3090", addresses: [other.address], code: other.newCode() }, { shared: true })).rejects.toThrow(Forbidden);
    const shared = await s.models.pairHost(s.li, { name: "gpu3090", addresses: [other.address], code: other.newCode() }, { shared: true });
    expect(await s.models.hostStatus(s.bob.id, shared.id)).toMatchObject({ name: "lyrica-3090", state: "running" });
    await expect(s.models.hostControl(s.bob, shared.id, "pause")).rejects.toThrow(Forbidden);
    expect(() => s.models.setHostAddresses(s.bob, shared.id, ["127.0.0.1:1"])).toThrow(Forbidden);
    expect(() => s.models.removeEndpoint(s.bob, shared.id)).toThrow(Forbidden);
    expect(await s.models.hostControl(s.li, shared.id, "pause")).toMatchObject({ state: "paused" });
  });
});
