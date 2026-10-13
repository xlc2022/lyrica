// The sidebar's status panel picks its endpoints from GET …/models/page: the two most-used local ones and the two
// most-used cloud ones, ranked by the page's endpointUses counts (web/src/SideStatus.tsx).
import { describe, expect, it } from "vitest";
import type { ModelsPage } from "../src/api.ts";
import { checkedAgo, selectStatus } from "../src/SideStatus.tsx";

const ep = (name: string, kind: "local" | "cloud", over: Record<string, unknown> = {}) => ({
  id: name, name, kind, api: "openai-compatible", baseUrl: "http://x/v1", hasApiKey: false, shared: false, unencrypted: false, stale: false, models: [], state: "up", ...over,
});
const use = (endpointId: string, calls: number) => ({ endpointId, calls });
const call = (kind: "local" | "cloud", endpointName: string) => ({ at: "2026-10-13T10:00:00Z", pool: "general", threadId: "t1", task: "chat", offeringId: "o1", label: `m/${endpointName}`, endpointName, kind });
const page = (endpoints: unknown[], hosts: unknown[] = [], uses: unknown[] = []) => ({ endpoints, hosts, calls: [], endpointUses: uses }) as unknown as ModelsPage;

describe("the sidebar's status panel picks its endpoints", () => {
  it("takes the two most-used of each kind, most used first", () => {
    const p = page(
      [ep("gpu", "local"), ep("box", "local"), ep("nas", "local"), ep("router", "cloud"), ep("openai", "cloud"), ep("grok", "cloud")],
      [],
      [use("gpu", 3), use("box", 1), use("nas", 2), use("router", 1), use("openai", 5), use("grok", 2)],
    );
    const { local, cloud } = selectStatus(p);
    expect(local.map((i) => i.name)).toEqual(["gpu", "nas"]);
    expect(cloud.map((i) => i.name)).toEqual(["openai", "grok"]);
  });

  it("keeps the endpoint order when use ties, and shows what there is when there are fewer than two", () => {
    const p = page([ep("a", "local"), ep("b", "local"), ep("c", "local"), ep("only", "cloud")]);
    const { local, cloud } = selectStatus(p);
    expect(local.map((i) => i.name)).toEqual(["a", "b"]);
    expect(cloud.map((i) => i.name)).toEqual(["only"]);
  });

  it("says nothing without a page or endpoints", () => {
    expect(selectStatus()).toEqual({ local: [], cloud: [] });
    expect(selectStatus(page([]))).toEqual({ local: [], cloud: [] });
  });

  it("gives each item the same dot and word as the Models area, and no word when it is simply up", () => {
    const host = (endpointId: string, state: string) => ({ endpointId, status: { name: "h", version: "1", fingerprint: "fp", state, gpus: [], downloads: { active: 0 }, modelsFolder: { path: "/models", free: 1 } } });
    const p = page(
      [ep("gpu", "local"), ep("blackwell", "local", { api: "host" }), ep("router", "cloud", { state: "down", downSince: "2026-10-13T09:59:00Z" })],
      [host("blackwell", "paused")],
    );
    const { local, cloud } = selectStatus(p);
    expect(local[0]).toMatchObject({ name: "gpu", dot: "up", word: undefined });
    expect(local[1]).toMatchObject({ name: "blackwell", dot: "away", word: "Paused" });
    expect(cloud[0]).toMatchObject({ name: "router", dot: "down", word: "Unreachable" });
  });

  it("ranks by endpointUses, not the recent-calls preview, and ignores counts for endpoints that are gone", () => {
    const p = { endpoints: [ep("gpu", "local"), ep("box", "local")], hosts: [], calls: [...Array(9).fill(call("local", "gpu"))], endpointUses: [use("box", 4), use("deleted-box", 9)] } as unknown as ModelsPage;
    expect(selectStatus(p).local.map((i) => i.name)).toEqual(["box", "gpu"]);
  });
});

describe("the panel's last-checked time", () => {
  it("counts in seconds to a minute and minutes after that, never backwards", () => {
    expect(checkedAgo(20_400)).toBe("20 s");
    expect(checkedAgo(59_900)).toBe("59 s");
    expect(checkedAgo(180_000)).toBe("3 min");
    expect(checkedAgo(-5_000)).toBe("0 s");
  });
});
