import { describe, expect, it } from "vitest";
import { clientProof, hostProof, newCode, normaliseCode, pairingKey, sameProof, showCode } from "../src/index.ts";

describe("pairing proofs", () => {
  it("matches the test vector in PAIRING.md", () => {
    const key = pairingKey("7KQ2M9XD4RTBW1HZ");
    const [hostFp, clientFp, nonce] = ["1".repeat(64), "2".repeat(64), "A".repeat(43)];
    expect(key.toString("hex")).toBe("8551f07be59ec35fb366df9d9636af19c0eb255f91a8f68e50438a24ffc4c508");
    expect(clientProof(key, hostFp, clientFp, nonce)).toBe("acKMiH71_UsFFMT2FChTk49sf1unJSbzakH9g2jZpbY");
    expect(hostProof(key, hostFp, clientFp, nonce)).toBe("an8T3niOqqc4RbFGohVv7KASZd_iq2rLT4l6gaCy_l4");
  });

  it("binds both fingerprints", () => {
    const key = pairingKey(newCode());
    const real = clientProof(key, "a".repeat(64), "b".repeat(64), "n");
    expect(sameProof(real, clientProof(key, "c".repeat(64), "b".repeat(64), "n"))).toBe(false);
    expect(sameProof(real, clientProof(key, "a".repeat(64), "c".repeat(64), "n"))).toBe(false);
    expect(sameProof(real, clientProof(key, "a".repeat(64), "b".repeat(64), "n"))).toBe(true);
  });

  it("normalises typed codes", () => {
    const code = newCode();
    expect(normaliseCode(showCode(code).toLowerCase())).toBe(code);
    expect(normaliseCode("7kq2 m9xd-4rtb-wihz")).toBe("7KQ2M9XD4RTBW1HZ");
    expect(normaliseCode("O0LI-0000-0000-0000")).toBe("0011000000000000");
    expect(normaliseCode("7KQ2-M9XD-4RTB")).toBeNull();
    expect(normaliseCode("7KQ2-M9XD-4RTB-W1HU")).toBeNull();
  });
});
