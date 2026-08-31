# Product

## Register

product

## Users

Forest researchers, graduate students, and land managers working with PERSEUS
modeling outputs. Three contexts, all of which must work:

- **At a desk**, on a laptop or a large monitor, doing the real analysis: loading
  several COG rasters, grouping them, scrubbing a time series, drawing a polygon,
  reading zonal statistics.
- **In the field**, on a phone, one-handed, often in sunlight and sometimes with
  gloves: checking a raster against what is actually in front of them, tapping a
  county to summarize it, sharing a number with a colleague.
- **On a tablet**, touch-first, either orientation, sometimes with a keyboard
  attached: the desk workflow at touch scale.

The job to be done is always the same: *look at a modeled surface over a place I
care about, and get a defensible number out of it.*

## Product Purpose

A static-first web map viewer for PERSEUS outputs. It streams Cloud-Optimized
GeoTIFFs through TiTiler, overlays GeoJSON vectors and built-in US state/county
boundaries, plays time-series layers, and computes zonal statistics over drawn or
selected polygons.

Success is that a user gets an accurate statistic over the right polygon without
installing anything and without a training session, on whatever device is in
their hand.

## Brand Personality

**Precise, quiet, trustworthy.** A scientific instrument, not a product.

The interface reports numbers and gets out of the way. Chrome never competes with
the map. Nothing is decorated for its own sake, and nothing animates unless it is
communicating a state change. When something fails, it says exactly what failed.

## Anti-references

- **Consumer map apps** (Google Maps, Apple Maps). No giant floating pills, no
  photo-stuffed bottom sheets, no search-first framing, no playful motion. This is
  an analysis tool, not a wayfinder.
- **A dumbed-down mobile build.** No feature is hidden behind "open this on a
  desktop." Every capability, including drawing, grouping, upload, and zonal
  statistics, is reachable on a phone. Density adapts; the feature set does not.

## Design Principles

1. **The map is the document.** Chrome yields to it. On small screens, panels
   overlay rather than displace, and never cover the map completely while the user
   is acting on it.
2. **Parity across devices, density adapts.** Same information architecture
   everywhere. What changes is target size, layout direction, and how much is
   revealed at once, never which features exist.
3. **Report, do not reassure.** State the actual number, the actual unit, the
   actual error. No spinners standing in for progress that is known, no
   success language where a value belongs.
4. **Input method is a spectrum, not a breakpoint.** Touchscreen laptops and
   keyboard-attached tablets are normal. Detect pointer and hover, never infer
   input from viewport width.
5. **Every affordance has a keyboard path.** Drawing, resizing, grouping, and
   ordering are all pointer-native today; each needs an equivalent that does not
   require a pointer.

## Accessibility & Inclusion

Target: **WCAG 2.2 AA.**

- Text contrast ≥ 4.5:1 (≥ 3:1 for large text); UI component and state contrast
  ≥ 3:1. Placeholder and hint text held to the same 4.5:1 as body text.
- Minimum target size 24×24 CSS px (2.5.8), with 44×44 as the working floor for
  primary touch controls in the field.
- Visible, non-clipped focus indicators on every interactive element (2.4.11,
  2.4.13). No hover-only functionality (1.4.13).
- `prefers-reduced-motion` honored for every transition.
- Colormaps are user-selectable, and value is never encoded by color alone: the
  numeric ramp endpoints are always shown alongside the ramp.
- Content reflows to 320 CSS px wide without two-dimensional scrolling (1.4.10),
  and survives 200% zoom and 400% text scaling.
- Respects `env(safe-area-inset-*)` on notched devices and dynamic viewport units
  so mobile browser chrome never eats a control.
