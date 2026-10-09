// The DNS providers the built-in Caddy can get certificates through (DNS-01).
// One row each: the Caddy plugin (pinned; daemon/deploy/install.sh builds
// Caddy with every `module` below), the credential fields its JSON config
// takes, and how to make a token limited to one zone. Adding a provider means
// a row here and running install.sh again.

export interface ProviderField {
  /** The field in the plugin's JSON config. */
  name: string;
  label: string;
  /** Secret fields are never sent back by the API. */
  secret: boolean;
  optional?: boolean;
}

export interface Provider {
  /** Caddy's module name: `dns.providers.<id>`. */
  id: string;
  name: string;
  /** Go module and pinned version, for xcaddy. */
  module: string;
  fields: ProviderField[];
  /** How to make credentials that can change only this zone. */
  hint: string;
}

const secret = (name: string, label: string): ProviderField => ({ name, label, secret: true });
const plain = (name: string, label: string, optional = false): ProviderField => ({ name, label, secret: false, ...(optional ? { optional } : {}) });

export const PROVIDERS: readonly Provider[] = [
  {
    id: "cloudflare", name: "Cloudflare", module: "github.com/caddy-dns/cloudflare@v0.2.4",
    fields: [secret("api_token", "API token")],
    hint: "My Profile → API Tokens → Create Token → \"Edit zone DNS\", limited to your domain's zone.",
  },
  {
    id: "porkbun", name: "Porkbun", module: "github.com/caddy-dns/porkbun@v0.3.1",
    fields: [secret("api_key", "API key"), secret("api_secret_key", "Secret API key")],
    hint: "Account → API Access → create a key, then turn on API access for this one domain only.",
  },
  {
    id: "namecheap", name: "Namecheap", module: "github.com/caddy-dns/namecheap@v1.0.0",
    fields: [secret("api_key", "API key"), plain("user", "Account user name"), plain("client_ip", "This server's public IP (allow-listed)", true)],
    hint: "Profile → Tools → API Access; allow-list this server's public IP. Namecheap keys can't be limited to one domain.",
  },
  {
    id: "route53", name: "Amazon Route 53", module: "github.com/caddy-dns/route53@v1.6.2",
    fields: [plain("access_key_id", "Access key ID"), secret("secret_access_key", "Secret access key"), plain("region", "Region", true)],
    hint: "An IAM user whose policy allows route53:ChangeResourceRecordSets on one hosted zone, and route53:ListHostedZonesByName.",
  },
  {
    id: "digitalocean", name: "DigitalOcean", module: "github.com/caddy-dns/digitalocean@v0.0.0-20250606074528-04bde2867106",
    fields: [secret("auth_token", "API token")],
    hint: "API → Tokens → Generate New Token with custom scopes: domain read and update.",
  },
  {
    id: "hetzner", name: "Hetzner DNS", module: "github.com/caddy-dns/hetzner@v1.0.0",
    fields: [secret("auth_api_token", "API token")],
    hint: "dns.hetzner.com → API tokens. Hetzner tokens can't be limited to one zone; use a project for this zone alone.",
  },
  {
    id: "desec", name: "deSEC", module: "github.com/caddy-dns/desec@v1.1.0",
    fields: [secret("token", "Token")],
    hint: "Token management → create a token with a policy that allows only your domain's _acme-challenge records.",
  },
  {
    id: "duckdns", name: "Duck DNS", module: "github.com/caddy-dns/duckdns@v0.5.0",
    fields: [secret("api_token", "Token")],
    hint: "The token on duckdns.org's front page. It covers all your Duck DNS names.",
  },
];

export function provider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown DNS provider ${id}; providers are ${PROVIDERS.map((x) => x.id).join(", ")}`);
  return p;
}
