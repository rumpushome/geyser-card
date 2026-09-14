/*!
 * Geyser Card for Home Assistant
 * Solar collector temperature, tank temperature, element state, a setpoint
 * control and a boost action - in one card, in three selectable layouts.
 *
 *   style: dial     - twin concentric arcs with a key
 *   style: tank     - schematic vessel, drag the target line
 *   style: console  - flat stat blocks and one shared temperature scale
 *
 * No build step required - drop this file in /config/www/ and add it as a
 * Lovelace resource of type "JavaScript Module".
 */

const CARD_VERSION = "1.1.2";
const STYLES = ["dial", "tank", "console"];

/* ------------------------------------------------------------------ *
 * Colour helpers
 * ------------------------------------------------------------------ */

// Water: cold blue -> hot red. Collector: dim olive -> bright sun.
// Two different families on purpose - on a single shared ramp the two readings
// land on the same colour whenever they are close, which is most of the time.
const RAMP_WATER = [
  [15, "#3d7fd6"], [35, "#2bb1a8"], [50, "#8cc152"], [60, "#e8a33d"], [75, "#e0553c"],
];
const RAMP_SUN = [
  [15, "#6b6a4e"], [30, "#b8962c"], [45, "#e8b62c"], [60, "#ffd23f"], [80, "#fff0a8"],
];

function hexToRgb(hex) {
  const h = String(hex).replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rampColor(t, stops) {
  if (!Number.isFinite(t)) return "var(--secondary-text-color)";
  if (t <= stops[0][0]) return stops[0][1];
  if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a);
      const pa = hexToRgb(ca);
      const pb = hexToRgb(cb);
      return "rgb(" + pa.map((v, j) => Math.round(v + (pb[j] - v) * k)).join(",") + ")";
    }
  }
  return stops[stops.length - 1][1];
}

const water = (t) => rampColor(t, RAMP_WATER);
const sun = (t) => rampColor(t, RAMP_SUN);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[c]));
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Dial geometry, shared by the renderer and the live drag update.
const DIAL = { CX: 110, CY: 104, R_OUT: 86, R_IN: 66 };
function dialNotch(fracValue) {
  const ang = -135 + fracValue * 270;
  const a = ((ang - 90) * Math.PI) / 180;
  return {
    x1: DIAL.CX + (DIAL.R_IN - 10) * Math.cos(a),
    y1: DIAL.CY + (DIAL.R_IN - 10) * Math.sin(a),
    x2: DIAL.CX + (DIAL.R_IN + 10) * Math.cos(a),
    y2: DIAL.CY + (DIAL.R_IN + 10) * Math.sin(a),
  };
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

class GeyserCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._animateNext = true;
    // Setpoint writes are optimistic: show the new value at once, send it after
    // a pause, and ignore incoming states until the backend catches up.
    this._pending = null;
    this._pendingAt = 0;
    this._writeTimer = null;
    this._dragging = false;
    this._renderQueued = false;
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  static getConfigElement() {
    return document.createElement("geyser-card-editor");
  }

  static getStubConfig(hass) {
    const pick = (re, domain) => {
      if (!hass || !hass.states) return undefined;
      return Object.keys(hass.states).find(
        (id) => id.startsWith(domain + ".") && re.test(id)
      );
    };
    return {
      type: "custom:geyser-card",
      style: "tank",
      water_entity: pick(/water|geyser|tank/i, "sensor") || "sensor.geyser_water_temperature",
      collector_entity: pick(/collector|panel/i, "sensor"),
      element_entity: pick(/element/i, "binary_sensor"),
      setpoint_entity: pick(/setpoint|target/i, "number"),
    };
  }

  setConfig(config) {
    if (!config || !config.water_entity) {
      throw new Error("You need to define water_entity (the tank temperature sensor)");
    }
    const style = STYLES.indexOf(config.style) >= 0 ? config.style : "tank";
    this._config = Object.assign(
      {
        name: null,
        collector_entity: null,
        element_entity: null,
        setpoint_entity: null,
        boost_entity: null,
        stop_entity: null,
        min: null,
        max: null,
        round: 1,
        step: null,
        value_size: 44,
        animate: true,
        show_boost: true,
      },
      config,
      { style }
    );
    this._animateNext = true;
    this._pending = null;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;

    // Drop a pending write once the backend agrees, or if it never lands.
    if (this._pending !== null) {
      const live = this._num(this._config.setpoint_entity);
      if (live !== null && Math.abs(live - this._pending) < 0.001) this._pending = null;
      else if (Date.now() - this._pendingAt > 8000) this._pending = null;
    }

    if (first) {
      this._render();
      return;
    }
    // Never redraw under the user's finger.
    if (this._dragging) {
      this._renderQueued = true;
      return;
    }
    this._render();
  }

  get hass() {
    return this._hass;
  }

  disconnectedCallback() {
    this._detachDrag();
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
  }

  getCardSize() {
    if (!this._config) return 6;
    return this._config.style === "console" ? 6 : 8;
  }

  getGridOptions() {
    // "auto" lets the sections view measure the real rendered height. A fixed
    // row count guesses it, which shows up as dead space under a short card or
    // the next card overlapping a tall one.
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  /* --------------------------- state --------------------------- */

  _st(id) {
    if (!id || !this._hass || !this._hass.states) return undefined;
    return this._hass.states[id];
  }

  _num(id) {
    const st = this._st(id);
    if (!st) return null;
    const v = Number(st.state);
    return Number.isFinite(v) ? v : null;
  }

  _unit() {
    const st = this._st(this._config.water_entity);
    return (st && st.attributes && st.attributes.unit_of_measurement) || "°C";
  }

  _digits() {
    return Math.max(0, Math.min(2, Number(this._config.round === undefined ? 1 : this._config.round)));
  }

  _fmt(v, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    return Number(v).toFixed(digits === undefined ? this._digits() : digits);
  }

  _elementOn() {
    const st = this._st(this._config.element_entity);
    if (!st) return null;
    return st.state === "on";
  }

  // Bounds come from the number entity itself, so the control can never offer a
  // value the backend would reject. `ui` is how far one press or slider notch
  // moves - configurable, because the entity's own step is often 1 and that is
  // a lot of pressing to cross a useful range.
  _bounds() {
    const st = this._st(this._config.setpoint_entity);
    const a = (st && st.attributes) || {};
    const min = Number.isFinite(Number(a.min)) ? Number(a.min) : 30;
    const max = Number.isFinite(Number(a.max)) ? Number(a.max) : 70;
    const step = Number.isFinite(Number(a.step)) && Number(a.step) > 0 ? Number(a.step) : 1;
    const cfgStep = Number(this._config.step);
    const ui = Number.isFinite(cfgStep) && cfgStep > 0 ? cfgStep : step;
    return { min, max, step, ui };
  }

  _setpoint() {
    if (this._pending !== null) return this._pending;
    return this._num(this._config.setpoint_entity);
  }

  // Display scale for the gauges. Quantised so a hot collector widens it in
  // steps rather than making the arcs creep on every reading.
  _scale() {
    const cfg = this._config;
    const b = this._bounds();
    let min = cfg.min !== null && cfg.min !== undefined && cfg.min !== "" ? Number(cfg.min) : Math.min(10, b.min);
    let max = cfg.max !== null && cfg.max !== undefined && cfg.max !== "" ? Number(cfg.max) : null;
    if (max === null) {
      const col = this._num(cfg.collector_entity);
      const need = Math.max(b.max + 5, col === null ? 0 : col);
      max = Math.max(90, Math.ceil(need / 10) * 10);
    }
    if (max - min < 5) max = min + 5;
    return { min, max };
  }

  _frac(t) {
    const s = this._scale();
    return clamp((t - s.min) / (s.max - s.min), 0, 1);
  }

  // What is actually heating the water right now.
  _source() {
    const el = this._elementOn();
    if (el) return { cls: "src-element", txt: "Element heating" };
    const col = this._num(this._config.collector_entity);
    const w = this._num(this._config.water_entity);
    if (col !== null && w !== null && col > w + 2) {
      return { cls: "src-solar", txt: "Solar gaining" };
    }
    return { cls: "src-idle", txt: "Idle" };
  }

  /* --------------------------- actions --------------------------- */

  _setSetpoint(value, commit) {
    const b = this._bounds();
    const stepped = Math.round(value / b.step) * b.step;
    // Rounding to the step can leave a float tail (0.1 * 3 = 0.30000000000000004).
    const v = clamp(Number(stepped.toFixed(4)), b.min, b.max);
    if (this._pending === v && !commit) return;
    this._pending = v;
    this._pendingAt = Date.now();
    // A full redraw would swap out the very control being dragged, killing the
    // gesture, so live interaction gets a targeted update instead.
    if (this._interacting()) this._updateSetpointVisuals();
    else this._render();

    if (this._writeTimer) clearTimeout(this._writeTimer);
    const send = () => {
      this._writeTimer = null;
      if (!this._hass || !this._config.setpoint_entity) return;
      this._pendingAt = Date.now();
      this._hass.callService("number", "set_value", {
        entity_id: this._config.setpoint_entity,
        value: v,
      });
    };
    // Dragging fires continuously; only the value they settle on is worth
    // sending, so writes are debounced and flushed on release.
    if (commit) send();
    else this._writeTimer = setTimeout(send, 450);
  }

  // True while the user is actively working a control (dragging, or the slider
  // holds focus and they are using the keyboard).
  _interacting() {
    if (this._dragging) return true;
    const root = this.shadowRoot;
    const slider = root && root.querySelector("[data-slider]");
    return !!(slider && root.activeElement === slider);
  }

  // Move only what the setpoint controls, leaving every other node untouched.
  _updateSetpointVisuals() {
    const root = this.shadowRoot;
    const sp = this._setpoint();
    if (sp === null) return;
    const pct = (this._frac(sp) * 100).toFixed(1);
    const txt = this._fmt(sp, 0);
    const unit = this._unit();

    const tline = root.querySelector(".tline");
    if (tline) tline.style.bottom = pct + "%";
    const tlab = root.querySelector(".tlab");
    if (tlab) {
      tlab.style.bottom = pct + "%";
      tlab.innerHTML = '<span class="grip"><i></i><i></i></span>' + txt + "°";
    }
    const handle = root.querySelector(".handle");
    if (handle) handle.style.left = pct + "%";

    const srow = root.querySelector(".srow b");
    if (srow) srow.textContent = txt + " " + unit;
    const dtgt = root.querySelector(".dtgt");
    if (dtgt) dtgt.textContent = "target " + txt + "°";
    const stepVal = root.querySelector(".step b");
    if (stepVal) stepVal.textContent = txt + " " + unit;

    root.querySelectorAll(".notch").forEach((el) => {
      const n = dialNotch(this._frac(sp));
      el.setAttribute("x1", n.x1.toFixed(1));
      el.setAttribute("y1", n.y1.toFixed(1));
      el.setAttribute("x2", n.x2.toFixed(1));
      el.setAttribute("y2", n.y2.toFixed(1));
    });

    const boost = root.querySelector("[data-boost]");
    if (boost && !this._elementOn()) boost.textContent = "Boost to " + txt + "°";
  }

  _callEntity(entityId) {
    if (!entityId || !this._hass) return;
    const domain = entityId.split(".")[0];
    if (domain === "automation") {
      this._hass.callService("automation", "trigger", {
        entity_id: entityId,
        skip_condition: true,
      });
    } else if (domain === "script") {
      this._hass.callService("script", "turn_on", { entity_id: entityId });
    } else if (domain === "scene") {
      this._hass.callService("scene", "turn_on", { entity_id: entityId });
    } else if (domain === "switch" || domain === "input_boolean") {
      this._hass.callService(domain, "toggle", { entity_id: entityId });
    } else {
      this._hass.callService("homeassistant", "turn_on", { entity_id: entityId });
    }
  }

  _boost() {
    const cfg = this._config;
    const on = this._elementOn();
    // Stopping falls back to the boost entity when no separate stop is set -
    // the common case is one automation that toggles.
    const target = on ? cfg.stop_entity || cfg.boost_entity : cfg.boost_entity;
    this._callEntity(target);
  }

  _more(entityId) {
    if (!entityId) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  /* --------------------------- drag --------------------------- */

  _attachDrag() {
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
    window.addEventListener("pointercancel", this._onUp);
  }

  _detachDrag() {
    window.removeEventListener("pointermove", this._onMove);
    window.removeEventListener("pointerup", this._onUp);
    window.removeEventListener("pointercancel", this._onUp);
  }

  _valueFromTank(clientY) {
    const tank = this.shadowRoot.querySelector("[data-tank]");
    if (!tank) return null;
    const r = tank.getBoundingClientRect();
    if (!r.height) return null;
    const f = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    const s = this._scale();
    return s.min + f * (s.max - s.min);
  }

  _onMove(ev) {
    if (!this._dragging) return;
    const v = this._valueFromTank(ev.clientY);
    if (v !== null) this._setSetpoint(v, false);
  }

  _onUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this._detachDrag();
    if (this._pending !== null) this._setSetpoint(this._pending, true);
    if (this._renderQueued) {
      this._renderQueued = false;
      this._render();
    }
  }

  /* --------------------------- render --------------------------- */

  _render() {
    if (!this._config) return;
    const animate = this._animateNext && this._config.animate !== false;
    this._animateNext = false;
    this.shadowRoot.innerHTML = "<style>" + GeyserCard.styles + "</style>" + this._html(animate);
    this._wire();
  }

  _wire() {
    const root = this.shadowRoot;
    const b = this._bounds();

    const boost = root.querySelector("[data-boost]");
    if (boost) boost.addEventListener("click", () => this._boost());

    root.querySelectorAll("[data-more-entity]").forEach((el) => {
      el.addEventListener("click", () => this._more(el.dataset.moreEntity));
    });

    const slider = root.querySelector("[data-slider]");
    if (slider) {
      slider.addEventListener("input", (e) => this._setSetpoint(Number(e.target.value), false));
      slider.addEventListener("change", (e) => this._setSetpoint(Number(e.target.value), true));
      // A native range keeps its own drag state; suppress redraws while held.
      slider.addEventListener("pointerdown", () => { this._dragging = true; this._attachDrag(); });
    }

    root.querySelectorAll("[data-step]").forEach((el) => {
      el.addEventListener("click", () => {
        const cur = this._setpoint();
        if (cur === null) return;
        this._setSetpoint(cur + Number(el.dataset.step) * b.ui, true);
      });
    });

    const tank = root.querySelector("[data-tank]");
    if (tank && this._config.setpoint_entity) {
      tank.addEventListener("pointerdown", (ev) => {
        this._dragging = true;
        this._attachDrag();
        const v = this._valueFromTank(ev.clientY);
        if (v !== null) this._setSetpoint(v, false);
        ev.preventDefault();
      });
    }
  }

  _title() {
    const st = this._st(this._config.water_entity);
    return this._config.name || (st && st.attributes && st.attributes.friendly_name) || "Geyser";
  }

  _boostButton() {
    const cfg = this._config;
    if (!cfg.show_boost || !cfg.boost_entity) return "";
    const on = this._elementOn();
    const sp = this._setpoint();
    const label = on
      ? "Stop boost"
      : "Boost to " + (sp === null ? "setpoint" : this._fmt(sp, 0) + "°");
    return (
      '<button class="boost' + (on ? " stop" : "") + '" data-boost>' + escapeHtml(label) + "</button>"
    );
  }

  _sourceBar(extra) {
    const s = this._source();
    return (
      '<div class="srcbar ' + s.cls + '"' + (extra || "") + '><span class="led"></span>' +
      s.txt + "</div>"
    );
  }

  _html(animate) {
    const cfg = this._config;
    if (!this._st(cfg.water_entity)) {
      return '<ha-card><div class="pad err">Entity <code>' +
        escapeHtml(cfg.water_entity) + "</code> not found.</div></ha-card>";
    }
    if (cfg.style === "dial") return this._renderDial(animate);
    if (cfg.style === "console") return this._renderConsole(animate);
    return this._renderTank(animate);
  }

  /* ------------------------- style: dial ------------------------- */

  _renderDial(animate) {
    const cfg = this._config;
    const CX = DIAL.CX, CY = DIAL.CY, R_OUT = DIAL.R_OUT, R_IN = DIAL.R_IN;
    const arc = (r) => {
      const p = (deg) => {
        const a = ((deg - 90) * Math.PI) / 180;
        return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
      };
      const [x1, y1] = p(-135);
      const [x2, y2] = p(135);
      return "M " + x1.toFixed(2) + " " + y1.toFixed(2) +
        " A " + r + " " + r + " 0 1 1 " + x2.toFixed(2) + " " + y2.toFixed(2);
    };
    const len = (r) => 2 * Math.PI * r * 0.75;

    const w = this._num(cfg.water_entity);
    const col = this._num(cfg.collector_entity);
    const sp = this._setpoint();
    const b = this._bounds();
    const unit = this._unit();

    let notch = "";
    if (sp !== null) {
      const n = dialNotch(this._frac(sp));
      const line = (stroke, wdt) =>
        '<line class="notch" x1="' + n.x1.toFixed(1) + '" y1="' + n.y1.toFixed(1) +
        '" x2="' + n.x2.toFixed(1) + '" y2="' + n.y2.toFixed(1) + '" stroke="' + stroke +
        '" stroke-width="' + wdt + '" stroke-linecap="round"/>';
      // Backing stroke first, so the notch reads as cut into the ring.
      notch = line("var(--card-background-color)", 4.5) + line("var(--primary-text-color)", 2);
    }

    const gL = len(R_IN), sL = len(R_OUT);
    const arcs =
      '<path d="' + arc(R_OUT) + '" fill="none" stroke="var(--gy-track)" stroke-width="7" stroke-linecap="round"/>' +
      '<path d="' + arc(R_IN) + '" fill="none" stroke="var(--gy-track)" stroke-width="13" stroke-linecap="round"/>' +
      (col === null ? "" :
        '<path class="a-col" d="' + arc(R_OUT) + '" fill="none" stroke="' + sun(col) +
        '" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + sL +
        '" stroke-dashoffset="' + (sL * (1 - this._frac(col))).toFixed(2) + '"/>') +
      (w === null ? "" :
        '<path class="a-water" d="' + arc(R_IN) + '" fill="none" stroke="' + water(w) +
        '" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + gL +
        '" stroke-dashoffset="' + (gL * (1 - this._frac(w))).toFixed(2) + '"/>') +
      notch;

    const key =
      '<div class="key">' +
      (col === null ? "" :
        '<div data-more-entity="' + escapeHtml(cfg.collector_entity) + '"><i style="background:' +
        sun(col) + '"></i>Collector ' + this._fmt(col) + "°</div>") +
      (w === null ? "" :
        '<div data-more-entity="' + escapeHtml(cfg.water_entity) + '"><i style="height:6px;background:' +
        water(w) + '"></i>Tank ' + this._fmt(w) + "°</div>") +
      "</div>";

    const setRow = cfg.setpoint_entity
      ? '<div class="srow"><span>Set to</span><b class="mono">' +
        this._fmt(sp, 0) + " " + escapeHtml(unit) + "</b></div>" +
        '<input type="range" min="' + b.min + '" max="' + b.max + '" step="' + b.ui +
        '" value="' + (sp === null ? b.min : sp) + '" data-slider>'
      : "";

    return (
      '<ha-card class="s-dial' + (animate ? " anim" : "") + '">' +
        '<div class="dwrap"><svg viewBox="0 0 220 200">' + arcs + "</svg>" +
          '<div class="dmid">' +
            '<div class="dcap">' + escapeHtml(this._title()) + "</div>" +
            '<div class="dbig mono">' + this._fmt(w) + "<small>" + escapeHtml(unit) + "</small></div>" +
            (sp === null ? "" : '<div class="dtgt">target ' + this._fmt(sp, 0) + "°</div>") +
          "</div>" +
        "</div>" + key +
        '<div class="foot">' + this._sourceBar(' style="margin-bottom:10px"') + setRow +
          this._boostButton() + "</div>" +
      "</ha-card>"
    );
  }

  /* ------------------------- style: tank ------------------------- */

  _renderTank(animate) {
    const cfg = this._config;
    const w = this._num(cfg.water_entity);
    const col = this._num(cfg.collector_entity);
    const sp = this._setpoint();
    const unit = this._unit();
    const on = this._elementOn();
    const flowing = col !== null && w !== null && col > w + 2;
    const wf = w === null ? 0 : this._frac(w);
    const tf = sp === null ? null : this._frac(sp);
    const s = this._scale();

    const tickVals = [];
    const stepT = (s.max - s.min) > 60 ? 20 : 15;
    for (let t = Math.ceil(s.min / stepT) * stepT; t <= s.max; t += stepT) tickVals.push(t);
    const ticks = tickVals
      .map((t) => '<span style="top:' + ((1 - this._frac(t)) * 100).toFixed(1) + '%">' + t + "</span>")
      .join("");

    const head = col === null ? "" :
      '<div class="thead">' +
        '<div class="panel' + (flowing ? " lit" : "") + '"><i></i></div>' +
        '<div class="ttl" data-more-entity="' + escapeHtml(cfg.collector_entity) + '">' +
          '<div class="k">Solar collector</div>' +
          '<div class="v mono" style="color:var(--gy-solar-ink)">' + this._fmt(col) +
          "<small> " + escapeHtml(unit) + "</small></div></div>" +
        this._sourceBar("") +
      "</div>" +
      '<div class="link' + (flowing ? " flow" : "") + '"><div class="line"></div>' +
        '<div class="drop"></div><div class="drop"></div><div class="drop"></div>' +
        (flowing ? '<span class="gain">+' + (col - w).toFixed(1) + "°</span>" : "") +
      "</div>";

    const label = wf > 0.78 ? "now inside" : "now";
    return (
      '<ha-card class="s-tank' + (animate ? " anim" : "") + '">' + head +
        '<div class="tbody">' +
          '<div class="tank' + (cfg.setpoint_entity ? " grabbable" : "") + '" data-tank>' +
            (w === null ? '<div class="nodata">–</div>' :
              '<div class="fill" style="height:' + (wf * 100).toFixed(1) +
              "%;background:linear-gradient(to top," + water(Math.max(s.min, w - 18)) + "," + water(w) +
              ')"><div class="surface"></div></div>' +
              '<div class="' + label + ' mono" style="bottom:' + (wf * 100).toFixed(1) + '%">' +
              this._fmt(w) + "<small> " + escapeHtml(unit) + "</small></div>") +
            (tf === null ? "" :
              '<div class="tline" style="bottom:' + (tf * 100).toFixed(1) + '%"></div>' +
              '<div class="tlab" style="bottom:' + (tf * 100).toFixed(1) + '%">' +
                '<span class="grip"><i></i><i></i></span>' + this._fmt(sp, 0) + "°</div>") +
          "</div>" +
          '<div class="tscale">' + ticks + "</div>" +
        "</div>" +
        (cfg.element_entity
          ? '<div class="elem' + (on ? " on" : "") + '" data-more-entity="' +
            escapeHtml(cfg.element_entity) + '">' +
            '<span class="coil"><i></i><i></i><i></i><i></i></span>' +
            "<span>Element " + (on === null ? "unknown" : on ? "<b>on</b>" : "off") + "</span></div>"
          : "") +
        this._boostButton() +
      "</ha-card>"
    );
  }

  /* ----------------------- style: console ------------------------ */

  _renderConsole(animate) {
    const cfg = this._config;
    const w = this._num(cfg.water_entity);
    const col = this._num(cfg.collector_entity);
    const sp = this._setpoint();
    const unit = this._unit();
    const s = this._scale();
    const b = this._bounds();

    const colBlock = col === null ? "" :
      '<div class="st" data-more-entity="' + escapeHtml(cfg.collector_entity) + '">' +
        '<div class="k">Collector</div><div class="v mono" style="color:var(--gy-solar-ink)">' +
        this._fmt(col) + "<small>" + escapeHtml(unit) + "</small></div>" +
        '<div class="sub">' + (w !== null && col > w + 2 ? "▲ feeding tank" : "below tank") + "</div></div>";

    const gap = w !== null && sp !== null ? sp - w : null;
    const waterBlock =
      '<div class="st" data-more-entity="' + escapeHtml(cfg.water_entity) + '">' +
        '<div class="k">Geyser</div><div class="v mono" style="color:' + water(w) + '">' +
        this._fmt(w) + "<small>" + escapeHtml(unit) + "</small></div>" +
        '<div class="sub">' +
        (gap === null ? "&nbsp;" : gap <= 0 ? "at target" : this._fmt(gap) + "° below target") +
        "</div></div>";

    // Readable-from-across-the-room sizing is a per-dashboard decision, so the
    // headline size is a variable rather than a fixed value.
    const vs = clamp(Number(cfg.value_size) || 44, 14, 140);
    return (
      '<ha-card class="s-console' + (animate ? " anim" : "") + '" style="--gy-val:' + vs + 'px">' +
        '<div class="stats">' + colBlock + waterBlock + "</div>" +
        this._sourceBar(' style="margin-top:12px"') +
        '<div class="scale">' +
          '<div class="track">' +
            (w === null ? "" :
              '<div class="f" style="width:' + (this._frac(w) * 100).toFixed(1) +
              "%;background:linear-gradient(90deg," + water(s.min) + "," + water(w) + ')"></div>') +
          "</div>" +
          (col === null ? "" :
            '<div class="colmark" style="left:' + (this._frac(col) * 100).toFixed(1) + '%"></div>') +
          (sp === null ? "" :
            '<div class="handle" style="left:' + (this._frac(sp) * 100).toFixed(1) + '%"></div>') +
        "</div>" +
        '<div class="ticks"><span>' + Math.round(s.min) + "°</span><span>" +
          Math.round(s.min + (s.max - s.min) / 3) + "°</span><span>" +
          Math.round(s.min + ((s.max - s.min) * 2) / 3) + "°</span><span>" +
          Math.round(s.max) + "°</span></div>" +
        '<div class="legend">' +
          '<div><i style="background:' + water(w) + '"></i>tank</div>' +
          (col === null ? "" : '<div><i style="background:var(--gy-solar);border-radius:50%"></i>collector</div>') +
          (sp === null ? "" : '<div><i style="background:var(--primary-text-color);width:4px;height:11px"></i>target</div>') +
        "</div>" +
        (cfg.setpoint_entity
          ? '<div class="set"><span class="k">Target</span>' +
            '<span class="step"><button data-step="-1" aria-label="Lower target">−</button>' +
            '<b class="mono">' + this._fmt(sp, 0) + " " + escapeHtml(unit) + "</b>" +
            '<button data-step="1" aria-label="Raise target">+</button></span></div>'
          : "") +
        this._boostButton() +
      "</ha-card>"
    );
  }
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

GeyserCard.styles = [
  ":host { display: block;",
  "  --gy-hair: var(--divider-color, rgba(127,137,150,0.2));",
  "  --gy-faint: var(--disabled-text-color, var(--secondary-text-color));",
  "  --gy-track: rgba(127,137,150,0.22);",
  "  --gy-sunk: rgba(127,137,150,0.12);",
  "  --gy-solar: #ffc93f;",
  "  --gy-element: #ff6b35;",
  "  --gy-solar-ink: #d99b00;",
  "  --gy-element-ink: var(--gy-element); }",
  // Mixing the accent toward the theme's text colour darkens it on a light
  // theme and lightens it on a dark one, so it stays readable on both.
  "@supports (color: color-mix(in srgb, red, blue)) {",
  "  :host { --gy-solar-ink: color-mix(in srgb, var(--gy-solar), var(--primary-text-color) 34%);",
  "          --gy-element-ink: color-mix(in srgb, var(--gy-element), var(--primary-text-color) 18%); } }",

  "ha-card { padding: 16px; box-sizing: border-box; }",
  ".pad { padding: 6px 0; }",
  ".err { color: var(--error-color, #db4437); }",
  ".mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;",
  "  font-variant-numeric: tabular-nums; }",

  ".srcbar { display: flex; align-items: center; gap: 7px; font-size: 11px;",
  "  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700; }",
  ".led { width: 8px; height: 8px; border-radius: 50%; background: var(--gy-faint); flex: 0 0 auto; }",
  ".src-solar { color: var(--gy-solar-ink); }",
  ".src-solar .led { background: var(--gy-solar); box-shadow: 0 0 9px var(--gy-solar);",
  "  animation: gy-pulse 2.4s ease-in-out infinite; }",
  ".src-element { color: var(--gy-element-ink); }",
  ".src-element .led { background: var(--gy-element); box-shadow: 0 0 9px var(--gy-element);",
  "  animation: gy-pulse 1.2s ease-in-out infinite; }",
  ".src-idle { color: var(--gy-faint); }",
  "@keyframes gy-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }",

  ".boost { width: 100%; margin-top: 12px; padding: 11px; border-radius: 8px; font: inherit;",
  "  font-size: 13px; font-weight: 600; letter-spacing: 0.03em; border: 1px solid var(--gy-hair);",
  "  background: var(--gy-sunk); color: var(--primary-text-color); cursor: pointer;",
  "  position: relative; overflow: hidden; }",
  ".boost:hover { border-color: var(--gy-element); }",
  // Element on: the button becomes the stop control and says so in red.
  ".boost.stop { background: #d93a25; border-color: #d93a25; color: #fff; }",
  ".boost.stop::after { content: ''; position: absolute; inset: 0;",
  "  background: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.4), transparent 80%);",
  "  transform: translateX(-100%); animation: gy-sweep 2s linear infinite; }",
  "@keyframes gy-sweep { to { transform: translateX(100%); } }",

  "input[type=range] { -webkit-appearance: none; appearance: none; width: 100%;",
  "  background: transparent; cursor: pointer; margin: 4px 0 0; }",
  "input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: var(--gy-track); }",
  "input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px;",
  "  border-radius: 50%; background: var(--primary-text-color);",
  "  border: 3px solid var(--card-background-color); margin-top: -6px;",
  "  box-shadow: 0 1px 4px rgba(0,0,0,0.4); }",
  "input[type=range]::-moz-range-track { height: 6px; border-radius: 3px; background: var(--gy-track); }",
  "input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%;",
  "  background: var(--primary-text-color); border: 3px solid var(--card-background-color); }",

  /* ---------- dial ---------- */
  ".s-dial .dwrap { position: relative; width: 100%; aspect-ratio: 1/0.86; }",
  ".s-dial .dwrap svg { width: 100%; height: 100%; display: block; overflow: visible; }",
  ".s-dial .dmid { position: absolute; inset: 0; display: flex; flex-direction: column;",
  "  align-items: center; justify-content: center; padding-bottom: 12px; pointer-events: none; }",
  ".s-dial .dcap { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;",
  "  color: var(--gy-faint); font-weight: 600; margin-bottom: 7px; }",
  ".s-dial .dbig { font-size: 42px; font-weight: 300; line-height: 1; letter-spacing: -0.02em;",
  "  color: var(--primary-text-color); }",
  ".s-dial .dbig small { font-size: 16px; color: var(--secondary-text-color); margin-left: 2px; }",
  ".s-dial .dtgt { font-size: 11px; color: var(--secondary-text-color); margin-top: 8px; }",
  ".s-dial .key { display: flex; justify-content: center; gap: 16px; margin-top: -4px; }",
  ".s-dial .key div { display: flex; align-items: center; gap: 6px; font-size: 11px;",
  "  color: var(--secondary-text-color); cursor: pointer; }",
  ".s-dial .key i { width: 14px; height: 3px; border-radius: 2px; display: block; }",
  ".s-dial .foot { border-top: 1px solid var(--gy-hair); margin-top: 12px; padding-top: 12px; }",
  ".s-dial .srow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }",
  ".s-dial .srow span { font-size: 11px; color: var(--gy-faint); text-transform: uppercase;",
  "  letter-spacing: 0.08em; font-weight: 600; }",
  ".s-dial .srow b { font-size: 15px; font-weight: 500; color: var(--primary-text-color); }",
  ".s-dial.anim .a-water, .s-dial.anim .a-col { animation: gy-sweepin 0.9s cubic-bezier(0.22,1,0.36,1) both; }",
  "@keyframes gy-sweepin { from { stroke-dashoffset: 1000; } }",

  /* ---------- tank ---------- */
  ".s-tank .thead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }",
  ".s-tank .panel { width: 42px; height: 30px; border-radius: 4px; flex: 0 0 auto; position: relative;",
  "  background: linear-gradient(150deg, #2b3a4d, #16202c); border: 1px solid var(--gy-hair); overflow: hidden; }",
  ".s-tank .panel i { position: absolute; inset: 0; background:",
  "  repeating-linear-gradient(90deg, transparent 0 9px, rgba(255,255,255,0.13) 9px 10px),",
  "  repeating-linear-gradient(0deg, transparent 0 8px, rgba(255,255,255,0.13) 8px 9px); }",
  ".s-tank .panel.lit { border-color: var(--gy-solar); box-shadow: 0 0 14px rgba(255,201,63,0.35); }",
  ".s-tank .panel.lit::after { content: ''; position: absolute; inset: 0; background: rgba(255,201,63,0.22); }",
  ".s-tank .ttl { flex: 1 1 auto; min-width: 0; cursor: pointer; }",
  ".s-tank .ttl .k { font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase;",
  "  color: var(--gy-faint); font-weight: 600; }",
  ".s-tank .ttl .v { font-size: 20px; font-weight: 500; margin-top: 2px; }",
  ".s-tank .ttl .v small { font-size: 11px; color: var(--secondary-text-color); }",
  ".s-tank .link { position: relative; height: 22px; }",
  ".s-tank .link .line { position: absolute; left: 21px; top: 0; bottom: -2px; width: 3px;",
  "  transform: translateX(-50%); background: var(--gy-track); border-radius: 2px; }",
  ".s-tank .link .drop { position: absolute; left: 21px; width: 5px; height: 5px; border-radius: 50%;",
  "  transform: translateX(-50%); background: var(--gy-solar); opacity: 0; }",
  ".s-tank .link.flow .line { background: rgba(255,201,63,0.35); }",
  ".s-tank .link.flow .drop { animation: gy-fall 1.6s linear infinite; }",
  ".s-tank .link.flow .drop:nth-child(3) { animation-delay: 0.53s; }",
  ".s-tank .link.flow .drop:nth-child(4) { animation-delay: 1.06s; }",
  ".s-tank .link .gain { position: absolute; left: 34px; top: 2px; font-size: 10.5px;",
  "  color: var(--gy-solar-ink); font-weight: 700; }",
  "@keyframes gy-fall { 0% { top: -4px; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; }",
  "  100% { top: 100%; opacity: 0; } }",
  ".s-tank .tbody { display: flex; gap: 8px; align-items: stretch; }",
  ".s-tank .tank { position: relative; flex: 1 1 auto; height: 190px; border-radius: 14px;",
  "  background: var(--gy-sunk); border: 1px solid var(--gy-hair); overflow: hidden; touch-action: none; }",
  ".s-tank .tank.grabbable { cursor: ns-resize; }",
  ".s-tank .fill { position: absolute; left: 0; right: 0; bottom: 0; border-radius: 0 0 13px 13px; }",
  ".s-tank .surface { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: rgba(255,255,255,0.45); }",
  ".s-tank .now { position: absolute; left: 10px; margin-bottom: 5px; font-size: 22px; font-weight: 500;",
  "  line-height: 1.05; color: var(--primary-text-color); text-shadow: 0 1px 4px rgba(0,0,0,0.35); }",
  ".s-tank .now small { font-size: 11px; opacity: 0.75; }",
  ".s-tank .now.inside { margin-bottom: 0; transform: translateY(100%); padding-top: 5px; color: #fff; }",
  ".s-tank .tline { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--primary-text-color); opacity: 0.7; }",
  ".s-tank .tlab { position: absolute; right: 5px; transform: translateY(50%); font-size: 10.5px;",
  "  font-weight: 600; background: var(--primary-text-color); color: var(--card-background-color);",
  "  padding: 2px 6px 2px 4px; border-radius: 4px; display: flex; align-items: center; gap: 4px;",
  "  box-shadow: 0 1px 5px rgba(0,0,0,0.4); }",
  ".s-tank .tlab .grip { display: flex; flex-direction: column; gap: 2px; }",
  ".s-tank .tlab .grip i { width: 8px; height: 1.5px; background: var(--card-background-color);",
  "  display: block; border-radius: 1px; }",
  ".s-tank .nodata { position: absolute; inset: 0; display: flex; align-items: center;",
  "  justify-content: center; color: var(--gy-faint); }",
  ".s-tank .tscale { width: 26px; flex: 0 0 auto; position: relative; }",
  ".s-tank .tscale span { position: absolute; right: 0; font-size: 9px; color: var(--gy-faint);",
  "  transform: translateY(-50%); }",
  ".s-tank .elem { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 10px;",
  "  border-radius: 8px; background: var(--gy-sunk); font-size: 12px; cursor: pointer;",
  "  color: var(--secondary-text-color); }",
  ".s-tank .elem b { color: var(--gy-element-ink); }",
  ".s-tank .coil { display: flex; gap: 2px; }",
  ".s-tank .coil i { width: 4px; height: 12px; border-radius: 2px; background: var(--gy-faint); display: block; }",
  ".s-tank .elem.on .coil i { background: var(--gy-element); box-shadow: 0 0 7px var(--gy-element); }",
  ".s-tank .elem.on .coil i:nth-child(2) { animation: gy-glow 1.1s ease-in-out infinite 0.15s; }",
  ".s-tank .elem.on .coil i:nth-child(3) { animation: gy-glow 1.1s ease-in-out infinite 0.3s; }",
  "@keyframes gy-glow { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }",
  ".s-tank.anim .fill { animation: gy-rise 0.8s cubic-bezier(0.22,1,0.36,1) both; }",
  "@keyframes gy-rise { from { clip-path: inset(100% 0 0 0); } to { clip-path: inset(0 0 0 0); } }",

  /* ---------- console ---------- */
  // Collector and geyser always sit side by side. Rather than wrapping or
  // overflowing when the headline is sized up, the type shrinks to fit its own
  // column - so value_size is a ceiling on a narrow card, not a promise.
  ".s-console .stats { display: flex; flex-wrap: nowrap; border: 1px solid var(--gy-hair);",
  "  border-radius: 8px; overflow: hidden; container-type: inline-size; }",
  ".s-console .st { flex: 1 1 0; padding: 11px 12px; min-width: 0; cursor: pointer;",
  "  --gy-eff: var(--gy-val, 44px); }",
  "@supports (container-type: inline-size) {",
  "  .s-console .st { --gy-eff: min(var(--gy-val, 44px), 15cqw); } }",
  ".s-console .st + .st { border-left: 1px solid var(--gy-hair); }",
  ".s-console .st .k { font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase;",
  "  color: var(--gy-faint); font-weight: 600; white-space: nowrap; overflow: hidden;",
  "  text-overflow: ellipsis; }",
  ".s-console .st .v { font-size: var(--gy-eff); font-weight: 400; margin-top: 4px;",
  "  line-height: 1.02; letter-spacing: -0.02em; white-space: nowrap; }",
  ".s-console .st .v small { font-size: calc(var(--gy-eff) * 0.36);",
  "  color: var(--secondary-text-color); margin-left: 3px; }",
  ".s-console .st .sub { font-size: 11.5px; color: var(--gy-faint); margin-top: 6px;",
  "  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  ".s-console .scale { margin: 16px 0 6px; position: relative; height: 34px; }",
  ".s-console .track { position: absolute; left: 0; right: 0; top: 11px; height: 12px;",
  "  border-radius: 6px; background: var(--gy-track); overflow: hidden; }",
  ".s-console .track .f { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; }",
  ".s-console .colmark { position: absolute; top: 4px; width: 2px; height: 26px;",
  "  background: var(--gy-solar); transform: translateX(-50%); border-radius: 1px; }",
  ".s-console .colmark::after { content: ''; position: absolute; top: -4px; left: 50%; width: 7px;",
  "  height: 7px; border-radius: 50%; background: var(--gy-solar); transform: translateX(-50%); }",
  ".s-console .handle { position: absolute; top: 2px; width: 5px; height: 30px; border-radius: 3px;",
  "  background: var(--primary-text-color); transform: translateX(-50%);",
  "  box-shadow: 0 0 0 3px var(--card-background-color); }",
  ".s-console .ticks { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--gy-faint); }",
  ".s-console .legend { display: flex; gap: 14px; margin-top: 10px; font-size: 11px;",
  "  color: var(--secondary-text-color); }",
  ".s-console .legend div { display: flex; align-items: center; gap: 5px; }",
  ".s-console .legend i { width: 9px; height: 9px; border-radius: 2px; display: block; }",
  // The row wraps rather than pushing the "+" past the card edge when the
  // headline is sized right up.
  ".s-console .set { display: flex; align-items: center; justify-content: space-between;",
  "  flex-wrap: wrap; gap: 8px 12px; margin-top: 14px; padding-top: 12px;",
  "  border-top: 1px solid var(--gy-hair); }",
  ".s-console .set .k { font-size: 11px; color: var(--gy-faint); text-transform: uppercase;",
  "  letter-spacing: 0.08em; font-weight: 600; }",
  ".s-console .step { display: flex; align-items: center; gap: 10px; flex: 1 1 auto;",
  "  justify-content: flex-end; }",
  // Tracks the headline, but bounded: a control only has to be comfortably
  // tappable, and past ~60px it just eats the card.
  ".s-console .step button { width: clamp(40px, calc(var(--gy-val, 44px) * 0.8), 60px);",
  "  height: clamp(40px, calc(var(--gy-val, 44px) * 0.8), 60px); padding: 0; font: inherit;",
  "  font-size: clamp(18px, calc(var(--gy-val, 44px) * 0.4), 28px); line-height: 1;",
  "  border-radius: 8px; border: 1px solid var(--gy-hair); background: var(--gy-sunk);",
  "  color: var(--primary-text-color); cursor: pointer; flex: 0 0 auto; }",
  ".s-console .step button:hover { border-color: var(--gy-element); }",
  ".s-console .step button:active { background: var(--gy-track); }",
  ".s-console .step b { font-size: clamp(18px, calc(var(--gy-val, 44px) * 0.5), 34px);",
  "  font-weight: 500; min-width: clamp(60px, calc(var(--gy-val, 44px) * 1.6), 120px);",
  "  text-align: center; color: var(--primary-text-color); white-space: nowrap; }",
  ".s-console.anim .track .f { animation: gy-grow 0.7s cubic-bezier(0.22,1,0.36,1) both; }",
  "@keyframes gy-grow { from { transform: scaleX(0); transform-origin: left; } }",

  "@media (prefers-reduced-motion: reduce) {",
  "  .led, .boost.stop::after, .link.flow .drop, .coil i, .fill, .track .f,",
  "  .a-water, .a-col { animation: none !important; } }",
].join("\n");

/* ------------------------------------------------------------------ *
 * Visual editor
 * ------------------------------------------------------------------ */

const EDITOR_SCHEMA = [
  {
    name: "style",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "tank", label: "Tank — schematic vessel, drag the target line" },
          { value: "dial", label: "Dial — twin arcs with a key" },
          { value: "console", label: "Console — flat scale with steppers" },
        ],
      },
    },
  },
  { name: "water_entity", required: true, selector: { entity: { domain: ["sensor"] } } },
  { name: "collector_entity", selector: { entity: { domain: ["sensor"] } } },
  { name: "element_entity", selector: { entity: { domain: ["binary_sensor", "switch"] } } },
  { name: "setpoint_entity", selector: { entity: { domain: ["number", "input_number"] } } },
  { name: "boost_entity", selector: { entity: { domain: ["automation", "script", "switch", "input_boolean"] } } },
  { name: "stop_entity", selector: { entity: { domain: ["automation", "script", "switch", "input_boolean"] } } },
  {
    type: "grid",
    schema: [
      { name: "name", selector: { text: {} } },
      { name: "round", selector: { number: { min: 0, max: 2, mode: "box" } } },
      { name: "min", selector: { number: { mode: "box", step: "any" } } },
      { name: "max", selector: { number: { mode: "box", step: "any" } } },
      { name: "step", selector: { number: { min: 0.5, max: 20, step: 0.5, mode: "box" } } },
      { name: "value_size", selector: { number: { min: 14, max: 140, step: 2, mode: "box" } } },
    ],
  },
  {
    type: "grid",
    schema: [
      { name: "show_boost", selector: { boolean: {} } },
      { name: "animate", selector: { boolean: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  style: "Layout",
  water_entity: "Geyser (tank) temperature — required",
  collector_entity: "Solar collector temperature",
  element_entity: "Element on/off",
  setpoint_entity: "Setpoint (number entity)",
  boost_entity: "Boost automation or script",
  stop_entity: "Stop-boost target (blank = re-trigger boost)",
  name: "Card title",
  round: "Decimal places",
  min: "Scale minimum (blank = auto)",
  max: "Scale maximum (blank = auto)",
  step: "Step per press (blank = entity's own step)",
  value_size: "Temperature font size, px — console only",
  show_boost: "Show boost button",
  animate: "Animations",
};

class GeyserCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = Object.assign({}, config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      const form = document.createElement("ha-form");
      form.computeLabel = (schema) => EDITOR_LABELS[schema.name] || schema.name;
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const next = Object.assign({}, ev.detail.value);
        Object.keys(next).forEach((k) => {
          if (next[k] === "" || next[k] === undefined || next[k] === null) delete next[k];
        });
        this._config = next;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: next },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.shadowRoot.appendChild(form);
      this._form = form;
    }
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
    if (this._hass) this._form.hass = this._hass;
  }
}

customElements.define("geyser-card", GeyserCard);
customElements.define("geyser-card-editor", GeyserCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "geyser-card",
  name: "Geyser Card",
  description: "Solar collector, tank temperature, element state, setpoint and boost — in three selectable layouts.",
  preview: true,
});

console.info(
  "%c GEYSER-CARD %c v" + CARD_VERSION + " ",
  "color: #1b0d05; background: #ffc93f; font-weight: 700;",
  "color: #ffc93f; background: #222; font-weight: 700;"
);
