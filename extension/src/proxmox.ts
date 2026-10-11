import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PROXMOX_ACTIONS, type ProxmoxAction } from "@lyrica/core";
import { Type } from "typebox";

/** The proxmox tool: a schema and one call into core/workspace. Asking is the workspace extension's, as for bash on a machine; `check` throws if the call isn't what was approved. */
export function proxmoxTool(run: (machine: string, action: ProxmoxAction, vm?: string) => Promise<string>, check: (id: string, input: Record<string, unknown>) => void): ToolDefinition {
  return {
    name: "proxmox",
    label: "Proxmox",
    description: "Check and power VMs and containers on one of your Proxmox machines, through its API: status, list, start, "
      + "shutdown (asks the guest to shut down), stop (cuts the power), reboot, and snapshots (lists them). Nothing else: no create, destroy or console.",
    promptSnippet: "check, start and shut down VMs on your Proxmox machines",
    promptGuidelines: ["Prefer proxmox shutdown to stop: stop cuts the power, like pulling the plug."],
    parameters: Type.Object({
      machine: Type.String({ description: "One of your Proxmox machines, by name." }),
      action: Type.Union(PROXMOX_ACTIONS.map((a) => Type.Literal(a))),
      vm: Type.Optional(Type.String({ description: "The VM or container, by number or name. Every action but list needs one." })),
    }),
    async execute(id, p: { machine: string; action: ProxmoxAction; vm?: string }) {
      check(id, p);
      return { content: [{ type: "text", text: await run(p.machine, p.action, p.vm) }], details: undefined };
    },
  } as ToolDefinition;
}
