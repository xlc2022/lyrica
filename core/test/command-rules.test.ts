import { describe, expect, it } from "vitest";
import { alwaysAllowPrefix, commandRules, decide, DEFAULT_COMMAND_RULES, setupOnly, sourcedFile } from "../src/workspace/rules.ts";

const forbid = commandRules([{ prefix: "git push", decision: "forbid" }]);
describe("project command matching", () => {
  it.each(['ls && git push', 'echo $(git push)', "bash -c 'git push'", "fish -c 'git push'", 'sudo git push', 'timeout 5 git push', 'FOO=1 git push', 'git -C . push', 'g"i"t push', 'g\\it push', 'ls | git push', '`git push`', '(git push)', 'find . -exec git push \\;', 'find . -execdir git -C . push {} +', 'find . -ok git push \\;', 'x=git; $x push', 'x=/usr/bin/git; "${x}" push', 'L=/lib/ld-linux-x86-64.so.2; $L /usr/bin/git push'])("refuses %s", command => {
    expect(decide(command, forbid)).toEqual(forbid[0]);
  });
  it("asks about opaque programs and never allows them", () => {
    for (const command of ['$x push', 'x=git && $x push', 'x=git; x=ls; $x push', "x='git'; $x push", 'x=git y; $x push', 'echo # x=git\n$x push', 'L=/lib/ld.so; $L bash task.sh', 'eval "$cmd"', 'source task.sh', '. task.sh', 'bash task.sh', 'g* push']) {
      expect(decide(command, [...forbid, { prefix: 'bash', decision: 'allow' }])?.decision).toBe('ask');
      expect(alwaysAllowPrefix(command)).toBeUndefined();
    }
  });
  it("reads a program the line names in a variable, so a read-only call doesn't ask", () => {
    const command = 'L=/deps/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2; P=/deps/usr/lib:/deps/lib; "$L" --library-path "$P" /deps/usr/bin/cmake --version; "$L" --library-path "$P" /deps/usr/lib/qt6/libexec/moc -v; ls /deps/usr/lib/cmake/Qt6; ls /deps/usr/lib/libQt6Widgets*';
    expect(decide(command, DEFAULT_COMMAND_RULES)).toBeUndefined();
    expect(decide('L=/lib/ld.so; "$L" /bin/rm -rf /', DEFAULT_COMMAND_RULES)?.decision).toBe('forbid');
  });
  it("looks for a glob only where a wrapper's program is, not in its arguments", () => {
    const command = 'cd /workspace && timeout 60 curl -sI https://example.org/a.dts | head -5; echo "---"; timeout 60 curl -s "https://example.org/plain/a.dts?h=linux-6.18.y" | head -20';
    expect(decide(command, DEFAULT_COMMAND_RULES)).toBeUndefined();
    expect(decide("sudo grep -r 'a.*b' /etc", DEFAULT_COMMAND_RULES)).toBeUndefined();
    expect(decide(`cd /workspace && for t in pdftoppm gs qpdf; do printf '%-12s ' $t; command -v $t || echo "-"; done`, DEFAULT_COMMAND_RULES)).toBeUndefined();
    expect(decide("command $t push", DEFAULT_COMMAND_RULES)?.decision).toBe("ask");
    expect(decide(`for p in '**Device:**' '| Part |'; do\n  n=$(grep -c -F -e "$p" STATUS.md); [ "$n" = 1 ] || printf 'MISS %s\\n' "$p"\ndone`, DEFAULT_COMMAND_RULES)).toBeUndefined();
    for (const c of ["gi[t] push", "/usr/bin/[g]it push", "[[ -f x ]] && g* push"]) expect(decide(c, DEFAULT_COMMAND_RULES)?.decision, c).toBe("ask");
    for (const c of ["timeout 5 /usr/bin/gi? push", "sudo -u root g* push", "timeout --signal KILL 5 /bin/gi[t] push", "timeout 5 $x push", "sudo eval x", "nice bash task.sh",
      "sudo --user root g* push --force", "sudo -D /tmp g* push --force", "env --chdir /tmp g* push --force", "nice --adjustment 5 g* push --force", "sudo --user root --group adm g* push"]) {
      expect(decide(c, DEFAULT_COMMAND_RULES)?.decision, c).toBe("ask");
    }
  });
  it("reads a here-document as the program's input, not as commands, unless a shell runs it", () => {
    const command = "cd /tmp && curl -s -o p.json https://example.org/p.json && python3 - <<'EOF'\nimport json\nd=json.load(open('/tmp/p.json'))\nfor k,v in sorted(d['profiles'].items()):\n    print(f\"{k:26s} {','.join(v) if v else '-'}\")\nEOF";
    expect(decide(command, DEFAULT_COMMAND_RULES)).toBeUndefined();
    expect(decide("cat <<'EOF' > notes.txt\ngit push --force\nEOF\nls", DEFAULT_COMMAND_RULES)).toBeUndefined();
    for (const run of ["bash <<'EOF'\ngit push --force\nEOF", "ssh host <<EOF\ngit push -f\nEOF", "cat <<'EOF' | bash\ngit push --force\nEOF", "cat <<'EOF' > >(bash)\ngit push --force\nEOF",
      "sudo -s <<'EOF'\ngit push --force\nEOF", "runuser -u ada <<'EOF'\ngit push --force\nEOF", "cat <<EOF\n$(git push --force)\nEOF", "sudo bash <<-EOF\n\tgit push --force\n\tEOF"]) {
      expect(decide(run, DEFAULT_COMMAND_RULES)?.decision, run).toBe("forbid");
    }
  });
  it("looks inside a sourced script that only sets things up", () => {
    const command = 'cd /workspace/c5400/src/linux && source /workspace/c5400/build/env.sh && make ARCH=arm dtbs -j12 > /workspace/c5400/build/dtbs.log 2>&1; echo "rc=$?"';
    expect(sourcedFile(command)).toEqual({ cds: ['/workspace/c5400/src/linux'], path: '/workspace/c5400/build/env.sh' });
    const env = '#!/bin/sh\n# cross tools\nexport ARCH=arm\nexport CROSS_COMPILE=arm-linux-gnueabi-\nexport PATH="$TC/bin:$PATH"\nif [ -d "$HOME/x" ]; then export X=1; fi\nexport JOBS=$(nproc) # all of them\nTOP=$(realpath "$(dirname "$0")")\n';
    expect(setupOnly(env)).toBe(true);
    expect(decide(command, DEFAULT_COMMAND_RULES, env)).toBeUndefined();
    // Unread, or not only setup, it stays opaque; a rule the script breaks is broken by the line.
    expect(decide(command, DEFAULT_COMMAND_RULES)?.decision).toBe('ask');
    for (const script of ['git push -f', 'make() { ls; }', "alias make='ls'", 'export BASH_ENV=/tmp/x', "PS4='$(id)'", 'export N=$(git push -f)', 'source ./more.sh', 'for f in a; do export F=$f; done', 'printf -v PS4 x', 'declare -n r=BASH_ENV\nr=/tmp/e.sh', 'typeset -xn r=IFS', 'local -n r=CDPATH', 'x'.repeat(70000)]) {
      expect(setupOnly(script), script).toBe(false);
      expect(decide(command, DEFAULT_COMMAND_RULES, script)?.decision, script).not.toBeUndefined();
    }
    expect(decide(command, DEFAULT_COMMAND_RULES, 'make() { ls; }\ngit push -f')?.decision).toBe('forbid');
    expect(decide(command, DEFAULT_COMMAND_RULES, 'make() { ls; }')?.decision).toBe('ask');
    expect(decide('. ./env.sh && git status', [{ prefix: 'export', decision: 'forbid' }], 'export A=1')?.prefix).toBe('export');
    expect(decide('. ./env.sh && git status', [...DEFAULT_COMMAND_RULES, { prefix: 'export', decision: 'ask' }], 'export A=1')?.decision).toBe('ask');
    // Only a literal path with a slash, with nothing but cds before it, so the line can't change or swap the file first.
    for (const line of ['source env.sh', 'source $E', 'source ~/env.sh', 'echo x > ./env.sh && source ./env.sh', 'cd $D && source ./env.sh', 'cd >./env.sh a && source ./env.sh', 'git pull; . ./env.sh', 'cd /a && cd /b && cd - && source ./env.sh', 'cd -P /a && source ./env.sh']) {
      expect(sourcedFile(line), line).toBeUndefined();
      expect(decide(line, DEFAULT_COMMAND_RULES, 'export A=1')?.decision, line).toBe('ask');
    }
    // A second source after the one seen through is still opaque.
    expect(decide('. ./env.sh && . ./more.sh', DEFAULT_COMMAND_RULES, 'export A=1')?.decision).toBe('ask');
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
  it("starts a project with rules that forbid rewriting the remote and sweeping deletes, and nothing else", () => {
    expect(commandRules(DEFAULT_COMMAND_RULES)).toEqual(DEFAULT_COMMAND_RULES);
    for (const command of ["git push --force", "git push origin main --force", "git push -f origin main", "ls && git push --force", "rm -rf /", "sudo rm -rf /", "rm -fr /"]) {
      expect(decide(command, DEFAULT_COMMAND_RULES)?.decision, command).toBe("forbid");
    }
    // Rules match words exactly; `--force-with-lease` is left to the suspect-command card.
    for (const command of ["git push", "git push -u origin main", "git push --force-with-lease", "rm -rf ./build", "rm -rf /tmp/x", "npm test"]) expect(decide(command, DEFAULT_COMMAND_RULES), command).toBeUndefined();
  });
  it("checks storage budgets and replaces repeated prefixes", () => {
    expect(commandRules([{ prefix: ' npm   test ', decision: 'ask' }, { prefix: 'npm test', decision: 'allow' }])).toEqual([{ prefix: 'npm test', decision: 'allow' }]);
    for (const prefix of ['', 'x'.repeat(65), 'a b c d e f g h i', 'git\npush']) expect(() => commandRules([{ prefix, decision: 'allow' }])).toThrow();
    expect(() => commandRules(Array.from({ length: 101 }, () => ({ prefix: 'ls', decision: 'allow' })))).toThrow();
  });
});
