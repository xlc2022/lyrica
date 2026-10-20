import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GeneralSection } from "../src/Project.tsx";
import { PermissionPrompt } from "../src/Messages.tsx";
import type { CommandRule, PermissionRequest, ThreadSettings, ThreadSummary } from "../src/api.ts";
import type { ShellContext } from "../src/Shell.tsx";

const general = (rules: CommandRule[], checks: string[] = []) => renderToStaticMarkup(createElement(GeneralSection, {
  ctx: { user: { id: "ada" }, groups: [] } as unknown as ShellContext, base: "/project",
  summary: { id: "project", pool: "general", projectSettings: { commandRules: rules, checks } } as unknown as ThreadSummary,
  settings: { mode: "ask", models: { chat: { source: "column" } }, allowed: [], grants: [], machines: [], repositories: [], mcpServers: [] } as unknown as ThreadSettings,
  onSummary: () => {}, onSettings: () => {},
}));
const permission = (alwaysAllow?: string) => renderToStaticMarkup(createElement(PermissionPrompt, {
  base: "/project", p: { requestId: "call", toolCallId: "bash", tool: "bash", args: { command: "npm run test" }, expiresAt: "2026-10-14T00:00:00Z", alwaysAllow } satisfies PermissionRequest,
  env: { userId: "ada", pool: "general", threadId: "project" } as Parameters<typeof PermissionPrompt>[0]["env"],
}));

describe("command rules in the web UI", () => {
  it("puts Commands after This chat, with the page's single Save and the empty state", () => {
    const html = general([]);
    expect(html.indexOf("This chat</h3>")).toBeLessThan(html.indexOf("Commands</h3>"));
    expect(html).toContain("No rules: commands ask as the mode says.");
    expect(html.match(/>Save<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Add rule</button>");
  });
  it("shows saved decisions in the existing segment and refuses an invalid prefix before Save", () => {
    const html = general([{ prefix: "git push", decision: "forbid" }]);
    expect(html).toContain('class="mono" aria-label="Command prefix" placeholder="npm test" value="git push"');
    expect(html).toContain('class="seg" role="group"');
    expect(html).toContain('aria-pressed="true">Forbid</button>');
    expect(html).toContain('aria-label="Remove git push"');
    expect(html).toContain('placeholder="npm test"');
    const empty = general([{ prefix: "", decision: "ask" }]);
    expect(empty).not.toContain("A command prefix has 1 to 8 words");
    expect(empty).not.toContain('disabled="">Save</button>');
    const invalid = general([{ prefix: "git\u0001push", decision: "ask" }]);
    expect(invalid).toContain('disabled="">Save</button>');
    expect(invalid).toContain("A command prefix has 1 to 8 words");
    const duplicate = general([{ prefix: "npm test", decision: "allow" }, { prefix: " npm   test ", decision: "forbid" }]);
    expect(duplicate).toContain("Each prefix can have one rule.");
    expect(duplicate).toContain('disabled="">Save</button>');
  });
  it("puts Checks after Commands, one mono command per row, and refuses a multi-line one before Save", () => {
    const html = general([]);
    expect(html.indexOf("Commands</h3>")).toBeLessThan(html.indexOf("Checks</h3>"));
    expect(html).toMatch(/No checks: .+ runs what the repository asks\./);
    expect(html).toContain("Add check</button>");
    const set = general([], ["npm run typecheck"]);
    expect(set).toContain('class="mono" aria-label="Check command" placeholder="npm test" value="npm run typecheck"');
    expect(set).toContain('aria-label="Remove npm run typecheck"');
    const invalid = general([], ["npm test\nrm -rf x"]);
    expect(invalid).toContain("A check is one line of at most 300 characters");
    expect(invalid).toContain('disabled="">Save</button>');
    expect(general([], Array.from({ length: 8 }, (_, i) => `check ${i}`))).toContain('disabled="">Add check</button>');
  });
  it("offers Always allow between Allow and Deny only with a daemon prefix", () => {
    const html = permission("npm run test");
    expect(html.indexOf(">Allow</button>")).toBeLessThan(html.indexOf("Always allow"));
    expect(html.indexOf("Always allow")).toBeLessThan(html.indexOf(">Deny</button>"));
    expect(html).toContain('class="mono">npm run test</span>');
    expect(permission()).not.toContain("Always allow");
  });
});
