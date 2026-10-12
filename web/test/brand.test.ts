import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Brand } from "../src/Brand.tsx";

it("links to home and marks only the home route current", () => {
  const home = renderToStaticMarkup(createElement(Brand, { userId: "user", route: { page: "home", userId: "user" } }));
  expect(home).toContain('href="#/u/user"');
  expect(home).toContain('aria-current="page"');
  const away = renderToStaticMarkup(createElement(Brand, { userId: "user", route: { page: "sleep", userId: "user" } }));
  expect(away).toContain('href="#/u/user"');
  expect(away).not.toContain("aria-current");
});
