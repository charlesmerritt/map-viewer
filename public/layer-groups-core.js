/* ----------------------------------------------------------------
   layer-groups-core.js — pure helpers for layer group ordering.
   ---------------------------------------------------------------- */

(function (root) {
  "use strict";

  function normalizeUniqueLayerIds(layerIds, existingIds) {
    const existing = new Set(existingIds || []);
    const seen = new Set();
    const result = [];
    (layerIds || []).forEach((id) => {
      if (!existing.has(id) || seen.has(id)) return;
      seen.add(id);
      result.push(id);
    });
    return result;
  }

  function orderLayerIds(group, allLayerIdsBottomToTop) {
    const stackIndex = new Map(
      (allLayerIdsBottomToTop || []).map((id, index) => [id, index])
    );
    const ids = normalizeUniqueLayerIds(group.layerIds, allLayerIdsBottomToTop);
    const topToBottom = ids
      .slice()
      .sort((a, b) => stackIndex.get(b) - stackIndex.get(a));

    if (group.orderMode === "bottom-to-top") {
      return topToBottom.slice().reverse();
    }
    if (group.orderMode === "custom") {
      return orderCustom(topToBottom, group.customOrder || {});
    }
    return topToBottom;
  }

  function orderCustom(topToBottomIds, customOrder) {
    const fallbackIndex = new Map(topToBottomIds.map((id, index) => [id, index]));
    return topToBottomIds.slice().sort((a, b) => {
      const aOrder = normalizeOrder(customOrder[a]);
      const bOrder = normalizeOrder(customOrder[b]);
      if (aOrder !== null && bOrder !== null && aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      if (aOrder !== null && bOrder === null) return -1;
      if (aOrder === null && bOrder !== null) return 1;
      return fallbackIndex.get(a) - fallbackIndex.get(b);
    });
  }

  function normalizeOrder(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10) return null;
    return n;
  }

  function numberKeyToOrder(key) {
    if (key === "0") return 10;
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return null;
    return n;
  }

  const api = {
    normalizeUniqueLayerIds,
    orderLayerIds,
    numberKeyToOrder,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.LayerGroupsCore = api;
})(typeof window !== "undefined" ? window : globalThis);
