/* ----------------------------------------------------------------
   state.js — single source of truth for the viewer.

   The state lives on `window.AppState`. Components read from it
   and subscribe to events. Mutations go through helpers that emit.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const listeners = Object.create(null);

  function on(event, fn) {
    (listeners[event] ||= []).push(fn);
    return () => off(event, fn);
  }
  function off(event, fn) {
    const arr = listeners[event];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  function emit(event, payload) {
    (listeners[event] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error("listener for", event, "threw:", err);
      }
    });
  }

  // ---- Layer registry ----

  const layers = []; // ordered, top-most last
  function getLayers() {
    return layers.slice();
  }
  function getLayer(id) {
    return layers.find((l) => l.id === id) || null;
  }
  function addLayer(layer) {
    layers.push(layer);
    emit("layer:added", layer);
    emit("layers:changed");
  }
  function removeLayer(id) {
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const [removed] = layers.splice(i, 1);
    emit("layer:removed", removed);
    emit("layers:changed");
    return removed;
  }
  function updateLayer(id, patch) {
    const layer = getLayer(id);
    if (!layer) return null;
    Object.assign(layer, patch);
    emit("layer:updated", layer);
    emit("layers:changed");
    return layer;
  }

  // ---- Map handle ----

  let map = null;
  function setMap(m) {
    map = m;
  }
  function getMap() {
    return map;
  }

  // ---- Active time layer ----
  //
  // We currently drive the time slider from the first visible
  // time-aware layer. `activeTimeLayerId` can be overridden later
  // if we want a layer-picker in the time bar.

  let activeTimeLayerId = null;
  function setActiveTimeLayer(id) {
    if (activeTimeLayerId === id) return;
    activeTimeLayerId = id;
    emit("time:active-changed", id);
  }
  function getActiveTimeLayer() {
    if (!activeTimeLayerId) return null;
    return getLayer(activeTimeLayerId);
  }

  /**
   * Recompute which layer drives the time slider.
   * Called whenever layers change visibility or get added/removed.
   */
  function reconcileActiveTimeLayer() {
    const candidate = layers.find(
      (l) => l.visible && Array.isArray(l.times) && l.times.length > 1
    );
    setActiveTimeLayer(candidate ? candidate.id : null);
  }

  // ---- Toast / status ----

  function toast(message, kind) {
    emit("toast", { message, kind: kind || "info" });
  }

  // ---- ID generator ----

  let _seq = 0;
  function nextId(prefix) {
    _seq += 1;
    return `${prefix || "layer"}-${Date.now().toString(36)}-${_seq}`;
  }

  window.AppState = {
    on,
    off,
    emit,
    getLayers,
    getLayer,
    addLayer,
    removeLayer,
    updateLayer,
    setMap,
    getMap,
    setActiveTimeLayer,
    getActiveTimeLayer,
    reconcileActiveTimeLayer,
    toast,
    nextId,
  };
})();
