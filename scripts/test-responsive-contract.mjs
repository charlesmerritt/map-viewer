#!/usr/bin/env node
/* The responsive layout is split across three files: styles.css owns the
   breakpoints and the stacking scale, app.js drives the bottom sheet, and
   index.html supplies the elements both reach for. Nothing links them at
   build time, so this checks the seams that have actually broken.

   Layout itself is verified in a real browser; see
   scripts/check-responsive-browser.mjs and notes/responsive-and-accessibility.md. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, "public", p), "utf8");

const css = read("styles.css");
const html = read("index.html");
const app = read("app.js");
const draw = read("draw-tools.js");

// ---- The phone breakpoint is written in two places and must agree ----

const jsQuery = app.match(/const PHONE_QUERY = "\(([^"]+)\)"/);
assert.ok(jsQuery, "app.js must declare PHONE_QUERY");
const jsWidth = jsQuery[1].match(/max-width:\s*([\d.]+)px/)?.[1];
assert.ok(jsWidth, "PHONE_QUERY must be a max-width query");
assert.ok(
  css.includes(`@media (max-width: ${jsWidth}px)`),
  `styles.css must define the sheet layout at the same breakpoint as PHONE_QUERY (${jsWidth}px)`
);

// ---- Custom properties shared between CSS and JS ----

for (const [prop, file, name] of [
  ["--sheet-peek", app, "app.js"],
  ["--sheet-y", app, "app.js"],
  ["--sheet-pad", app, "app.js"],
  ["--time-bar-h", app, "app.js"],
]) {
  assert.ok(css.includes(prop), `styles.css must define or consume ${prop}`);
  assert.ok(file.includes(prop), `${name} must read or write ${prop}`);
}

// ---- Elements the scripts reach for must exist in the markup ----

const required = [
  "sidebar",
  "sheet-handle",
  "toggle-sidebar",
  "open-sidebar",
  "sidebar-resizer",
  "layers-panel",
  "time-bar",
  "draw-actions",
  "draw-finish",
  "draw-cancel",
  "draw-undo",
  "draw-vertex-count",
];
for (const id of required) {
  assert.ok(html.includes(`id="${id}"`), `index.html must contain #${id}`);
}
for (const id of ["draw-actions", "draw-finish", "draw-cancel", "draw-undo"]) {
  assert.ok(draw.includes(id), `draw-tools.js must wire #${id}`);
}

// ---- The layers panel is addressed by id, not by position ----

// A positional selector silently retargets whenever a child is added to the
// sidebar, which is exactly how the sheet handle broke the panel's flex sizing.
assert.ok(
  css.includes("#layers-panel {"),
  "the layers panel must be styled by id"
);
assert.ok(
  !/\.panel:nth-child\(/.test(css),
  "the sidebar's panels must not be selected by position"
);

// ---- Stacking order goes through the semantic scale ----

const zTokens = [...css.matchAll(/--z-[a-z-]+:\s*(\d+)/g)];
assert.ok(zTokens.length >= 5, "styles.css must define a semantic z-index scale");
// Values under 10 order siblings inside one stacking context (the sheet's
// sticky handle above its sticky header). App-wide layering must use a token.
const rawZ = [...css.matchAll(/^\s*z-index:\s*(\d+)\s*;/gm)]
  .map((m) => Number(m[1]))
  .filter((n) => n >= 10);
assert.deepEqual(
  rawZ,
  [],
  `app-level z-index must come from the --z-* scale, found raw values: ${rawZ.join(", ")}`
);

// ---- Viewport and safe areas ----

assert.ok(
  /name="viewport"[\s\S]{0,200}viewport-fit=cover/.test(html),
  "the viewport meta must set viewport-fit=cover so env(safe-area-inset-*) resolves"
);
for (const side of ["top", "right", "bottom", "left"]) {
  assert.ok(
    css.includes(`env(safe-area-inset-${side}`),
    `styles.css must resolve safe-area-inset-${side}`
  );
}

// ---- The app shell must not size itself with 100vh alone ----

// 100vh is the largest viewport on mobile, so the bottom of the app hides
// under the browser chrome until the user scrolls.
const shell = css.match(/#app \{[^}]+\}/)?.[0] ?? "";
assert.ok(shell.includes("100dvh"), "#app must size itself with dvh");

// ---- Touch targets ----

assert.ok(css.includes("--tap: 24px"), "the target floor must be the 24px WCAG 2.2 AA minimum");
assert.ok(
  /@media \(pointer: coarse\) \{\s*:root \{\s*--tap: 44px/.test(css),
  "coarse pointers must raise the target floor to 44px"
);

// ---- Hover must not be the only route to a control ----

assert.ok(
  /@media \(hover: hover\)[\s\S]{0,400}\.layer-group-rename \{\s*opacity: 0/.test(css),
  "the group rename button may only be hidden where hover exists"
);

// ---- Motion ----

assert.ok(
  css.includes("@media (prefers-reduced-motion: reduce)"),
  "styles.css must honour prefers-reduced-motion"
);

console.log("Responsive and accessibility contract is valid.");
