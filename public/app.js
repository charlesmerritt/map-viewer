/* ----------------------------------------------------------------
   app.js — bootstrap & UI wiring.

   - Initializes MapLibre GL JS map and base-layer switcher.
   - Loads built-in layer catalog from layers.json.
   - Wires sidebar, add-layer modal, and toasts.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;
  const Layers = window.Layers;

  // ---- Base layers ----

  const BASE_LAYERS = [
    {
      name: "Carto Dark",
      url: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    },
    {
      name: "OpenStreetMap",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
    },
    {
      name: "Esri World Imagery",
      url:
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
      maxZoom: 19,
    },
    {
      name: "OpenTopoMap",
      url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
      attribution:
        'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 17,
    },
    {
      name: "Carto Voyager",
      url: "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    },
  ];

  let currentBaseName = null;

  function initMap() {
    const map = new maplibregl.Map({
      container: "map",
      center: [-82.5, 37.5], // Roughly Eastern US, PERSEUS region (lng, lat)
      zoom: 5,
      style: {
        version: 8,
        sources: {},
        layers: [],
      },
    });
    map.addControl(new maplibregl.NavigationControl());
    State.setMap(map);
    
    // Wait for map to load before adding basemap
    map.on('load', () => {
      setBaseLayer(BASE_LAYERS[0].name);
    });
    
    return map;
  }

  function moveBasemapToBottom(map) {
    const layers = map.getStyle().layers;
    if (!layers || layers.length < 2) return;
    const firstNonBase = layers.find((l) => l.id !== "basemap");
    if (firstNonBase) {
      map.moveLayer("basemap", firstNonBase.id);
    }
  }

  function setBaseLayer(name) {
    const map = State.getMap();
    const def = BASE_LAYERS.find((b) => b.name === name) || BASE_LAYERS[0];
    
    // Remove old basemap source/layer if exists
    if (currentBaseName && map.getSource("basemap")) {
      if (map.getLayer("basemap")) map.removeLayer("basemap");
      map.removeSource("basemap");
    }
    
    currentBaseName = name;
    
    // Add new basemap as raster source
    map.addSource("basemap", {
      type: "raster",
      tiles: [def.url],
      tileSize: 256,
      attribution: def.attribution,
    });
    
    map.addLayer({
      id: "basemap",
      type: "raster",
      source: "basemap",
      minZoom: 0,
      maxZoom: def.maxZoom,
    });
    
    moveBasemapToBottom(map);
  }

  function renderBasemapSelect() {
    const sel = document.getElementById("basemap-select");
    sel.innerHTML = "";
    BASE_LAYERS.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.name;
      opt.textContent = b.name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", (e) => setBaseLayer(e.target.value));
  }

  // ---- Layer list rendering ----

  function renderLayerList() {
    const root = document.getElementById("layer-list");
    const empty = document.getElementById("layer-empty");
    root.innerHTML = "";

    const layers = State.getLayers().slice().reverse(); // top-most first
    empty.style.display = layers.length === 0 ? "block" : "none";

    layers.forEach((layer) => {
      const card = document.createElement("li");
      card.className = "layer-card";

      const row = document.createElement("div");
      row.className = "layer-row";

      const toggle = document.createElement("label");
      toggle.className = "layer-toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!layer.visible;
      cb.addEventListener("change", () =>
        Layers.setLayerVisible(layer, cb.checked)
      );
      toggle.appendChild(cb);
      row.appendChild(toggle);

      const name = document.createElement("div");
      name.className = "layer-name";
      name.title = layer.name;
      name.textContent = layer.name;
      row.appendChild(name);

      const meta = document.createElement("div");
      meta.className = "layer-meta";
      meta.textContent = (layer.type === "cog" || layer.type === "d2s-raster") ? "RASTER" : "VECTOR";
      row.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "layer-actions";
      const zoomBtn = mkIconBtn("⤢", "Zoom to layer", () => {
        const bounds = layer.__bounds;
        if (bounds && bounds.length === 4) {
          State.getMap().fitBounds(bounds, { padding: 40 });
        }
      });
      actions.appendChild(zoomBtn);

      const removeBtn = mkIconBtn("×", "Remove layer", () => {
        Layers.removeLayer(layer);
      });
      removeBtn.style.color = "#ef4444";
      actions.appendChild(removeBtn);
      row.appendChild(actions);

      card.appendChild(row);

      // Opacity row
      const opacityRow = document.createElement("div");
      opacityRow.className = "layer-opacity";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.05";
      slider.value = String(layer.opacity ?? 1);
      const val = document.createElement("span");
      val.className = "opacity-val";
      val.textContent = `${Math.round((layer.opacity ?? 1) * 100)}%`;
      slider.addEventListener("input", (e) => {
        const v = Number(e.target.value);
        val.textContent = `${Math.round(v * 100)}%`;
        Layers.setLayerOpacity(layer, v);
      });
      opacityRow.appendChild(slider);
      opacityRow.appendChild(val);
      card.appendChild(opacityRow);

      if (layer.loading) {
        const loading = document.createElement("div");
        loading.className = "layer-meta";
        loading.textContent = "Loading…";
        card.appendChild(loading);
      } else if (layer.error) {
        const err = document.createElement("div");
        err.className = "layer-error";
        err.textContent = layer.error;
        card.appendChild(err);
      } else if (layer.sourceDesc) {
        const src = document.createElement("div");
        src.className = "layer-meta";
        src.style.textTransform = "none";
        src.style.letterSpacing = "0";
        src.textContent = layer.sourceDesc;
        card.appendChild(src);
      }

      root.appendChild(card);
    });
  }

  function mkIconBtn(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  // ---- Built-in layers ----

  async function loadBuiltins() {
    const root = document.getElementById("builtin-list");
    root.innerHTML = "";
    let catalog;
    try {
      const res = await fetch("layers.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
    } catch (err) {
      console.warn("No layers.json catalog:", err);
      const hint = document.createElement("li");
      hint.className = "empty-hint";
      hint.textContent = "No built-in layers configured.";
      root.appendChild(hint);
      return;
    }
    (catalog.layers || []).forEach((cfg) => {
      const li = document.createElement("li");
      li.className = "builtin-item";

      const meta = document.createElement("div");
      meta.className = "meta";
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = cfg.name;
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent =
        cfg.description ||
        (cfg.times ? `${cfg.times.length} timesteps` : cfg.type || "");
      meta.appendChild(nm);
      meta.appendChild(desc);
      li.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "btn-ghost";
      btn.textContent = "Add";
      btn.addEventListener("click", () => addBuiltin(cfg, btn));
      li.appendChild(btn);

      root.appendChild(li);
    });
  }

  async function addBuiltin(cfg, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Adding…";
    }
    try {
      const normalized = {
        name: cfg.name,
        type: cfg.type,
        style: cfg.style || null,
      };
      if (cfg.times) {
        normalized.times = cfg.times;
      } else if (cfg.url) {
        normalized.source = { kind: "builtin", url: cfg.url };
      } else {
        throw new Error("Built-in layer needs either 'url' or 'times'");
      }
      await Layers.addLayerFromConfig(normalized);
      State.toast(`Added: ${cfg.name}`, "success");
    } catch (err) {
      State.toast(`Failed to add ${cfg.name}: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Add";
      }
    }
  }

  // ---- Add-layer modal ----

  function initAddModal() {
    const modal = document.getElementById("add-modal");
    const open = document.getElementById("add-layer-btn");
    const closes = modal.querySelectorAll("[data-close-modal]");

    open.addEventListener("click", () => {
      resetModal();
      modal.classList.remove("hidden");
    });
    closes.forEach((c) =>
      c.addEventListener("click", () => modal.classList.add("hidden"))
    );
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });

    // Tabs
    const tabs = modal.querySelectorAll(".tab");
    const panes = modal.querySelectorAll(".tab-pane");
    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        tabs.forEach((x) => {
          x.classList.remove("active");
          x.setAttribute("aria-selected", "false");
        });
        t.classList.add("active");
        t.setAttribute("aria-selected", "true");
        const which = t.dataset.tab;
        panes.forEach((p) => {
          p.classList.toggle("hidden", p.dataset.pane !== which);
        });
      });
    });

    document.getElementById("add-confirm").addEventListener("click", () =>
      onConfirmAdd(modal)
    );
  }

  function resetModal() {
    document.getElementById("url-name").value = "";
    document.getElementById("url-input").value = "";
    document.getElementById("url-type").value = "auto";
    document.getElementById("url-colormap").value = "";
    document.getElementById("url-min").value = "";
    document.getElementById("url-max").value = "";
    document.getElementById("titiler-name").value = "";
    document.getElementById("titiler-url").value = "";
    document.getElementById("titiler-colormap").value = "";
    document.getElementById("titiler-min").value = "";
    document.getElementById("titiler-max").value = "";
    document.getElementById("file-name").value = "";
    document.getElementById("file-input").value = "";
  }

  async function onConfirmAdd(modal) {
    const activeTab = modal.querySelector(".tab.active")?.dataset.tab || "url";

    try {
      if (activeTab === "url") {
        const url = document.getElementById("url-input").value.trim();
        if (!url) throw new Error("URL is required");
        const explicit = document.getElementById("url-type").value;
        const type = Layers.detectType(url, explicit);
        if (!type) {
          throw new Error(
            "Could not auto-detect type. Pick COG or GeoJSON manually."
          );
        }
        const name =
          document.getElementById("url-name").value.trim() ||
          guessName(url);
        const style = buildStyleFromForm();
        await Layers.addLayerFromConfig({
          name,
          type,
          source: { kind: "url", url },
          style,
        });
        State.toast(`Added: ${name}`, "success");
      } else if (activeTab === "titiler") {
        const cogUrl = document.getElementById("titiler-url").value.trim();
        if (!cogUrl) throw new Error("COG URL is required");
        const name =
          document.getElementById("titiler-name").value.trim() ||
          guessName(cogUrl);
        const style = buildTiTilerStyleFromForm();
        await addTiTilerLayer(name, cogUrl, style);
        State.toast(`Added: ${name}`, "success");
      } else {
        const fileInput = document.getElementById("file-input");
        const file = fileInput.files[0];
        if (!file) throw new Error("Choose a file first");
        const type = Layers.detectType(file.name, "auto");
        if (!type) throw new Error("Unsupported file type");
        const name =
          document.getElementById("file-name").value.trim() || file.name;
        await Layers.addLayerFromConfig({
          name,
          type,
          source: { kind: "file", file },
        });
        State.toast(`Added: ${name}`, "success");
      }
      modal.classList.add("hidden");
    } catch (err) {
      console.error(err);
      State.toast(err.message || String(err), "error");
    }
  }

  function buildStyleFromForm() {
    const colormap = document.getElementById("url-colormap").value || null;
    const minRaw = document.getElementById("url-min").value;
    const maxRaw = document.getElementById("url-max").value;
    if (!colormap && minRaw === "" && maxRaw === "") return null;
    return {
      colormap: colormap || "viridis",
      min: minRaw === "" ? null : Number(minRaw),
      max: maxRaw === "" ? null : Number(maxRaw),
    };
  }

  function buildTiTilerStyleFromForm() {
    const colormap = document.getElementById("titiler-colormap").value || null;
    const minRaw = document.getElementById("titiler-min").value;
    const maxRaw = document.getElementById("titiler-max").value;
    if (!colormap && minRaw === "" && maxRaw === "") return null;
    return {
      colormap_name: colormap || null,
      min: minRaw === "" ? null : Number(minRaw),
      max: maxRaw === "" ? null : Number(maxRaw),
    };
  }

  async function addTiTilerLayer(name, cogUrl, style) {
    // Fetch bounds and info from TiTiler in parallel
    const [boundsData, infoData] = await Promise.all([
      fetch(`${window.D2S.getTiTilerBase()}/cog/bounds?url=${encodeURIComponent(cogUrl)}`).then(r => {
        if (!r.ok) throw new Error(`TiTiler bounds request failed: ${r.status}`);
        return r.json();
      }),
      fetch(`${window.D2S.getTiTilerBase()}/cog/info?url=${encodeURIComponent(cogUrl)}`).then(r => {
        if (!r.ok) throw new Error(`TiTiler info request failed: ${r.status}`);
        return r.json();
      }),
    ]);

    const bounds = boundsData.bounds; // [minx, miny, maxx, maxy] in EPSG:4326

    // Build visualization options
    const vizOptions = {};
    const bandCount = infoData.count || 1;

    if (bandCount === 1) {
      vizOptions.bidx = "1";
      if (style && style.colormap_name) {
        vizOptions.colormap_name = style.colormap_name;
      }
      // Auto-rescale from band statistics if no explicit min/max
      const stats = infoData.band_metadata && infoData.band_metadata[0] && infoData.band_metadata[0][1];
      if (style && style.min != null && style.max != null) {
        vizOptions.rescale = `${style.min},${style.max}`;
      } else if (stats && stats.STATISTICS_MINIMUM != null && stats.STATISTICS_MAXIMUM != null) {
        vizOptions.rescale = `${stats.STATISTICS_MINIMUM},${stats.STATISTICS_MAXIMUM}`;
      }
    } else if (bandCount >= 3) {
      vizOptions.bidx = "1,2,3";
    }

    const tileUrl = `${window.D2S.getTiTilerBase()}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}` +
      (vizOptions.bidx ? `&bidx=${vizOptions.bidx}` : '') +
      (vizOptions.colormap_name ? `&colormap_name=${vizOptions.colormap_name}` : '') +
      (vizOptions.rescale ? `&rescale=${encodeURIComponent(vizOptions.rescale)}` : '');

    await Layers.addD2STileLayer({
      name,
      tileUrl,
      bounds,
      type: "raster",
      sourceDesc: "TiTiler: " + cogUrl.split("/").pop(),
    });
  }

  function guessName(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || u.hostname;
    } catch {
      return url.slice(0, 40);
    }
  }

  // ---- Sidebar collapse ----

  function initSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const collapseBtn = document.getElementById("toggle-sidebar");
    const openBtn = document.getElementById("open-sidebar");
    collapseBtn.addEventListener("click", () => {
      sidebar.classList.add("collapsed");
      openBtn.classList.remove("hidden");
      setTimeout(() => State.getMap().resize(), 220);
    });
    openBtn.addEventListener("click", () => {
      sidebar.classList.remove("collapsed");
      openBtn.classList.add("hidden");
      setTimeout(() => State.getMap().resize(), 220);
    });
  }

  // ---- Toast ----

  let toastTimer = null;
  function initToast() {
    State.on("toast", ({ message, kind }) => {
      const t = document.getElementById("toast");
      t.textContent = message;
      t.className = `toast ${kind || ""}`;
      t.classList.remove("hidden");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
    });
  }

  // ---- D2S Integration ----

  function initD2S() {
    const modal = document.getElementById("d2s-modal");
    const connectBtn = document.getElementById("d2s-connect-btn");
    const loginBtn = document.getElementById("d2s-login-btn");
    const disconnectBtn = document.getElementById("d2s-disconnect-btn");
    const closes = modal.querySelectorAll("[data-close-d2s-modal]");

    connectBtn.addEventListener("click", () => {
      modal.classList.remove("hidden");
    });

    closes.forEach((c) =>
      c.addEventListener("click", () => modal.classList.add("hidden"))
    );

    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });

    loginBtn.addEventListener("click", async () => {
      const url = document.getElementById("d2s-url").value.trim();
      const email = document.getElementById("d2s-email").value.trim();
      const password = document.getElementById("d2s-password").value;
      const apiKey = document.getElementById("d2s-api-key")?.value.trim();

      if (!url) {
        State.toast("Please enter D2S instance URL", "error");
        return;
      }

      // Allow either login credentials OR API key
      if (!apiKey && (!email || !password)) {
        State.toast("Please provide either API key or email/password", "error");
        return;
      }

      loginBtn.disabled = true;
      loginBtn.textContent = "Connecting...";

      try {
        const client = window.D2S.connect(url, apiKey);
        
        // If credentials provided, attempt login
        if (email && password) {
          await client.login(email, password);
          showD2SConnected(client.user.email);
        } else {
          // Using API key only
          showD2SConnected("API Key");
        }
        
        modal.classList.add("hidden");
        document.getElementById("d2s-password").value = "";
        
        await loadD2SProjects();
        
        State.toast("Connected to D2S", "success");
      } catch (err) {
        console.error("D2S login failed:", err);
        State.toast(err.message || "Failed to connect to D2S", "error");
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "Connect";
      }
    });

    disconnectBtn.addEventListener("click", () => {
      window.D2S.disconnect();
      showD2SDisconnected();
      State.toast("Disconnected from D2S", "success");
    });
  }

  function showD2SConnected(email) {
    document.getElementById("d2s-disconnected").classList.add("hidden");
    document.getElementById("d2s-connected").classList.remove("hidden");
    document.getElementById("d2s-user-email").textContent = email;
  }

  function showD2SDisconnected() {
    document.getElementById("d2s-disconnected").classList.remove("hidden");
    document.getElementById("d2s-connected").classList.add("hidden");
    document.getElementById("d2s-projects-list").innerHTML = "";
  }

  async function loadD2SProjects() {
    const list = document.getElementById("d2s-projects-list");
    list.innerHTML = "<li class='empty-hint'>Loading projects...</li>";

    try {
      const client = window.D2S.getClient();
      const projects = await client.fetchProjects();

      list.innerHTML = "";

      if (!projects || projects.length === 0) {
        list.innerHTML = "<li class='empty-hint'>No projects found</li>";
        return;
      }

      projects.forEach((project) => {
        const li = document.createElement("li");
        li.className = "builtin-item";

        const meta = document.createElement("div");
        meta.className = "meta";
        const nm = document.createElement("span");
        nm.className = "name";
        nm.textContent = project.title || project.name;
        meta.appendChild(nm);
        li.appendChild(meta);

        const btn = document.createElement("button");
        btn.className = "btn-ghost";
        btn.textContent = "Browse";
        btn.addEventListener("click", () => loadD2SFlights(project));
        li.appendChild(btn);

        list.appendChild(li);
      });
    } catch (err) {
      console.error("Failed to load D2S projects:", err);
      list.innerHTML = "<li class='empty-hint'>Failed to load projects</li>";
      State.toast("Failed to load D2S projects", "error");
    }
  }

  async function loadD2SFlights(project) {
    const list = document.getElementById("d2s-projects-list");
    list.innerHTML = "<li class='empty-hint'>Loading flights...</li>";

    try {
      const client = window.D2S.getClient();
      const flights = await client.fetchFlights(project.id);

      list.innerHTML = "";

      const backBtn = document.createElement("li");
      backBtn.innerHTML = '<button class="btn-ghost" style="width:100%">← Back to projects</button>';
      backBtn.querySelector("button").addEventListener("click", loadD2SProjects);
      list.appendChild(backBtn);

      if (!flights || flights.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty-hint";
        empty.textContent = "No flights found";
        list.appendChild(empty);
        return;
      }

      flights.forEach((flight) => {
        const li = document.createElement("li");
        li.className = "builtin-item";

        const meta = document.createElement("div");
        meta.className = "meta";
        const nm = document.createElement("span");
        nm.className = "name";
        nm.textContent = flight.name;
        meta.appendChild(nm);
        li.appendChild(meta);

        const btn = document.createElement("button");
        btn.className = "btn-ghost";
        btn.textContent = "Load Data";
        btn.addEventListener("click", () => loadD2SDataProducts(project, flight));
        li.appendChild(btn);

        list.appendChild(li);
      });
    } catch (err) {
      console.error("Failed to load D2S flights:", err);
      list.innerHTML = "<li class='empty-hint'>Failed to load flights</li>";
      State.toast("Failed to load D2S flights", "error");
    }
  }

  async function loadD2SDataProducts(project, flight) {
    try {
      const client = window.D2S.getClient();
      const products = await client.fetchDataProducts(project.id, flight.id);

      if (!products || products.length === 0) {
        State.toast("No data products found for this flight", "error");
        return;
      }

      let addedCount = 0;

      for (const product of products) {
        const name = `${flight.name} - ${product.name || product.filepath}`;

        if (client.isRasterType(product)) {
          // Use TiTiler for raster data products
          try {
            // Get metadata from public endpoint
            const info = await client.getDataProductInfo(product.id);

            // Build the S3 COG URL from the data product info
            const cogUrl = info.url || info.filepath || null;
            if (!cogUrl) {
              console.warn(`No URL found for raster product ${product.name}`);
              continue;
            }

            // Use TiTiler to get bounds and build tile URL
            const [boundsData, titilerInfo] = await Promise.all([
              client.fetchTiTilerBounds(cogUrl).catch(() => null),
              client.fetchTiTilerInfo(cogUrl).catch(() => null),
            ]);

            let bounds = null;
            if (boundsData && boundsData.bounds) {
              bounds = boundsData.bounds;
            } else if (info.geometry && info.geometry.coordinates) {
              const coords = info.geometry.coordinates[0];
              const lons = coords.map(c => c[0]);
              const lats = coords.map(c => c[1]);
              bounds = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
            }

            // Build visualization options from TiTiler info
            const vizOptions = {};
            const bandCount = titilerInfo ? (titilerInfo.count || 1) : 1;

            if (bandCount === 1) {
              vizOptions.bidx = "1";
              vizOptions.colormap_name = "viridis";
              // Auto-rescale from band statistics
              const stats = titilerInfo && titilerInfo.band_metadata && titilerInfo.band_metadata[0] && titilerInfo.band_metadata[0][1];
              if (stats && stats.STATISTICS_MINIMUM != null && stats.STATISTICS_MAXIMUM != null) {
                vizOptions.rescale = `${stats.STATISTICS_MINIMUM},${stats.STATISTICS_MAXIMUM}`;
              }
            } else if (bandCount >= 3) {
              vizOptions.bidx = "1,2,3";
            }

            const tileUrl = client.buildTiTilerTileUrl(cogUrl, vizOptions);

            await Layers.addD2STileLayer({
              name,
              tileUrl,
              bounds,
              type: "raster",
              sourceDesc: "D2S TiTiler",
            });
            addedCount++;
          } catch (err) {
            console.warn(`Failed to load raster product ${product.name}:`, err);
          }
        } else if (client.isVectorType(product)) {
          // For vector data, use direct download for now
          // TODO: Add pg_tileserv vector tile support
          try {
            const url = await client.getDataProductDownloadUrl(product.id);
            const type = Layers.detectType(product.filepath || product.name, "auto");

            if (type) {
              await Layers.addLayerFromConfig({
                name,
                type,
                source: { kind: "url", url },
              });
              addedCount++;
            }
          } catch (err) {
            console.warn(`Failed to load vector product ${product.name}:`, err);
          }
        }
      }

      if (addedCount > 0) {
        State.toast(`Added ${addedCount} layer(s) from ${flight.name}`, "success");
      } else {
        State.toast("No compatible data products found", "error");
      }
    } catch (err) {
      console.error("Failed to load D2S data products:", err);
      State.toast("Failed to load data products", "error");
    }
  }

  // ---- Bootstrap ----

  function boot() {
    initMap();
    renderBasemapSelect();
    initAddModal();
    initSidebarToggle();
    initToast();
    initD2S();

    State.on("layers:changed", renderLayerList);
    State.on("layer:updated", renderLayerList);
    renderLayerList();

    if (window.TimeSlider) window.TimeSlider.init();

    loadBuiltins();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
