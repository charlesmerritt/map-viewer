#!/usr/bin/env node
// Drive the real viewer through the Upload path in headless Chrome, with the
// client pointed at a LOCAL TiTiler, and screenshot what the user sees.
//
//   APP=http://127.0.0.1:3311 TITILER=http://127.0.0.1:8311 FILE=/path/src.tif \
//   OUT=/path/out NODE_PATH=/path/with/puppeteer-core/node_modules \
//   node notes/basal-area-render/browser_repro.mjs
//
// Writes:
//   browser_as_shipped.png   the layer exactly as addTiTilerLayer builds it (no rescale)
//   browser_rescaled.png     same layer, same view, with rescale=<RESCALE> added
//   browser_tiles.json       every TiTiler tile URL the page requested, plus map zoom
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(join(process.env.NODE_PATH || ".", "x.js"));
const puppeteer = require("puppeteer-core");

const APP = process.env.APP || "http://127.0.0.1:3311";
const TITILER = process.env.TITILER || "http://127.0.0.1:8311";
const FILE = process.env.FILE;
const OUT = process.env.OUT || ".";
const RESCALE = process.env.RESCALE || "35.7,323.6";
const CHROME =
  process.env.CHROME ||
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const tileRequests = [];
page.on("request", (r) => {
  if (r.url().startsWith(TITILER) && r.url().includes("/tiles/")) tileRequests.push(r.url());
});
page.on("pageerror", (e) => console.error("pageerror", e.message));

await page.goto(APP, { waitUntil: "networkidle2" });
await page.waitForFunction(() => window.AppState && window.AppState.getMap() && window.AppState.getMap().loaded());
await page.evaluate((t) => window.D2S.setTiTilerBase(t), TITILER);

// Real UI path: Add layer -> Upload file -> choose file -> Add layer
await page.click("#add-layer-btn");
await page.click('.tab[data-tab="file"]');
const input = await page.$("#file-input");
await input.uploadFile(FILE);
await page.click("#add-confirm");
await page.waitForFunction(
  () => window.AppState.getLayers().some((l) => l.type === "d2s-raster" && !l.loading),
  { timeout: 120000 }
);

async function settle() {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const map = window.AppState.getMap();
        const done = () => setTimeout(resolve, 1500);
        if (map.areTilesLoaded()) done();
        else map.once("idle", done);
      })
  );
}
await settle();
const view = await page.evaluate(() => {
  const map = window.AppState.getMap();
  const layer = window.AppState.getLayers().find((l) => l.type === "d2s-raster");
  const src = map.getSource(layer.sourceId);
  return {
    zoom: map.getZoom(),
    center: map.getCenter(),
    vizOptions: layer.vizOptions,
    tileUrl: src.tiles[0],
    sourceBounds: src.bounds,
    sourceTileSize: src.tileSize,
    sourceScheme: src.scheme,
  };
});
await page.screenshot({ path: join(OUT, "browser_as_shipped.png") });
const asShippedTiles = tileRequests.splice(0);

await page.evaluate((rescale) => {
  const layer = window.AppState.getLayers().find((l) => l.type === "d2s-raster");
  layer.vizOptions.rescale = rescale;
  window.Layers.setLayerColormap(layer, null); // rebuilds the tile URL from vizOptions
}, RESCALE);
await settle();
await page.screenshot({ path: join(OUT, "browser_rescaled.png") });

writeFileSync(
  join(OUT, "browser_tiles.json"),
  JSON.stringify({ view, asShippedTiles, rescaledTiles: tileRequests }, null, 1)
);
console.log(JSON.stringify(view, null, 1));
console.log("tiles as shipped:", asShippedTiles.length, "rescaled:", tileRequests.length);
await browser.close();
