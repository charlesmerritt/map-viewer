/* ----------------------------------------------------------------
   timeslider.js — drives the time bar at the bottom of the map.

   The slider listens to the AppState's active time layer. It only
   appears when there's a visible layer with `times` of length >= 2.
   ---------------------------------------------------------------- */

(function () {
  "use strict";

  const State = window.AppState;
  const Layers = window.Layers;

  const el = {
    bar: null,
    play: null,
    slider: null,
    min: null,
    max: null,
    cur: null,
    speed: null,
    loop: null,
    source: null,
  };

  let playing = false;
  let intervalId = null;
  let advancingProgrammatically = false;

  function init() {
    el.bar = document.getElementById("time-bar");
    el.play = document.getElementById("time-play");
    el.slider = document.getElementById("time-slider");
    el.min = document.getElementById("time-min");
    el.max = document.getElementById("time-max");
    el.cur = document.getElementById("time-current");
    el.speed = document.getElementById("time-speed");
    el.loop = document.getElementById("time-loop");
    el.source = document.getElementById("time-source");

    el.play.addEventListener("click", togglePlay);
    el.slider.addEventListener("input", onSliderInput);
    el.speed.addEventListener("change", () => {
      if (playing) {
        pause();
        play();
      }
    });

    State.on("time:active-changed", refresh);
    State.on("layer:updated", refresh);
    State.on("layers:changed", refresh);

    refresh();
  }

  function refresh() {
    const layer = State.getActiveTimeLayer();
    if (!layer || !layer.times || layer.times.length < 2) {
      el.bar.classList.add("hidden");
      pause();
      return;
    }
    el.bar.classList.remove("hidden");

    el.slider.min = "0";
    el.slider.max = String(layer.times.length - 1);
    el.slider.step = "1";

    const idx = layer.timeIndex ?? 0;
    if (Number(el.slider.value) !== idx) {
      advancingProgrammatically = true;
      el.slider.value = String(idx);
      advancingProgrammatically = false;
    }

    el.min.textContent = layer.times[0].label;
    el.max.textContent = layer.times[layer.times.length - 1].label;
    el.cur.textContent = layer.times[idx].label;
    el.source.textContent = layer.name + (layer.timeLoading ? " — loading…" : "");
  }

  async function onSliderInput(e) {
    if (advancingProgrammatically) return;
    const layer = State.getActiveTimeLayer();
    if (!layer) return;
    const idx = Number(e.target.value);
    el.cur.textContent = layer.times[idx]?.label || "";
    await Layers.setLayerTimeIndex(layer, idx);
  }

  function togglePlay() {
    if (playing) pause();
    else play();
  }

  function play() {
    const layer = State.getActiveTimeLayer();
    if (!layer || !layer.times || layer.times.length < 2) return;

    playing = true;
    el.play.innerHTML = "&#10073;&#10073;"; // pause glyph
    el.play.classList.add("playing");
    el.play.title = "Pause";

    const intervalMs = Number(el.speed.value) || 1000;
    if (intervalId) clearInterval(intervalId);

    intervalId = setInterval(async () => {
      const lyr = State.getActiveTimeLayer();
      if (!lyr || !lyr.times) {
        pause();
        return;
      }
      let next = (lyr.timeIndex ?? 0) + 1;
      if (next >= lyr.times.length) {
        if (el.loop.checked) {
          next = 0;
        } else {
          pause();
          return;
        }
      }
      await Layers.setLayerTimeIndex(lyr, next);
      refresh();
    }, intervalMs);
  }

  function pause() {
    playing = false;
    el.play.innerHTML = "&#9654;"; // play glyph
    el.play.classList.remove("playing");
    el.play.title = "Play";
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  window.TimeSlider = { init };
})();
