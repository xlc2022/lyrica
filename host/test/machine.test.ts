import { describe, expect, it } from "vitest";
import { coresOf, cpuName } from "../src/machine.ts";

// Two cores with two threads each, as an SMT CPU lists them.
const SMT = [0, 1, 2, 3].map((n) => `processor\t: ${n}\nmodel name\t: AMD Ryzen 7 7800X3D 8-Core Processor\nphysical id\t: 0\ncore id\t\t: ${n % 2}\n`).join("\n");

describe("the machine", () => {
  it("names the CPU without trademarks, core count or clock", () => {
    expect(cpuName("AMD Ryzen 7 7800X3D 8-Core Processor")).toBe("AMD Ryzen 7 7800X3D");
    expect(cpuName("Intel(R) Core(TM) i9-13900K")).toBe("Intel Core i9-13900K");
    expect(cpuName("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")).toBe("Intel Xeon E5-2680 v4");
    expect(cpuName("")).toBeNull();
  });

  it("counts physical cores, not threads", () => {
    expect(coresOf(SMT)).toBe(2);
    expect(coresOf(`${SMT}\n${SMT.replace(/physical id\t: 0/g, "physical id\t: 1")}`)).toBe(4);
    expect(coresOf("processor\t: 0\nBogoMIPS\t: 50.00\n")).toBeNull();
  });
});
