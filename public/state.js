/* ----------------------------------------------------------------
   state.js — single source of truth for the viewer.

   The state lives on `window.AppState`. Components read from it
   and subscribe to events. Mutations go through helpers that emit.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const Core = window.LayerGroupsCore;

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
    removeLayerReferences(id);
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
  function reorderLayers(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length !== layers.length) return;
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const next = orderedIds.map((id) => byId.get(id));
    if (next.some((layer) => !layer)) return;
    layers.splice(0, layers.length, ...next);
    emit("layers:changed");
  }

  // ---- Layer selection ----

  const selectedLayerIds = new Set();

  function getSelectedLayerIds() {
    return Array.from(selectedLayerIds);
  }
  function setSelectedLayerIds(layerIds) {
    selectedLayerIds.clear();
    normalizeLayerIds(layerIds).forEach((id) => selectedLayerIds.add(id));
    emit("selection:changed", getSelectedLayerIds());
  }
  function clearSelectedLayers() {
    if (selectedLayerIds.size === 0) return;
    selectedLayerIds.clear();
    emit("selection:changed", []);
  }
  function toggleLayerSelected(id) {
    if (!getLayer(id)) return;
    if (selectedLayerIds.has(id)) selectedLayerIds.delete(id);
    else selectedLayerIds.add(id);
    emit("selection:changed", getSelectedLayerIds());
  }

  // ---- Layer groups ----

  const groups = [];

  function getLayerGroups() {
    return groups.slice();
  }
  function getLayerGroup(id) {
    return groups.find((group) => group.id === id) || null;
  }
  function getGroupForLayer(layerId) {
    return groups.find((group) => group.layerIds.includes(layerId)) || null;
  }
  function createLayerGroup(config) {
    const ids = normalizeLayerIds(config?.layerIds || []);
    if (ids.length < 2) return null;
    removeLayerIdsFromGroups(ids);
    const group = {
      id: nextId("group"),
      name: String(config?.name || `Group ${groups.length + 1}`).trim(),
      layerIds: ids,
      collapsed: false,
      timeWidget: config?.timeWidget !== false,
      orderMode: config?.orderMode || "top-to-bottom",
      customOrder: Object.create(null),
      timeIndex: 0,
    };
    groups.push(group);
    emit("group:added", group);
    emit("groups:changed");
    emit("layers:changed");
    return group;
  }
  function updateLayerGroup(id, patch) {
    const group = getLayerGroup(id);
    if (!group) return null;
    if (Object.hasOwn(patch, "name")) group.name = String(patch.name).trim() || group.name;
    if (Object.hasOwn(patch, "collapsed")) group.collapsed = !!patch.collapsed;
    if (Object.hasOwn(patch, "timeWidget")) group.timeWidget = !!patch.timeWidget;
    if (Object.hasOwn(patch, "orderMode")) group.orderMode = normalizeOrderMode(patch.orderMode);
    if (Object.hasOwn(patch, "customOrder")) group.customOrder = { ...patch.customOrder };
    if (Object.hasOwn(patch, "timeIndex")) group.timeIndex = clampGroupTimeIndex(group, patch.timeIndex);
    trimGroupOrder(group);
    if (!group.timeWidget && activeTimeGroupId === group.id) activeTimeGroupId = null;
    emit("group:updated", group);
    emit("groups:changed");
    emit("layers:changed");
    emit("time:active-changed", getActiveTimeSource());
    return group;
  }
  function removeLayerGroup(id) {
    const i = groups.findIndex((group) => group.id === id);
    if (i < 0) return null;
    const [removed] = groups.splice(i, 1);
    if (activeTimeGroupId === id) activeTimeGroupId = null;
    emit("group:removed", removed);
    emit("groups:changed");
    emit("layers:changed");
    emit("time:active-changed", getActiveTimeSource());
    return removed;
  }
  function ungroupLayerIds(layerIds) {
    const changed = removeLayerIdsFromGroups(normalizeLayerIds(layerIds));
    if (!changed) return false;
    emit("groups:changed");
    emit("layers:changed");
    emit("time:active-changed", getActiveTimeSource());
    return true;
  }
  function assignLayerGroupOrder(groupId, layerIds, firstOrder) {
    const group = getLayerGroup(groupId);
    if (!group) return null;
    const ids = normalizeLayerIds(layerIds).filter((id) => group.layerIds.includes(id));
    const start = Number(firstOrder);
    if (!Number.isInteger(start) || ids.length === 0 || start < 1 || start + ids.length - 1 > 10) return null;
    const customOrder = { ...(group.customOrder || {}) };
    ids.forEach((layerId, index) => {
      const order = start + index;
      Object.keys(customOrder).forEach((id) => {
        if (customOrder[id] === order) delete customOrder[id];
      });
      customOrder[layerId] = order;
    });
    return updateLayerGroup(groupId, { customOrder, orderMode: "custom" });
  }
  function getGroupTimeSteps(groupId) {
    const group = getLayerGroup(groupId);
    if (!group) return [];
    const orderedIds = Core.orderLayerIds(group, layers.map((layer) => layer.id));
    return orderedIds.map((id) => getLayer(id)).filter(Boolean).map((layer) => ({ layer }));
  }
  function normalizeLayerIds(layerIds) {
    const existingIds = layers.map((layer) => layer.id);
    return Core.normalizeUniqueLayerIds(layerIds || [], existingIds);
  }
  function normalizeOrderMode(mode) {
    return ["top-to-bottom", "bottom-to-top", "custom"].includes(mode)
      ? mode
      : "top-to-bottom";
  }
  function trimGroupOrder(group) {
    const memberIds = new Set(group.layerIds);
    Object.keys(group.customOrder || {}).forEach((id) => {
      if (!memberIds.has(id)) delete group.customOrder[id];
    });
  }
  function clampGroupTimeIndex(group, value) {
    const max = Math.max(0, getGroupTimeSteps(group.id).length - 1);
    const index = Number(value);
    if (!Number.isFinite(index)) return 0;
    return Math.max(0, Math.min(max, Math.round(index)));
  }
  function removeLayerIdsFromGroups(layerIds) {
    if (!layerIds.length) return false;
    const ids = new Set(layerIds);
    let changed = false;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      const nextIds = group.layerIds.filter((id) => !ids.has(id));
      if (nextIds.length === group.layerIds.length) continue;
      changed = true;
      if (nextIds.length < 2) {
        const [removed] = groups.splice(i, 1);
        if (activeTimeGroupId === removed.id) activeTimeGroupId = null;
        emit("group:removed", removed);
        continue;
      }
      group.layerIds = nextIds;
      group.timeIndex = clampGroupTimeIndex(group, group.timeIndex);
      trimGroupOrder(group);
      emit("group:updated", group);
    }
    return changed;
  }
  function removeLayerReferences(layerId) {
    selectedLayerIds.delete(layerId);
    removeLayerIdsFromGroups([layerId]);
    if (activeTimeLayerId === layerId) activeTimeLayerId = null;
  }

  // ---- Map handle ----

  let map = null;
  function setMap(m) {
    map = m;
  }
  function getMap() {
    return map;
  }

  // ---- Active time source ----
  //
  // The bottom time bar can be driven by either a native time-series
  // layer or a layer group with the time-widget enabled.

  let activeTimeLayerId = null;
  let activeTimeGroupId = null;

  function setActiveTimeLayer(id) {
    if (activeTimeLayerId === id && !activeTimeGroupId) return;
    activeTimeLayerId = id;
    if (id) activeTimeGroupId = null;
    emit("time:active-changed", getActiveTimeSource());
  }
  function getActiveTimeLayer() {
    if (!activeTimeLayerId) return null;
    return getLayer(activeTimeLayerId);
  }
  function setActiveTimeGroup(id) {
    if (activeTimeGroupId === id) return;
    activeTimeGroupId = id;
    if (id) activeTimeLayerId = null;
    emit("time:active-changed", getActiveTimeSource());
  }
  function getActiveTimeGroup() {
    if (!activeTimeGroupId) return null;
    return getLayerGroup(activeTimeGroupId);
  }
  function getActiveTimeSource() {
    const group = getActiveTimeGroup();
    const steps = group ? getGroupTimeSteps(group.id) : [];
    if (group && group.timeWidget && steps.length > 1) {
      const index = clampGroupTimeIndex(group, group.timeIndex || 0);
      return {
        kind: "group",
        id: group.id,
        name: group.name,
        index,
        times: steps.map(({ layer }) => ({ label: layer.name, layerId: layer.id })),
        loading: steps.some(({ layer }) => layer.loading),
      };
    }

    const layer = getActiveTimeLayer();
    if (layer && Array.isArray(layer.times) && layer.times.length > 1) {
      return {
        kind: "layer",
        id: layer.id,
        name: layer.name,
        index: layer.timeIndex ?? 0,
        times: layer.times,
        loading: !!layer.timeLoading,
        layer,
      };
    }

    return null;
  }

  /**
   * Recompute which layer or group drives the time slider.
   * Called whenever layers change visibility or get added/removed.
   */
  function reconcileActiveTimeLayer() {
    const group = getActiveTimeGroup();
    if (group && group.timeWidget && getGroupTimeSteps(group.id).length > 1) {
      emit("time:active-changed", getActiveTimeSource());
      return;
    }
    if (activeTimeGroupId) activeTimeGroupId = null;

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
    reorderLayers,
    getSelectedLayerIds,
    setSelectedLayerIds,
    clearSelectedLayers,
    toggleLayerSelected,
    getLayerGroups,
    getLayerGroup,
    getGroupForLayer,
    createLayerGroup,
    updateLayerGroup,
    removeLayerGroup,
    ungroupLayerIds,
    assignLayerGroupOrder,
    getGroupTimeSteps,
    setMap,
    getMap,
    setActiveTimeLayer,
    getActiveTimeLayer,
    setActiveTimeGroup,
    getActiveTimeGroup,
    getActiveTimeSource,
    reconcileActiveTimeLayer,
    toast,
    nextId,
  };
})();
