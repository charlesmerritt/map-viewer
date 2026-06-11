#!/usr/bin/env node
/* Validate AppState layer group and time-source behavior in a browser-like VM. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = {
  console,
  Date,
  Math,
  Number,
  Object,
  Array,
  Set,
  Map,
  String,
};
sandbox.window = sandbox;

vm.runInNewContext(readFileSync("public/layer-groups-core.js", "utf8"), sandbox);
vm.runInNewContext(readFileSync("public/state.js", "utf8"), sandbox);

const State = sandbox.window.AppState;

State.addLayer({ id: "2020", name: "Forecast 2020", visible: true });
State.addLayer({ id: "2030", name: "Forecast 2030", visible: true });
State.addLayer({ id: "2040", name: "Forecast 2040", visible: true });

State.setSelectedLayerIds(["2020", "2030", "missing", "2020"]);
assert.deepEqual(State.getSelectedLayerIds(), ["2020", "2030"], "selection keeps known unique ids");

const group = State.createLayerGroup({
  name: "Forecast",
  layerIds: ["2020", "2030", "2040"],
  timeWidget: true,
});
State.setActiveTimeGroup(group.id);

assert.equal(State.getGroupForLayer("2030").id, group.id, "group lookup finds member layer");
const activeLayerIds = () => Array.from(
  State.getActiveTimeSource().times,
  (time) => time.layerId
);

assert.deepEqual(
  activeLayerIds(),
  ["2040", "2030", "2020"],
  "active group source defaults to top-to-bottom stack order"
);

State.updateLayerGroup(group.id, { orderMode: "bottom-to-top" });
assert.deepEqual(
  activeLayerIds(),
  ["2020", "2030", "2040"],
  "group source can play bottom-to-top"
);

State.assignLayerGroupOrder(group.id, ["2030", "2020"], 1);
assert.deepEqual(
  activeLayerIds(),
  ["2030", "2020", "2040"],
  "custom order puts numbered layers first"
);

State.ungroupLayerIds(["2030"]);
assert.equal(State.getGroupForLayer("2030"), null, "ungroup removes selected member");
assert.deepEqual(
  Array.from(State.getLayerGroup(group.id).layerIds),
  ["2020", "2040"],
  "group remains when at least two members remain"
);

console.log("AppState layer groups are valid.");
