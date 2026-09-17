#!/usr/bin/env node
/* Exercise the circle/rectangle/polygon draw-tool state machine end to end
   (button click -> mousedown/mousemove/mouseup/keydown -> finished shape),
   against a minimal fake map + DOM, without a real browser or MapLibre. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---- Fake DOM ----

function makeElement() {
  const listeners = {};
  const el = {
    className: "",
    type: "",
    title: "",
    innerHTML: "",
    children: [],
    style: {},
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      toggle(c, v) {
        const on = v === undefined ? !this._set.has(c) : v;
        if (on) this._set.add(c);
        else this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    setAttribute() {},
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    fire(type, evt) {
      (listeners[type] || []).forEach((fn) => fn(evt));
    },
  };
  return el;
}

function findByTitleSubstring(el, substr) {
  if (el.title && el.title.includes(substr)) return el;
  for (const child of el.children) {
    const found = findByTitleSubstring(child, substr);
    if (found) return found;
  }
  return null;
}

const docListeners = {};
globalThis.document = {
  getElementById: () => undefined,
  createElement: () => makeElement(),
  addEventListener(type, fn) {
    (docListeners[type] ||= []).push(fn);
  },
  removeEventListener() {},
};
function fireKeydown(evt) {
  (docListeners.keydown || []).forEach((fn) => fn({ preventDefault() {}, ...evt }));
}

// ---- Fake MapLibre map ----

function fakeSource() {
  const calls = [];
  return {
    calls,
    setData(data) {
      calls.push(data);
    },
    get last() {
      return calls[calls.length - 1];
    },
  };
}

function makeMap() {
  const sources = new Map();
  const layers = new Set();
  const handlers = {}; // event -> fn[], or "event:layer" -> fn[]
  let controlContainer = null;

  const map = {
    addControl(control) {
      controlContainer = control.onAdd(map);
    },
    getControlContainer() {
      return controlContainer;
    },
    addSource(id, def) {
      sources.set(id, fakeSource());
      sources.get(id).def = def;
    },
    getSource(id) {
      return sources.get(id);
    },
    addLayer(def) {
      layers.add(def.id);
    },
    getLayer(id) {
      return layers.has(id) ? { id } : undefined;
    },
    moveLayer() {},
    setFilter() {},
    setLayoutProperty() {},
    setPaintProperty() {},
    on(event, a, b) {
      const key = typeof a === "string" ? `${event}:${a}` : event;
      const fn = typeof a === "string" ? b : a;
      (handlers[key] ||= []).push(fn);
    },
    fire(event, evt) {
      (handlers[event] || []).forEach((fn) => fn(evt));
    },
    doubleClickZoom: { disable() {}, enable() {} },
    dragPan: { disable() {}, enable() {} },
    boxZoom: { disable() {}, enable() {} },
    getCanvas: () => ({ style: {} }),
    project: (p) => ({ x: p[0] * 100, y: p[1] * 100 }),
    unproject: (p) => ({ lng: p[0] / 100, lat: p[1] / 100 }),
  };
  return map;
}

// ---- Fake AppState ----

const toasts = [];
const emitted = [];
let map = makeMap();
globalThis.window = {
  AppState: {
    getMap: () => map,
    toast: (message, kind) => toasts.push({ message, kind }),
    emit: (event, payload) => emitted.push({ event, payload }),
  },
};
const Geometry = require("../public/draw-geometry.js");
require("../public/draw-tools.js");
const DrawTools = globalThis.window.DrawTools;

DrawTools.init();

function click(el) {
  el.fire("click", {});
}
function mouse(event, lngLat, point) {
  map.fire(event, { lngLat: { lng: lngLat[0], lat: lngLat[1] }, point, originalEvent: {} });
}
function mouseShift(event, lngLat, point, shiftKey) {
  map.fire(event, { lngLat: { lng: lngLat[0], lat: lngLat[1] }, point, originalEvent: { shiftKey } });
}

const container = map.getControlContainer();
const circleBtn = findByTitleSubstring(container, "Draw circle");
const rectBtn = findByTitleSubstring(container, "Draw rectangle");
const polygonBtn = findByTitleSubstring(container, "Draw polygon");
assert.ok(circleBtn && rectBtn && polygonBtn, "toolbar exposes all three draw buttons");

// ---- Circle: click-and-drag ----

assert.equal(DrawTools.isActive(), false);
click(circleBtn);
assert.equal(DrawTools.isActive(), true, "circle tool becomes active");

const center = [-83.5, 33.9];
mouse("mousedown", center, { x: 100, y: 100 });
mouse("mouseup", center, { x: 100, y: 100 }); // no movement: stays armed, does not finish
assert.equal(DrawTools.isActive(), true, "a plain click on the center does not finish the circle");

const edge = [-83.4, 33.9];
mouse("mousemove", edge, { x: 140, y: 100 });
mouse("mousedown", edge, { x: 140, y: 100 });
mouse("mouseup", edge, { x: 140, y: 100 }); // second click, far from the anchor click: finishes
assert.equal(DrawTools.isActive(), false, "dragging to a second point finishes the circle");

const drawnSource = map.getSource("drawn-polygons-source");
assert.equal(drawnSource.last.features.length, 1, "one shape drawn so far");
let feature = drawnSource.last.features[0];
assert.equal(feature.properties.shape, "circle");
assert.equal(feature.geometry.type, "Polygon");
const expectedRadius = Geometry.haversineMiles(center, edge);
feature.geometry.coordinates[0].forEach((point) => {
  assert.ok(
    Math.abs(Geometry.haversineMiles(center, point) - expectedRadius) < expectedRadius * 0.02 + 0.05,
    "every ring point holds the dragged radius"
  );
});
assert.equal(emitted[emitted.length - 1].event, "boundary:selected");
assert.equal(emitted[emitted.length - 1].payload.kind, "drawn");
assert.equal(emitted[emitted.length - 1].payload.name, "Drawn circle 1");

// ---- Circle: typed radius overrides the drag ----

click(circleBtn);
mouse("mousedown", [-90, 40], { x: 0, y: 0 });
mouse("mouseup", [-90, 40], { x: 0, y: 0 }); // arm it
mouse("mousemove", [-89, 40], { x: 50, y: 0 }); // some drag radius that should be overridden
fireKeydown({ key: "2" });
fireKeydown({ key: "5" });
fireKeydown({ key: "Enter" });
assert.equal(DrawTools.isActive(), false, "Enter finishes the circle after typing a radius");
feature = drawnSource.last.features[drawnSource.last.features.length - 1];
assert.equal(feature.properties.shape, "circle");
assert.equal(feature.properties.radiusMiles, 25, "the typed radius wins over the dragged one");

// ---- Rectangle: shift constrains to a square ----

click(rectBtn);
mouse("mousedown", [-100, 40], { x: 0, y: 0 });
mouse("mouseup", [-100, 40], { x: 0, y: 0 }); // arm it
mouseShift("mousemove", [-98, 42], { x: 200, y: 200 }, true);
mouseShift("mousedown", [-98, 42], { x: 200, y: 200 }, true);
mouseShift("mouseup", [-98, 42], { x: 200, y: 200 }, true);
assert.equal(DrawTools.isActive(), false, "dragging finishes the rectangle");
feature = drawnSource.last.features[drawnSource.last.features.length - 1];
assert.equal(feature.properties.shape, "rectangle");
const ring = feature.geometry.coordinates[0];
const width = ring[1][0] - ring[0][0];
const height = ring[2][1] - ring[1][1];
assert.ok(Math.abs(width - height) < 1e-9, "Shift constrains the rectangle to a square");

// ---- Escape cancels mid-draw without adding a shape ----

const countBefore = drawnSource.last.features.length;
click(polygonBtn);
map.fire("click", { lngLat: { lng: -85, lat: 35 }, point: { x: 0, y: 0 } });
fireKeydown({ key: "Escape" });
assert.equal(DrawTools.isActive(), false, "Escape cancels the polygon tool");
assert.equal(drawnSource.last.features.length, countBefore, "cancelling adds no shape");

console.log("Draw tool interactions are valid.");
