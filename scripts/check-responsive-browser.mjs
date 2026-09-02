#!/usr/bin/env node
/* Browser checks for responsive layout and WCAG 2.2 AA basics.

   NOT part of `pnpm test`: it needs a real browser, which this project
   deliberately does not depend on. Run it by hand after touching
   public/styles.css, the sheet code in public/app.js, or any layout markup.

     node server.mjs &
     pnpm dlx --package=puppeteer-core --package=@puppeteer/browsers -- \
       node scripts/check-responsive-browser.mjs

   Or, if you already have Chrome and puppeteer-core available:
     CHROME=/path/to/chrome node scripts/check-responsive-browser.mjs

   What it asserts, per viewport:
     - the page never scrolls horizontally
     - nothing overflows the viewport unless it lives in its own x-scroller
     - every interactive target is at least 24x24 CSS px, measuring the
       wrapping <label> for checkboxes and radios
     - nothing sits outside the viewport unless a scroll container reaches it
     - no uncaught page errors
   And globally:
     - all rendered text meets its AA contrast ratio against its real
       composited background
     - no horizontal scroll at 320px with a 4x root font, or at 200% zoom
     - bottom-anchored map chrome (draw bar, time bar, attribution, sheet)
       never overlaps

   See notes/responsive-and-accessibility.md for what each check protects. */

import puppeteer from "puppeteer-core";

const URL = process.env.URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME ||
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome`;

const VIEWPORTS = [
  { name: "320x653 small phone", w: 320, h: 653, touch: true },
  { name: "390x844 phone", w: 390, h: 844, touch: true },
  { name: "736x414 phone landscape", w: 736, h: 414, touch: true },
  { name: "768x1024 tablet portrait", w: 768, h: 1024, touch: true },
  { name: "1024x768 tablet landscape", w: 1024, h: 768, touch: true },
  { name: "1280x600 split window", w: 1280, h: 600, touch: false },
  { name: "1440x900 laptop", w: 1440, h: 900, touch: false },
  { name: "2560x1080 ultrawide", w: 2560, h: 1080, touch: false },
];

const failures = [];
const pass = (m) => console.log("  ok   ", m);
const fail = (m) => {
  console.log("  FAIL ", m);
  failures.push(m);
};

// Four raster layers and a group: the densest the sidebar realistically gets.
const SEED = () => {
  const S = window.AppState;
  const names = [
    "Aboveground biomass 2030 (Mg/ha)",
    "Canopy cover",
    "Fire risk index — southeastern CONUS",
    "Study region",
  ];
  names.forEach((name, i) =>
    S.addLayer({
      id: "L" + i,
      name,
      kind: i === 3 ? "geojson" : "raster",
      type: i === 3 ? "geojson" : "cog",
      visible: true,
      opacity: 0.8,
      colormap: ["viridis", "Greens", "RdYlGn", null][i],
      times: i === 0 ? ["2020", "2025", "2030"] : undefined,
    })
  );
  S.createLayerGroup?.({
    name: "Biomass time series",
    layerIds: ["L0", "L1"],
    timeWidget: true,
  });
};

const LAYOUT = () =>
  window.eval(`(() => {
  const de = document.documentElement;
  const out = { scrollsX: de.scrollWidth > de.clientWidth + 1, overflow: [], small: [], offscreen: [] };
  const inScroller = (el, axis) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const over = axis === 'x' ? cs.overflowX : cs.overflowY;
      const bigger = axis === 'x' ? p.scrollWidth > p.clientWidth + 1 : p.scrollHeight > p.clientHeight + 1;
      if (/(auto|scroll)/.test(over) && bigger) return true;
    }
    return false;
  };
  const label = el => (el.id ? '#' + el.id : '') + '.' + (String(el.className).trim().split(/\\s+/)[0] || el.tagName);
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null) continue;
    if (el.closest('.hidden')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.right > de.clientWidth + 1 && !inScroller(el, 'x')) out.overflow.push(label(el) + ' right=' + Math.round(r.right));
    if (!el.matches('button,a[href],input,select,summary,[tabindex]:not([tabindex="-1"])')) continue;
    // Third-party attribution links are inline in a sentence: WCAG 2.5.8 exempts those.
    if (el.closest('.maplibregl-ctrl-attrib')) continue;
    // For a checkbox or radio in a <label>, the label is the target.
    const target = (el.matches('input[type=checkbox],input[type=radio]') && el.closest('label')) || el;
    const tr = target.getBoundingClientRect();
    if (tr.width < 23.5 || tr.height < 23.5) out.small.push(label(el) + ' ' + tr.width.toFixed(0) + 'x' + tr.height.toFixed(0));
    if ((r.bottom > innerHeight + 1 || r.top < -1) && !inScroller(el, 'y')) out.offscreen.push(label(el));
  }
  return out;
})()`);

const CONTRAST = () =>
  window.eval(`(() => {
  const parse = c => { const m = c.match(/[\\d.]+/g); return m ? m.slice(0,3).map(Number).concat(m[3] !== undefined ? +m[3] : 1) : null; };
  const lin = v => { v /= 255; return v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055) ** 2.4; };
  const L = ([r,g,b]) => 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  const over = (fg,bg) => { const a = fg[3]; return [0,1,2].map(i => fg[i]*a + bg[i]*(1-a)); };
  const bgOf = el => {
    let node = el, acc = null;
    while (node && node.nodeType === 1) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0) { acc = acc ? over(acc.concat(acc[3] ?? 1), c) : c; if ((c[3] ?? 1) >= 1) return acc.slice(0,3); }
      node = node.parentElement;
    }
    return acc ? acc.slice(0,3) : [255,255,255];
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length && ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!(el.textContent || '').trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null) continue;
    if (el.closest('.hidden') || el.closest('.maplibregl-ctrl') || el.closest('.maplibregl-canvas-container')) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const fgc = fg[3] < 1 ? over(fg, bg) : fg.slice(0,3);
    const l1 = L(fgc), l2 = L(bg);
    const ratio = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
    const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
    if (ratio < need - 0.01) out.push((el.id ? '#'+el.id : el.tagName) + ' "' + el.textContent.trim().slice(0,24) + '" ' + ratio.toFixed(2) + ':1 needs ' + need);
  }
  return out;
})()`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
  ],
});

const load = async (w, h, touch, opts = {}) => {
  const page = await browser.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  if (opts.reducedMotion) {
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
  }
  await page.setViewport({
    width: w,
    height: h,
    isMobile: touch,
    hasTouch: touch,
    deviceScaleFactor: opts.dpr || 1,
  });
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 900));
  return page;
};

console.log("\nLayout, empty and with four layers plus a group:");
for (const vp of VIEWPORTS) {
  const page = await load(vp.w, vp.h, vp.touch);
  for (const [phase, seed] of [["empty", false], ["populated", true]]) {
    if (seed) {
      await page.evaluate(SEED);
      await new Promise((r) => setTimeout(r, 500));
      if (vp.touch) await page.evaluate(() => window.SheetUI.setSnap("full"));
      await new Promise((r) => setTimeout(r, 400));
    }
    const a = await page.evaluate(LAYOUT);
    const issues = [];
    if (a.scrollsX) issues.push("page scrolls horizontally");
    if (a.overflow.length) issues.push("overflows: " + a.overflow.slice(0, 4).join(", "));
    if (a.small.length) issues.push("targets under 24px: " + a.small.slice(0, 4).join(", "));
    if (a.offscreen.length) issues.push("unreachable: " + a.offscreen.slice(0, 4).join(", "));
    issues.length
      ? fail(`${vp.name} (${phase}): ${issues.join(" ; ")}`)
      : pass(`${vp.name} (${phase})`);
  }
  if (page.__errors.length) fail(`${vp.name}: ${page.__errors.slice(0, 2).join(" | ")}`);
  await page.close();
}

console.log("\nText contrast against composited backgrounds:");
{
  const page = await load(1440, 900, false);
  let hits = await page.evaluate(CONTRAST);
  hits.length ? fail("base view: " + hits.join("; ")) : pass("base view");
  await page.click("#add-layer-btn");
  await new Promise((r) => setTimeout(r, 300));
  for (const tab of ["titiler", "builtin", "file"]) {
    await page.evaluate(
      (t) => document.querySelector(`.tab[data-tab="${t}"]`).click(),
      tab
    );
    await new Promise((r) => setTimeout(r, 250));
    hits = await page.evaluate(CONTRAST);
    hits.length ? fail(`add-layer / ${tab}: ` + hits.join("; ")) : pass(`add-layer / ${tab}`);
  }
  await page.close();
}

console.log("\nReflow, zoom and motion:");
{
  const page = await load(1280, 1024, false);
  await page.evaluate(() => (document.documentElement.style.fontSize = "56px"));
  await page.setViewport({ width: 320, height: 1024, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 600));
  const r = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  r.sw <= r.cw + 1
    ? pass("no horizontal scroll at 320px with a 4x root font (1.4.4 / 1.4.10)")
    : fail(`horizontal scroll at 320px with a 4x root font: ${r.sw} > ${r.cw}`);
  await page.close();

  const zoomed = await load(640, 400, false, { dpr: 2 });
  const z = await zoomed.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  z.sw <= z.cw + 1
    ? pass("no horizontal scroll at 200% zoom")
    : fail(`horizontal scroll at 200% zoom: ${z.sw} > ${z.cw}`);
  await zoomed.close();

  const reduced = await load(390, 844, true, { reducedMotion: true });
  const d = await reduced.evaluate(
    () => getComputedStyle(document.getElementById("sidebar")).transitionDuration
  );
  parseFloat(d) < 0.02
    ? pass(`sheet transition collapses to ${d} under prefers-reduced-motion`)
    : fail(`sheet still animates for ${d} under prefers-reduced-motion`);
  await reduced.close();
}

console.log("\nBottom-anchored map chrome, drawing with a time series loaded:");
for (const vp of VIEWPORTS) {
  const page = await load(vp.w, vp.h, vp.touch);
  await page.evaluate(() =>
    window.AppState.addLayer({
      id: "T1",
      name: "Biomass 2020-2030",
      kind: "raster",
      type: "cog",
      visible: true,
      opacity: 0.8,
      times: ["2020", "2025", "2030"],
      timeIndex: 0,
    })
  );
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() =>
    document.getElementById("time-bar").classList.remove("hidden")
  );
  await page.evaluate(() =>
    document.querySelector(".draw-ctrl .draw-ctrl-btn").click()
  );
  await new Promise((r) => setTimeout(r, 400));
  const g = await page.evaluate(() => {
    const R = (s) => {
      const e = document.querySelector(s);
      if (!e || e.classList.contains("hidden")) return null;
      const r = e.getBoundingClientRect();
      return { t: r.top, b: r.bottom, l: r.left, r: r.right };
    };
    return {
      draw: R("#draw-actions"),
      time: R("#time-bar"),
      sheet: R("#sidebar"),
      attrib: R(".maplibregl-ctrl-attrib"),
      vh: innerHeight,
    };
  });
  const hits = (a, c) =>
    a && c && a.b > c.t + 1 && a.t < c.b - 1 && a.r > c.l + 1 && a.l < c.r - 1;
  const names = ["draw", "time", "sheet", "attrib"];
  const probs = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      if (hits(g[names[i]], g[names[j]]))
        probs.push(`${names[i]} overlaps ${names[j]}`);
  for (const n of names)
    if (n !== "sheet" && g[n] && (g[n].b > g.vh + 1 || g[n].t < -1))
      probs.push(`${n} is outside the viewport`);
  probs.length ? fail(`${vp.name}: ${probs.join("; ")}`) : pass(vp.name);
  await page.close();
}

await browser.close();
console.log(
  failures.length
    ? `\n${failures.length} failing check(s).`
    : "\nAll browser checks pass."
);
process.exit(failures.length ? 1 : 0);
