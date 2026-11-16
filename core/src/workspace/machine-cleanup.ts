// What a removed machine keeps of her, and the commands that take it away.
// Removing a machine only forgets it in Lyrica; these are for the user to
// run there if they want to. Free of Node modules, so the web interface's
// Remove machine dialog builds them from the machine's row.
import { SUDOERS_FILE } from "./sudoers.ts";

/** The root-owned file sshd reads her account's keys from (her own account only). */
export const keysFile = (account: string) => `/etc/ssh/authorized_keys/${account}`;
/** The sshd rule that points her account at `keysFile`. */
export const sshdRule = (account: string) => `/etc/ssh/sshd_config.d/lyrica-${account}.conf`;
/**
 * Reloads sshd wherever it runs: systemd's unit is `ssh` on Debian and Ubuntu and `sshd` on most others (Fedora,
 * Arch, NixOS, Gentoo), and OpenRC (Gentoo, Alpine) has `rc-service sshd`.
 */
export const RELOAD_SSHD = "if [ -d /run/systemd/system ]; then sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd; else sudo rc-service sshd reload; fi";

/** Where the steps run, for the line above them. */
export function cleanupWhere(m: CleanupMachine): string {
  if (m.kind === "proxmox") return "as root on the Proxmox node";
  return m.asUser ? "as that account" : "as a user with sudo";
}

/** One optional clean-up step: a name for its block's head, one line on what it does, and the command to paste. */
export interface CleanupStep { name: string; hint: string; command: string }

/** The machine as its row has it: what the steps need. */
export interface CleanupMachine {
  kind: "ssh" | "proxmox";
  /** account@host[:port] for SSH. */
  address: string;
  keyLine?: string;
  tokenId?: string;
  asUser?: boolean;
}

/** The key's base64 blob, the part of an authorized_keys line that names the key whatever its options or comment. */
export function keyBlob(keyLine: string | undefined): string | undefined {
  return keyLine?.split(/\s+/).find((w) => /^AAAA[A-Za-z0-9+/]+={0,2}$/.test(w));
}

/**
 * The steps for a removed machine, each a command of its own so the user
 * picks which to run. SSH on her own account: her key out of its keys file
 * (any other key there stays), her sudoers lines out of the sudoers file
 * (any other account's stay), and her account with its home folder, its
 * keys file and its sshd rule. On the user's own account only the key: the
 * account and its sudo are theirs. Proxmox: the token, and for her own
 * Proxmox user that user. Empty when nothing is known to take away.
 */
export function machineCleanup(m: CleanupMachine): CleanupStep[] {
  if (m.kind === "proxmox") {
    const [user, token] = (m.tokenId ?? "").split("!");
    if (!user || !token) return [];
    return [
      { name: "Token", hint: "Removes her token and its permissions.", command: `pveum user token remove ${user} ${token}` },
      ...(m.asUser ? [] : [{ name: "User", hint: `Deletes ${user}, the user made for her, with every token and permission it has.`, command: `pveum user delete ${user}` }]),
    ];
  }
  const at = m.address.indexOf("@");
  const account = at < 0 ? "" : m.address.slice(0, at);
  if (!/^[a-z_][a-z0-9_-]*$/i.test(account)) return [];
  const blob = keyBlob(m.keyLine);
  // `\|…|d` deletes the lines holding the blob; base64 has no `|`, and `+` and `/` are plain in a basic regular expression.
  const dropKey = (file: string) => `sed -i '\\|${blob}|d' ${file}`;
  if (m.asUser) {
    return blob ? [{ name: "Key", hint: `Removes her key from ${account}'s own keys file. Run it as ${account}, without sudo.`, command: dropKey("~/.ssh/authorized_keys") }] : [];
  }
  const keys = keysFile(account);
  return [
    ...(blob ? [{ name: "Key", hint: "Removes her key for this machine. Other keys in the file stay.", command: `sudo ${dropKey(keys)}` }] : []),
    {
      name: "Sudo",
      hint: `Removes the sudo rights given to ${account}, if any. Other accounts' lines stay.`,
      command: `sudo test ! -e ${SUDOERS_FILE} || sudo sed -i '/^${account} /d' ${SUDOERS_FILE}`,
    },
    {
      name: "Account",
      hint: `Deletes ${account} and its home folder with everything in it. Any other machine in Lyrica that uses this account loses it too.`,
      // Her logins go first, then whatever she still runs, then the account.
      command: [
        `sudo rm -f ${keys} ${sshdRule(account)}`,
        RELOAD_SSHD,
        `{ sudo pkill -KILL -u ${account}; sleep 1; }`,
        `sudo userdel --remove ${account}`,
      ].join(" &&\n"),
    },
  ];
}
