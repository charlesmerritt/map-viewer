(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RasterUploads = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function isRasterFile(name) {
    return /\.tiff?$/i.test(name || "");
  }

  async function responseError(response) {
    try {
      const body = await response.json();
      if (body && body.error) return body.error;
    } catch (_) {
      /* use the HTTP status below */
    }
    return `Raster upload failed: HTTP ${response.status}`;
  }

  async function upload(file, fetchImpl = fetch) {
    const response = await fetchImpl(
      `/api/rasters?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "content-type": file.type || "image/tiff" },
        body: file,
      }
    );
    if (!response.ok) throw new Error(await responseError(response));
    return response.json();
  }

  async function remove(deleteUrl, fetchImpl = fetch) {
    if (!deleteUrl) return;
    const response = await fetchImpl(deleteUrl, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(await responseError(response));
    }
  }

  return { isRasterFile, upload, remove };
});
