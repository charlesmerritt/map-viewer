/* ----------------------------------------------------------------
   d2s-client.js — Data to Science API client.

   Handles authentication and data fetching from D2S instances.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  class D2SClient {
    constructor(baseUrl, apiKey) {
      this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
      this.token = null;
      this.user = null;
      this.apiKey = apiKey || null; // Optional API key for public access
    }

    async login(email, password) {
      const formData = new URLSearchParams();
      formData.append("username", email);
      formData.append("password", password);

      const res = await fetch(`${this.baseUrl}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
      });

      if (!res.ok) {
        const error = await res.text();
        throw new Error(`Login failed: ${res.status} ${error}`);
      }

      const data = await res.json();
      this.token = data.access_token;
      this.user = data.user;
      return data;
    }

    async logout() {
      this.token = null;
      this.user = null;
    }

    isAuthenticated() {
      return !!this.token;
    }

    getAuthHeaders() {
      if (this.token) {
        return {
          Authorization: `Bearer ${this.token}`,
        };
      } else if (this.apiKey) {
        return {
          "X-API-Key": this.apiKey,
        };
      }
      throw new Error("Not authenticated - need token or API key");
    }

    async fetchProjects() {
      const res = await fetch(`${this.baseUrl}/api/v1/projects`, {
        headers: this.getAuthHeaders(),
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch projects: ${res.status}`);
      }

      return await res.json();
    }

    async fetchFlights(projectId) {
      const res = await fetch(`${this.baseUrl}/api/v1/projects/${projectId}/flights`, {
        headers: this.getAuthHeaders(),
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch flights: ${res.status}`);
      }

      return await res.json();
    }

    async fetchDataProducts(projectId, flightId) {
      const res = await fetch(
        `${this.baseUrl}/api/v1/projects/${projectId}/flights/${flightId}/data_products`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (!res.ok) {
        throw new Error(`Failed to fetch data products: ${res.status}`);
      }

      return await res.json();
    }

    async getDataProductDownloadUrl(dataProductId) {
      // For public data products, get the URL from the metadata
      const info = await this.getDataProductInfo(dataProductId);
      return info.url || info.filepath;
    }

    async getDataProductTileUrl(dataProductId, options = {}) {
      // Public maptiles endpoint from codemap trace 3a
      // /api/v1/public/maptiles?z={z}&x={x}&y={y}&data_product_id={id}&scale=1&...
      const params = new URLSearchParams();
      params.append("data_product_id", dataProductId);
      params.append("scale", options.scale || "1");
      
      // Add visualization params if provided
      if (options.bidx) params.append("bidx", options.bidx);
      if (options.rescale) params.append("rescale", options.rescale);
      if (options.colormap_name) params.append("colormap_name", options.colormap_name);
      
      const baseParams = params.toString();
      return `${this.baseUrl}/api/v1/public/maptiles/{z}/{x}/{y}?${baseParams}`;
    }

    async getDataProductVectorTileUrl(projectId, flightId, dataProductId, tableName) {
      // pg_tileserv vector tile URL for vector data products
      const baseUrl = `${this.baseUrl}/api/projects/${projectId}/flights/${flightId}/data_products/${dataProductId}`;
      return `${baseUrl}/vector_tiles/${tableName}/{z}/{x}/{y}.pbf`;
    }

    async getDataProductInfo(dataProductId) {
      // Public data product endpoint from codemap trace 2a
      // GET /api/v1/public?file_id={id}
      const res = await fetch(
        `${this.baseUrl}/api/v1/public?file_id=${dataProductId}`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (!res.ok) {
        throw new Error(`Failed to fetch data product info: ${res.status}`);
      }

      return await res.json();
    }

    async fetchDataProductMetadata(projectId, flightId, dataProductId) {
      const res = await fetch(
        `${this.baseUrl}/api/projects/${projectId}/flights/${flightId}/data_products/${dataProductId}`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (!res.ok) {
        throw new Error(`Failed to fetch data product metadata: ${res.status}`);
      }

      return await res.json();
    }

    isRasterType(dataProduct) {
      const filepath = (dataProduct.filepath || dataProduct.name || "").toLowerCase();
      return filepath.endsWith(".tif") || filepath.endsWith(".tiff") || filepath.endsWith(".cog");
    }

    isVectorType(dataProduct) {
      const filepath = (dataProduct.filepath || dataProduct.name || "").toLowerCase();
      return filepath.endsWith(".geojson") || filepath.endsWith(".json") || filepath.endsWith(".shp");
    }

    // ---- TiTiler helpers ----

    async fetchTiTilerBounds(cogUrl) {
      const titilerBase = window.D2S.getTiTilerBase();
      const res = await fetch(
        `${titilerBase}/cog/bounds?url=${encodeURIComponent(cogUrl)}`
      );
      if (!res.ok) throw new Error(`TiTiler bounds failed: ${res.status}`);
      return await res.json(); // { bounds: [minx,miny,maxx,maxy], crs: "..." }
    }

    async fetchTiTilerInfo(cogUrl) {
      const titilerBase = window.D2S.getTiTilerBase();
      const res = await fetch(
        `${titilerBase}/cog/info?url=${encodeURIComponent(cogUrl)}`
      );
      if (!res.ok) throw new Error(`TiTiler info failed: ${res.status}`);
      return await res.json();
    }

    buildTiTilerTileUrl(cogUrl, options = {}) {
      return window.D2S.buildTiTilerTileUrl(cogUrl, options);
    }
  }

  // Singleton instance
  let client = null;

  // TiTiler base URL for map TILES (can work independently of D2S connection)
  let titilerBase = "https://tt.d2s.org";

  // Separate TiTiler base for ZONAL STATISTICS. tt.d2s.org serves tiles
  // fine (image GETs need no CORS) but sends no CORS headers, so the
  // browser's POST /cog/statistics is blocked there. This points at a
  // self-hosted TiTiler with CORS enabled for GET,POST. Overridable for
  // dev via ?statsBase= or localStorage("zonalStatsBase").
  let zonalStatsBase = "https://titiler-production-228c.up.railway.app";
  try {
    const override =
      new URLSearchParams(location.search).get("statsBase") ||
      localStorage.getItem("zonalStatsBase");
    if (override) zonalStatsBase = override;
  } catch (_) {}
  zonalStatsBase = zonalStatsBase.replace(/\/$/, "");

  window.D2S = {
    connect(baseUrl, apiKey) {
      client = new D2SClient(baseUrl, apiKey);
      return client;
    },

    getClient() {
      if (!client) {
        throw new Error("D2S client not connected. Call D2S.connect() first.");
      }
      return client;
    },

    isConnected() {
      return !!client;
    },

    disconnect() {
      if (client) {
        client.logout();
      }
      client = null;
    },

    getTiTilerBase() {
      return titilerBase;
    },

    setTiTilerBase(url) {
      titilerBase = url.replace(/\/$/, "");
    },

    getZonalStatsBase() {
      return zonalStatsBase;
    },

    setZonalStatsBase(url) {
      zonalStatsBase = url.replace(/\/$/, "");
    },

    buildTiTilerTileUrl(cogUrl, options = {}) {
      const params = new URLSearchParams();
      params.append("url", cogUrl);
      if (options.colormap_name) params.append("colormap_name", options.colormap_name);
      if (options.rescale) params.append("rescale", options.rescale);
      if (options.bidx) params.append("bidx", options.bidx);
      if (options.resampling) params.append("resampling", options.resampling);
      return `${titilerBase}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params.toString()}`;
    },
  };
})();
