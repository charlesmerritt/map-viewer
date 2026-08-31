#!/usr/bin/env node
/*
 * Build the static administrative boundary assets used by public/boundary-layers.js.
 *
 * Sources are the Census Bureau's Cartographic Boundary Files
 * (https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html).
 * The Census zips are downloaded automatically; override with US_STATES_SHP /
 * US_COUNTIES_SHP to use a local shapefile or a different URL. Re-run this
 * script when the source vintage changes.
 *
 * States and counties must come from the same vintage year: Census warns that
 * geographic areas may not align across years.
 *
 * By default the CB 1:500,000 files are thinned with mapshaper's weighted
 * Visvalingam simplification (ADMIN_BOUNDARY_RETENTION, percent of removable
 * points to keep, default 40) so river borders keep their actual course while
 * the GeoJSON payload stays modest. Simplifying both layers in one mapshaper
 * run keeps shared borders vertex-aligned across states and counties; naive
 * per-polygon simplification (the old `ogr2ogr -simplify`) is what made the
 * boundaries choppy. Set ADMIN_BOUNDARY_RETENTION=100 to skip thinning — e.g.
 * when sourcing the already-generalized CB 1:5,000,000 files.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const STATE_SOURCE =
  process.env.US_STATES_SHP ||
  "https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_us_state_500k.zip";
const COUNTY_SOURCE =
  process.env.US_COUNTIES_SHP ||
  "https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_us_county_500k.zip";

const OUT_STATES = "public/data/us-states.geojson";
const OUT_COUNTIES = "public/data/us-counties.geojson";
const OUT_INDEX = "public/data/us-admin-index.json";
const RETENTION = Number(process.env.ADMIN_BOUNDARY_RETENTION || "40");

async function resolveShapefile(source, workDir) {
  if (!/^https?:\/\//.test(source)) return source;

  const zipPath = join(workDir, "source.zip");
  const extractDir = join(workDir, "extracted");
  mkdirSync(extractDir, { recursive: true });

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to download ${source}: HTTP ${response.status}`);
  }
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  execFileSync("unzip", ["-q", zipPath, "-d", extractDir], { stdio: "inherit" });

  const shapefiles = readdirSync(extractDir).filter((name) => name.endsWith(".shp"));
  if (shapefiles.length !== 1) {
    throw new Error(`Expected one shapefile in ${source}, found ${shapefiles.length}`);
  }
  return join(extractDir, shapefiles[0]);
}

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
      "-lco",
      "RFC7946=YES",
      "-lco",
      "COORDINATE_PRECISION=5",
    ],
    { stdio: "inherit" }
  );
}

/*
 * Simplify both layers together so shared borders (state outlines vs their
 * counties, adjacent counties) keep identical vertices. Mapshaper writes one
 * GeoJSON per layer named after its input file, with ".json" appended.
 */
function simplifyJointly(workDir, statesPath, countiesPath) {
  const outDir = join(workDir, "simplified");
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    "pnpm",
    [
      "-y",
      "dlx",
      "mapshaper",
      "-i",
      statesPath,
      countiesPath,
      // combine-files imports both layers into one shared topology, so
      // simplification decisions are identical for state outlines and the
      // counties that border them. Without it, mapshaper processes each file
      // with its own topology and shared borders drift apart.
      "combine-files",
      "-simplify",
      "weighted",
      `${RETENTION}%`,
      "keep-shapes",
      "-o",
      "format=geojson",
      "precision=0.00001",
      outDir + "/",
      "target=*",
    ],
    { stdio: "inherit" }
  );
  return {
    states: join(outDir, "states_norm.json"),
    counties: join(outDir, "counties_norm.json"),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 0));
}

/*
 * MapLibre GeoJSON sources only render Polygon/MultiPolygon geometry. Some
 * shapefiles (e.g. the CB 500k county file) contain sliver features that
 * ogr2ogr exports as GeometryCollection; keep their polygon parts as a
 * MultiPolygon and drop anything else.
 */
function flattenToPolygons(geometry) {
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return geometry;
  if (geometry.type === "GeometryCollection") {
    const polygons = [];
    for (const part of geometry.geometries) {
      if (part.type === "Polygon") polygons.push(part.coordinates);
      else if (part.type === "MultiPolygon") polygons.push(...part.coordinates);
    }
    return polygons.length ? { type: "MultiPolygon", coordinates: polygons } : null;
  }
  return null;
}

function normalizeStates(rawStates) {
  const features = rawStates.features.map((feature) => {
    const properties = feature.properties || {};
    const geometry = flattenToPolygons(feature.geometry);
    if (!geometry) throw new Error(`State feature has no polygon geometry: ${JSON.stringify(properties)}`);
    return {
      type: "Feature",
      properties: {
        statefp: String(properties.STATEFP || properties.GEOID || ""),
        stusps: String(properties.STUSPS || ""),
        name: String(properties.NAME || ""),
      },
      geometry,
    };
  });

  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  return { type: "FeatureCollection", features };
}

function normalizeCounties(rawCounties, stateAbbreviations) {
  const features = rawCounties.features.flatMap((feature) => {
    const properties = feature.properties || {};
    const geoid = String(properties.GEOID || properties.ADMIN_FIPS || "");
    const name = String(properties.NAME || properties.ADMIN_NAME || "").trim();

    // Older sources include a few blank-name state-water records such as
    // 17000 and 55000. They are not county polygons users can select.
    if (!geoid || !name) return [];

    const statefp = String(properties.STATEFP || properties.STATE_FIPS || "");
    const stusps = stateAbbreviations.get(statefp);
    if (!stusps) {
      throw new Error(`County ${geoid} (${name}) has state FIPS ${statefp} with no matching state`);
    }

    const geometry = flattenToPolygons(feature.geometry);
    if (!geometry) return [];

    return [{
      type: "Feature",
      properties: { geoid, statefp, stusps, name },
      geometry,
    }];
  });

  features.sort((a, b) => {
    const stateCompare = a.properties.statefp.localeCompare(b.properties.statefp);
    if (stateCompare !== 0) return stateCompare;
    return a.properties.name.localeCompare(b.properties.name);
  });
  return { type: "FeatureCollection", features };
}

function dropNullGeometry(collection, label) {
  const kept = collection.features.filter((feature) => feature.geometry);
  for (const feature of collection.features) {
    if (!feature.geometry) {
      console.warn(`Dropping ${label} with collapsed geometry: ${JSON.stringify(feature.properties)}`);
    }
  }
  return { type: "FeatureCollection", features: kept };
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
      states: STATE_SOURCE,
      counties: COUNTY_SOURCE,
      simplification: RETENTION < 100 ? `mapshaper weighted visvalingam ${RETENTION}%` : "none",
    },
    states: stateEntries,
  };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "admin-boundaries-"));
  try {
    const stateShapefile = await resolveShapefile(STATE_SOURCE, join(tmp, "states"));
    const countyShapefile = await resolveShapefile(COUNTY_SOURCE, join(tmp, "counties"));

    const rawStatesPath = join(tmp, "states.geojson");
    const rawCountiesPath = join(tmp, "counties.geojson");

    runOgr2Ogr(rawStatesPath, stateShapefile, "STATEFP,STUSPS,NAME");
    runOgr2Ogr(rawCountiesPath, countyShapefile, "STATEFP,GEOID,NAME");

    let states = normalizeStates(readJson(rawStatesPath));
    const stateAbbreviations = new Map(
      states.features.map((state) => [state.properties.statefp, state.properties.stusps])
    );
    let counties = normalizeCounties(readJson(rawCountiesPath), stateAbbreviations);

    if (RETENTION < 100) {
      const normStatesPath = join(tmp, "states_norm.geojson");
      const normCountiesPath = join(tmp, "counties_norm.geojson");
      writeJson(normStatesPath, states);
      writeJson(normCountiesPath, counties);

      const simplified = simplifyJointly(tmp, normStatesPath, normCountiesPath);
      states.features = readJson(simplified.states).features;
      counties.features = readJson(simplified.counties).features;

      states.features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
      counties.features.sort((a, b) => {
        const stateCompare = a.properties.statefp.localeCompare(b.properties.statefp);
        if (stateCompare !== 0) return stateCompare;
        return a.properties.name.localeCompare(b.properties.name);
      });
    }

    states = dropNullGeometry(states, "state");
    counties = dropNullGeometry(counties, "county");

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
