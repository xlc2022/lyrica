import { describe, expect, it } from "vitest";
import { alwaysAllowPrefix, commandRules, decide } from "../src/workspace/rules.ts";

const forbid = commandRules([{ prefix: "git push", decision: "forbid" }]);
describe("project command matching", () => {
  it.each(['ls && git push', 'echo $(git push)', "bash -c 'git push'", "fish -c 'git push'", 'sudo git push', 'timeout 5 git push', 'FOO=1 git push', 'git -C . push', 'g"i"t push', 'g\\it push', 'ls | git push', '`git push`', '(git push)', 'find . -exec git push \\;', 'find . -execdir git -C . push {} +', 'find . -ok git push \\;'])("refuses %s", command => {
    expect(decide(command, forbid)).toEqual(forbid[0]);
  });
  it("asks about opaque programs and never allows them", () => {
    for (const command of ['x=git; $x push', 'eval "$cmd"', 'source task.sh', '. task.sh', 'bash task.sh', 'g* push']) {
      expect(decide(command, [...forbid, { prefix: 'bash', decision: 'allow' }])?.decision).toBe('ask');
      expect(alwaysAllowPrefix(command)).toBeUndefined();
    }
  });
  it("uses word count, then forbid, ask, allow; combines every part", () => {
    const rules = commandRules([{ prefix: 'git', decision: 'forbid' }, { prefix: 'git status', decision: 'allow' }, { prefix: 'npm test', decision: 'allow' }]);
    expect(decide('git status && npm test', rules)?.decision).toBe('allow');
    expect(decide('git status && ls', rules)).toBeUndefined();
    expect(decide('timeout 5 npm test', rules)).toBeUndefined();
    expect(decide('FOO=1 npm test', rules)?.decision).toBe('allow');
    expect(decide('git push', [{ prefix: 'git push', decision: 'allow' }, ...forbid])?.decision).toBe('forbid');
    expect(decide('git push', [{ prefix: 'git push', decision: 'allow' }, { prefix: 'git push', decision: 'ask' }])?.decision).toBe('ask');
  });
  it("offers only a single plain command's useful prefix", () => {
    expect(alwaysAllowPrefix('npm run test')).toBe('npm run test');
    expect(alwaysAllowPrefix('git push origin main')).toBe('git push');
    expect(alwaysAllowPrefix('ls -la')).toBe('ls');
    expect(decide('ls . \"$HOME\" *.txt', [...forbid, { prefix: 'ls', decision: 'allow' }])?.decision).toBe('allow');
    for (const command of ['node task.js', 'python3 task.py', 'sudo git push', 'ls && pwd', "bash -c 'ls'"]) expect(alwaysAllowPrefix(command)).toBeUndefined();
  });
  it("checks storage budgets and replaces repeated prefixes", () => {
    expect(commandRules([{ prefix: ' npm   test ', decision: 'ask' }, { prefix: 'npm test', decision: 'allow' }])).toEqual([{ prefix: 'npm test', decision: 'allow' }]);
    for (const prefix of ['', 'x'.repeat(65), 'a b c d e f g h i', 'git\npush']) expect(() => commandRules([{ prefix, decision: 'allow' }])).toThrow();
    expect(() => commandRules(Array.from({ length: 101 }, () => ({ prefix: 'ls', decision: 'allow' })))).toThrow();
  });
});
