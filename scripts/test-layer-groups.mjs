#!/usr/bin/env node
/* Validate layer group ordering helpers used by the viewer UI/time slider. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Groups = require("../public/layer-groups-core.js");

const bottomToTop = ["base", "hazard-2020", "hazard-2030", "hazard-2040", "roads"];
const group = {
  layerIds: ["hazard-2020", "hazard-2030", "hazard-2040"],
  orderMode: "top-to-bottom",
  customOrder: {},
};

assert.deepEqual(
  Groups.orderLayerIds(group, bottomToTop),
  ["hazard-2040", "hazard-2030", "hazard-2020"],
  "top-to-bottom playback follows visible stack from top down"
);

assert.deepEqual(
  Groups.orderLayerIds({ ...group, orderMode: "bottom-to-top" }, bottomToTop),
  ["hazard-2020", "hazard-2030", "hazard-2040"],
  "bottom-to-top playback follows visible stack from bottom up"
);

assert.deepEqual(
  Groups.orderLayerIds(
    {
      ...group,
      orderMode: "custom",
      customOrder: {
        "hazard-2040": 1,
        "hazard-2020": 2,
      },
    },
    bottomToTop
  ),
  ["hazard-2040", "hazard-2020", "hazard-2030"],
  "custom playback puts numbered layers first, then unnumbered layers by stack order"
);

assert.deepEqual(
  Groups.normalizeUniqueLayerIds(["a", "b", "a", "missing"], ["a", "b", "c"]),
  ["a", "b"],
  "normalization keeps known layer ids once"
);

assert.equal(Groups.numberKeyToOrder("1"), 1, "1 key assigns order 1");
assert.equal(Groups.numberKeyToOrder("0"), 10, "0 key assigns order 10");
assert.equal(Groups.numberKeyToOrder("x"), null, "non-number key assigns no order");

console.log("Layer group helpers are valid.");
