// fetch connects only to public addresses: never this machine, the LAN, the
// tailnet or anything else private, checked for every connection, redirects
// included. The address checked is the address connected to.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
// Kept apart: Node's BlockList also matches plain IPv4 addresses against this range.
const mapped = new BlockList();
mapped.addSubnet("::ffff:0:0", 96, "ipv6");
for (const [net, bits] of [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, and Tailscale's tailnet
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // unique local, including Tailscale's fd7a:115c:a1e0::/48
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) blocked.addSubnet(net, bits, "ipv6");

/** True for an address fetch may connect to. */
export function isPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const dotted = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublic(dotted[1]!);
    return !mapped.check(address, "ipv6") && !blocked.check(address, "ipv6");
  }
  return false;
}

export class AddressRefused extends Error {}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for http(s).request that resolves the name and refuses it if any
 * of its addresses isn't allowed, so the connection can only go to a checked one.
 */
export function guardedLookup(allowed: (address: string) => boolean = isPublic) {
  return (hostname: string, options: object, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const bad = addresses.find((a) => !allowed(a.address));
      if (bad || !addresses.length) return callback(new AddressRefused(`${hostname} is a private or local address, which downloads may not use.`), []);
      if ((options as { all?: boolean }).all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
