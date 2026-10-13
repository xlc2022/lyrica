// Where a flyout goes and when hovering opens or closes it (docs/ux.md §3).
import { expect, it } from "vitest";
import { FLYOUT_CLOSE_MS, HOVER_OPEN_MS, flyoutBox, hoverIntent } from "../src/flyout.tsx";

const item = { x: 200, y: 100, width: 220, height: 36 };
const size = { x: 0, y: 0, width: 220, height: 140 };
const view = { width: 1280, height: 800 };

it("opens to the right with its top at the item's", () => {
  expect(flyoutBox(item, size, view)).toEqual({ left: 420, top: 100 });
});

it("flips to the left when there is no room on the right", () => {
  expect(flyoutBox({ ...item, x: 1050 }, size, view)).toEqual({ left: 830, top: 100 });
});

it("shifts up to stay on screen", () => {
  expect(flyoutBox({ ...item, y: 740 }, size, view)).toEqual({ left: 420, top: 652 });
});

it("opens a flyout after the intent delay once the pointer rests on its item", () => {
  expect(hoverIntent("", { kind: "item", key: "project" })).toEqual({ action: "open", key: "project", delay: HOVER_OPEN_MS });
});

it("switches to a sibling's submenu, which closes the open one", () => {
  expect(hoverIntent("share", { kind: "item", key: "group" })).toEqual({ action: "open", key: "group", delay: HOVER_OPEN_MS });
});

it("keeps an open flyout while the pointer moves toward it and rests inside", () => {
  expect(hoverIntent("share", { kind: "flyout" })).toBeNull();
  expect(hoverIntent("share", { kind: "item", key: "share" })).toBeNull();
});

it("closes when the pointer rests on a sibling item, or after it leaves the menu", () => {
  expect(hoverIntent("group", { kind: "item", key: null })).toEqual({ action: "close", delay: HOVER_OPEN_MS });
  expect(hoverIntent("group", { kind: "outside" })).toEqual({ action: "close", delay: FLYOUT_CLOSE_MS });
});

it("does nothing when there is no flyout to open or close", () => {
  expect(hoverIntent("", { kind: "item", key: null })).toBeNull();
  expect(hoverIntent("", { kind: "outside" })).toBeNull();
});
