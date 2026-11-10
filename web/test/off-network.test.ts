// A private machine, Git account or MCP server whose address has left the user's network is refused until they confirm
// it. The row's state function is what offers that: Off network, with Use anyway only while the refusal stands.
import { describe, expect, it } from "vitest";
import type { GitAccountInfo, MachineInfo, McpServerInfo } from "../src/api.ts";
import { gitState } from "../src/Git.tsx";
import { machineState } from "../src/Machines.tsx";
import { mcpState } from "../src/Mcp.tsx";

const since = "2026-11-10T10:00:00Z";
const refusedState = { kind: "offNetwork" as const, since };

describe("a row that went off network", () => {
  it("offers Use anyway while she is refused, and not once the user has accepted it", () => {
    const machine = (over: Partial<MachineInfo>) => ({ name: "vault", kind: "ssh", pool: "private", hostKey: "SHA256:x", offNetwork: false, ...over }) as MachineInfo;
    const account = (over: Partial<GitAccountInfo>) => ({ name: "forge", kind: "forgejo", pool: "private", offNetwork: false, ...over }) as GitAccountInfo;
    const server = (over: Partial<McpServerInfo>) => ({ name: "house", pool: "private", offNetwork: false, ...over }) as McpServerInfo;
    const refused = { tone: "warn", word: "Off network", refused: true };
    const accepted = { tone: "warn", word: "Off network" };
    expect(machineState(machine({ state: refusedState }))).toEqual(refused);
    expect(gitState(account({ state: refusedState }))).toEqual(refused);
    expect(mcpState(server({ state: refusedState }))).toEqual(refused);
    expect(machineState(machine({ offNetwork: true }))).toEqual(accepted);
    expect(gitState(account({ offNetwork: true }))).toEqual(accepted);
    expect(mcpState(server({ offNetwork: true }))).toEqual(accepted);
    // A general one is never refused for it: nothing to confirm.
    expect(machineState(machine({ pool: "general", state: refusedState }))).toEqual(accepted);
    expect(gitState(account({ pool: "general", state: refusedState }))).toBeUndefined();
    expect(mcpState(server({ pool: "general", state: refusedState }))).toBeUndefined();
  });
});
