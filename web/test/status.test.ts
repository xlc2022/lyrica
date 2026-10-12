import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaleUnitsLine } from "../src/StaleUnitsLine.tsx";

it("shows the Status action for one or several stale units, and no line otherwise", () => {
  const line = (units?: string[]) => renderToStaticMarkup(createElement(StaleUnitsLine, { units }));
  expect(line(["lyricad.service"])).toBe("<p>lyricad.service is older than this release. Run install.sh to update it.</p>");
  expect(line(["lyricad.service", "lyrica-update.path"])).toBe("<p>Some units are older than this release. Run install.sh to update them.</p>");
  expect(line([])).toBe("");
  expect(line()).toBe("");
});
