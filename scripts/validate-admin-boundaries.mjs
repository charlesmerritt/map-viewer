#!/usr/bin/env node
/* Validate the static administrative boundary assets consumed by the viewer. */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const STATES_PATH = "public/data/us-states.geojson";
const COUNTIES_PATH = "public/data/us-counties.geojson";
const INDEX_PATH = "public/data/us-admin-index.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertFeatureCollection(path, requiredProperties) {
  const data = readJson(path);
  assert.equal(data.type, "FeatureCollection", `${path} must be a FeatureCollection`);
  assert.ok(Array.isArray(data.features), `${path} must include features[]`);
  assert.ok(data.features.length > 0, `${path} must include at least one feature`);

  for (const feature of data.features) {
    assert.equal(feature.type, "Feature", `${path} contains a non-Feature item`);
    assert.ok(feature.geometry, `${path} feature is missing geometry`);
    // MapLibre GeoJSON sources only render Polygon/MultiPolygon. Other
    // geometry types (e.g. GeometryCollection) are silently dropped.
    assert.ok(
      feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon",
      `${path} feature has unsupported geometry type ${feature.geometry.type}`
    );
    for (const property of requiredProperties) {
      assert.ok(
        Object.hasOwn(feature.properties || {}, property),
        `${path} feature is missing ${property}`
      );
      assert.notEqual(feature.properties[property], "", `${path} feature has blank ${property}`);
    }
  }

  return data;
}

const states = assertFeatureCollection(STATES_PATH, ["statefp", "stusps", "name"]);
const counties = assertFeatureCollection(COUNTIES_PATH, ["geoid", "statefp", "stusps", "name"]);
const index = readJson(INDEX_PATH);

assert.equal(index.stateCount, states.features.length, "index stateCount must match states GeoJSON");
assert.equal(index.countyCount, counties.features.length, "index countyCount must match counties GeoJSON");
assert.ok(Array.isArray(index.states), "index states[] is required");
assert.equal(index.states.length, states.features.length, "index states[] length must match states GeoJSON");

const stateFips = new Set(states.features.map((feature) => feature.properties.statefp));
const countyGeoids = new Set(counties.features.map((feature) => feature.properties.geoid));
assert.equal(stateFips.size, states.features.length, "state FIPS values must be unique");
assert.equal(countyGeoids.size, counties.features.length, "county GEOID values must be unique");

let indexedCountyCount = 0;
for (const state of index.states) {
  assert.ok(stateFips.has(state.statefp), `index references unknown state ${state.statefp}`);
  assert.ok(Array.isArray(state.counties), `index state ${state.statefp} is missing counties[]`);
  assert.equal(state.countyCount, state.counties.length, `countyCount mismatch for ${state.name}`);
  indexedCountyCount += state.counties.length;
  for (const county of state.counties) {
    assert.ok(countyGeoids.has(county.geoid), `index references unknown county ${county.geoid}`);
  }
}
assert.equal(indexedCountyCount, counties.features.length, "index must reference every county exactly once");

console.log(
  `Administrative boundary assets are valid: ${states.features.length} states/territories, ${counties.features.length} counties.`
);
