// Put before web-render.cjs and browse.cjs (web.ts, browse.ts): how the sandbox's Chromium presents itself to a site.
// Headless Chromium names itself HeadlessChrome in its user agent, and headless-shell in its client hints too;
// headless-shell sends no Accept-Language, and both set navigator.webdriver. A site's bot check reads each, and a
// user agent from another browser than the engine is a tell of its own. So each page, frame and worker gets what a
// desktop Chromium of the same version sends: Chrome's reduced user agent (major.0.0.0) and client hints listing
// Chromium beside the GREASE brand Chromium picks for that major version (Chromium's
// components/embedder_support/user_agent_utils.cc: GetGreasedUserAgentBrandVersion, GenerateBrandVersionList).
const AGENT_FLAGS = ["--disable-blink-features=AutomationControlled"];
/** The Network.setUserAgentOverride parameters, from the browser's own Browser.getVersion. */
function desktopAgent({ product, userAgent }) {
  const full = String(product).split("/")[1] ?? "";
  const major = Number(full.split(".")[0]) || 0;
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const grease = { brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`, version: ["8", "99", "24"][major % 3] };
  const list = (g, c) => { const l = []; l[major % 2] = g; l[(major + 1) % 2] = c; return l; };
  const arm = process.arch === "arm64";
  return {
    userAgent: String(userAgent).replace(/HeadlessChrome\/[0-9.]+/, `Chrome/${major}.0.0.0`),
    acceptLanguage: "en-US,en",
    userAgentMetadata: {
      brands: list(grease, { brand: "Chromium", version: String(major) }),
      fullVersionList: list({ brand: grease.brand, version: `${grease.version}.0.0.0` }, { brand: "Chromium", version: full }),
      platform: "Linux", platformVersion: "", architecture: arm ? "arm" : "x86", bitness: "64", model: "", mobile: false, wow64: false,
    },
  };
}
