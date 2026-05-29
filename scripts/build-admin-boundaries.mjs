#!/usr/bin/env node
/*
 * Build the static administrative boundary assets used by public/boundary-layers.js.
 *
 * The source shapefiles are intentionally not committed. Re-run this script when those
 * files change or when a different simplification tolerance is needed.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const STATE_SHAPEFILE =
  process.env.US_STATES_SHP || "/mnt/d/tl_2022_us_state/tl_2022_us_state.shp";
const COUNTY_SHAPEFILE =
  process.env.US_COUNTIES_SHP || "/mnt/d/county_p010g.shp_nt00934/countyp010g.shp";

const OUT_STATES = "public/data/us-states.geojson";
const OUT_COUNTIES = "public/data/us-counties.geojson";
const OUT_INDEX = "public/data/us-admin-index.json";
const SIMPLIFY_TOLERANCE = process.env.ADMIN_BOUNDARY_TOLERANCE || "0.005";

function runOgr2Ogr(outputPath, sourcePath, selectedFields) {
  execFileSync(
    "ogr2ogr",
    [
      "-f",
      "GeoJSON",
      outputPath,
      sourcePath,
      "-t_srs",
      "EPSG:4326",
      "-select",
      selectedFields,
      "-simplify",
      SIMPLIFY_TOLERANCE,
      "-lco",
      "RFC7946=YES",
      "-lco",
      "COORDINATE_PRECISION=5",
    ],
    { stdio: "inherit" }
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 0));
}

function normalizeStates(rawStates) {
  const features = rawStates.features.map((feature) => {
    const properties = feature.properties || {};
    return {
      type: "Feature",
      properties: {
        statefp: String(properties.STATEFP || properties.GEOID || ""),
        stusps: String(properties.STUSPS || ""),
        name: String(properties.NAME || ""),
      },
      geometry: feature.geometry,
    };
  });

  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  return { type: "FeatureCollection", features };
}

function normalizeCounties(rawCounties) {
  const features = rawCounties.features.flatMap((feature) => {
    const properties = feature.properties || {};
    const geoid = String(properties.ADMIN_FIPS || "");
    const name = String(properties.ADMIN_NAME || properties.NAME || "").trim();

    // The source county shapefile includes a few blank-name state-water records
    // such as 17000 and 55000. They are not county polygons users can select.
    if (!geoid || !name) return [];

    return [{
      type: "Feature",
      properties: {
        geoid,
        statefp: String(properties.STATE_FIPS || ""),
        stusps: String(properties.STATE || ""),
        name,
      },
      geometry: feature.geometry,
    }];
  });

  features.sort((a, b) => {
    const stateCompare = a.properties.statefp.localeCompare(b.properties.statefp);
    if (stateCompare !== 0) return stateCompare;
    return a.properties.name.localeCompare(b.properties.name);
  });
  return { type: "FeatureCollection", features };
}

function buildIndex(states, counties) {
  const countiesByState = new Map();
  for (const county of counties.features) {
    const statefp = county.properties.statefp;
    if (!countiesByState.has(statefp)) countiesByState.set(statefp, []);
    countiesByState.get(statefp).push({
      geoid: county.properties.geoid,
      name: county.properties.name,
    });
  }

  const stateEntries = states.features.map((state) => {
    const stateCounties = countiesByState.get(state.properties.statefp) || [];
    stateCounties.sort((a, b) => a.name.localeCompare(b.name));
    return {
      statefp: state.properties.statefp,
      stusps: state.properties.stusps,
      name: state.properties.name,
      countyCount: stateCounties.length,
      counties: stateCounties,
    };
  });

  stateEntries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    stateCount: stateEntries.length,
    countyCount: counties.features.length,
    sources: {
      states: STATE_SHAPEFILE,
      counties: COUNTY_SHAPEFILE,
      simplificationToleranceDegrees: Number(SIMPLIFY_TOLERANCE),
    },
    states: stateEntries,
  };
}

function main() {
  const tmp = mkdtempSync(join(tmpdir(), "admin-boundaries-"));
  try {
    const rawStatesPath = join(tmp, "states.geojson");
    const rawCountiesPath = join(tmp, "counties.geojson");

    runOgr2Ogr(rawStatesPath, STATE_SHAPEFILE, "STATEFP,STUSPS,NAME");
    runOgr2Ogr(rawCountiesPath, COUNTY_SHAPEFILE, "ADMIN_NAME,ADMIN_FIPS,STATE,STATE_FIPS");

    const states = normalizeStates(readJson(rawStatesPath));
    const counties = normalizeCounties(readJson(rawCountiesPath));
    const index = buildIndex(states, counties);

    writeJson(OUT_STATES, states);
    writeJson(OUT_COUNTIES, counties);
    writeJson(OUT_INDEX, index);

    console.log(`Wrote ${OUT_STATES} (${states.features.length} states/territories)`);
    console.log(`Wrote ${OUT_COUNTIES} (${counties.features.length} counties)`);
    console.log(`Wrote ${OUT_INDEX}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
