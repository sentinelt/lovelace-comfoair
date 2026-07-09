import {
  LitElement,
  html,
  css
} from "https://unpkg.com/lit-element@2.5.1/lit-element.js?module";
import { svg } from "https://unpkg.com/lit-html@1.4.1/lit-html.js?module";

/**
 * Lovelace card for Zehnder ComfoAir (esphome-comfoair).
 *
 * Visualization inspired by TimWeyand/lovelace-comfoair (SVG airflows,
 * temperature color scale, setpoint/fan controls, status chips).
 *
 * Config:
 *   type: custom:comfoair-card
 *   entity: climate.esphome_comfoair200_comfoair_200   # required
 *   prefix: esphome_comfoair200                         # optional; auto-detected from entity
 *   name: ComfoAir                                      # optional title
 *   animation: static | animated                        # default static
 *   animation_speed_source: fixed | level               # default fixed
 *   animation_speed: 50                                 # 10–200 %, fixed source
 *   color_scale: fixed | auto                           # default fixed
 *   temp_min: -20                                       # dark blue at/below this
 *   temp_max: 40                                        # red at/above this
 *   show_legend: false
 *   enable_test_mode: false                             # show service/test dialog button
 *
 * Entity IDs default to {domain}.{prefix}_{suffix}. When prefix is omitted it
 * is derived from the climate entity (device siblings or object_id heuristics).
 * Override any key with a full entity_id (or TimWeyand-compatible aliases).
 *
 * Optional entities (defaults from prefix):
 *   error_status, filter_reset, error_reset — error chip + filter/error resets
 *   test_mode, self_test, test_* — PC test-mode (requires enable_test_mode)
 */

/** Sensor suffixes used to probe which prefix matches live HA entities. */
const PREFIX_PROBE_SUFFIXES = [
  "outside_air_temperature",
  "supply_air_temperature",
  "return_air_temperature",
  "exhaust_air_temperature",
  "intake_fan_speed_rpm",
  "exhaust_fan_speed_rpm",
  "return_air_level",
  "supply_air_level",
];

/**
 * Candidate prefixes from a climate entity_id object_id, longest first.
 * climate.esphome_comfoair200_comfoair_200 →
 *   esphome_comfoair200_comfoair_200, esphome_comfoair200_comfoair, esphome_comfoair200, …
 */
function prefixCandidatesFromClimate(climateEntityId) {
  if (!climateEntityId || !climateEntityId.includes(".")) return ["comfoair"];
  let objectId = climateEntityId.split(".", 2)[1] || "";
  if (!objectId) return ["comfoair"];

  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  push(objectId);
  if (objectId.endsWith("_climate")) {
    push(objectId.slice(0, -"_climate".length));
  }

  const parts = objectId.split("_");
  for (let i = parts.length - 1; i >= 1; i--) {
    push(parts.slice(0, i).join("_"));
  }

  push("comfoair");
  return candidates;
}

/**
 * Infer sensor prefix from HA device registry siblings of the climate entity.
 * e.g. climate + sensor.esphome_comfoair200_outside_air_temperature → esphome_comfoair200
 */
function prefixFromDevice(hass, climateEntityId) {
  const deviceId = hass?.entities?.[climateEntityId]?.device_id;
  if (!deviceId || !hass.entities) return null;

  for (const id of Object.keys(hass.entities)) {
    if (hass.entities[id].device_id !== deviceId) continue;
    if (!id.startsWith("sensor.") && !id.startsWith("binary_sensor.")) continue;
    const objectId = id.split(".", 2)[1] || "";
    for (const suffix of PREFIX_PROBE_SUFFIXES) {
      if (objectId.endsWith(`_${suffix}`)) {
        return objectId.slice(0, -(suffix.length + 1));
      }
    }
    // filter / error / bypass / preheat / summer (binary or sensor)
    for (const suffix of [
      "filter_status",
      "error_status",
      "bypass_valve_open",
      "preheating_state",
      "summer_mode",
      "supply_fan_active",
    ]) {
      if (objectId.endsWith(`_${suffix}`)) {
        return objectId.slice(0, -(suffix.length + 1));
      }
    }
  }
  return null;
}

/** Score how many probe sensors exist for a given prefix. */
function scorePrefix(hass, prefix) {
  if (!hass?.states || !prefix) return 0;
  let score = 0;
  for (const suffix of PREFIX_PROBE_SUFFIXES) {
    if (hass.states[`sensor.${prefix}_${suffix}`]) score += 1;
  }
  return score;
}

/**
 * Resolve the entity ID prefix used for sensors/binary_sensors.
 * Explicit config.prefix wins; otherwise device registry / live-state scoring /
 * climate object_id heuristics; finally "comfoair".
 */
function resolvePrefix(hass, climateEntityId, explicitPrefix) {
  if (explicitPrefix) return explicitPrefix;

  const fromDevice = prefixFromDevice(hass, climateEntityId);
  if (fromDevice && scorePrefix(hass, fromDevice) > 0) {
    return fromDevice;
  }

  const candidates = prefixCandidatesFromClimate(climateEntityId);
  if (fromDevice && !candidates.includes(fromDevice)) {
    candidates.unshift(fromDevice);
  }

  let best = null;
  let bestScore = 0;
  for (const p of candidates) {
    const s = scorePrefix(hass, p);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  if (best && bestScore > 0) return best;

  // No live match: strip common climate entity tails from the object_id
  // (ESPHome: climate.esphome_comfoair200_comfoair_200 → esphome_comfoair200).
  const objectId = (climateEntityId || "").split(".", 2)[1] || "";
  const stripped = objectId
    .replace(/_climate$/i, "")
    .replace(/_comfoair(_\d+)?$/i, "")
    .replace(/_+$/g, "");
  if (stripped) return stripped;

  return candidates[0] || "comfoair";
}

const SUPPLY_PATH = "M6,19 H120 L320,113 H434";
const EXHAUST_PATH = "M434,19 H320 L120,113 H6";
const FLOW_BASE = 3.0;
const SPIN_BASE = 1.6;

const FAN_BUTTONS = [
  { mode: "off", icon: "mdi:fan-off" },
  { mode: "low", icon: "mdi:fan-speed-1" },
  { mode: "medium", icon: "mdi:fan-speed-2" },
  { mode: "high", icon: "mdi:fan-speed-3" },
];

const FAN_MODE_LABELS = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  auto: "Auto",
};

// OKLCH heatmap stops: cold (blue) → hot (dark red)
const RAMP_STOPS = [
  [0.6, 0.16, 252],
  [0.72, 0.13, 215],
  [0.8, 0.14, 155],
  [0.82, 0.16, 95],
  [0.66, 0.19, 45],
  [0.5, 0.205, 28],
];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;

function rampColor(f) {
  const st = RAMP_STOPS;
  const c = clamp01(f);
  const s = c * (st.length - 1);
  const i = Math.min(st.length - 2, Math.floor(s));
  const t = s - i;
  const L = lerp(st[i][0], st[i + 1][0], t);
  const C = lerp(st[i][1], st[i + 1][1], t);
  const H = lerp(st[i][2], st[i + 1][2], t);
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/** Default fixed scale: dark blue ≤ -20 °C, red ≥ 40 °C. */
const DEFAULT_TEMP_MIN = -20;
const DEFAULT_TEMP_MAX = 40;

function tempDomain(values, mode = "fixed", min = DEFAULT_TEMP_MIN, max = DEFAULT_TEMP_MAX) {
  if (mode !== "auto") return [min, max];
  const v = values.filter((x) => x != null && !Number.isNaN(x));
  if (v.length === 0) return [min, max];
  let mn = Math.min(...v);
  let mx = Math.max(...v);
  const SPREAD = 4;
  if (mx - mn < SPREAD) {
    const center = (mx + mn) / 2;
    mn = center - SPREAD / 2;
    mx = center + SPREAD / 2;
  }
  const pad = (mx - mn) * 0.12;
  return [mn - pad, mx + pad];
}

function tempColor(value, domain) {
  if (value == null || Number.isNaN(value)) {
    return "var(--disabled-text-color, #888)";
  }
  const [mn, mx] = domain;
  return rampColor((value - mn) / (mx - mn || 1));
}

/** Heat recovery efficiency %; null if not meaningful. */
function recoveryPct(outside, extract, supply) {
  if (outside == null || extract == null || supply == null) return null;
  const denom = extract - outside;
  if (denom <= 0.5) return null;
  const ratio = (supply - outside) / denom;
  if (ratio <= 0) return null;
  return Math.round(Math.min(1, ratio) * 100);
}

function animSpeedFactor(source, fixedPct, levelPct) {
  if (source === "level") {
    const lv = levelPct == null || Number.isNaN(levelPct) ? 50 : levelPct;
    return Math.min(2.5, Math.max(0.2, lv / 50));
  }
  const p = fixedPct == null || Number.isNaN(fixedPct) ? 50 : fixedPct;
  return Math.min(2, Math.max(0.1, p / 100));
}

function clampTemperature(current, step, min, max, direction) {
  const next = Math.round((current + direction * step) * 10) / 10;
  return Math.min(max, Math.max(min, next));
}

function isFanModeActive(fanMode, mode) {
  return !!fanMode && fanMode.toLowerCase() === mode.toLowerCase();
}

/** True when error_status text is a live fault list (not empty / None / OK). */
function hasActiveError(raw) {
  if (raw == null || raw === "" || raw === "—" || raw === undefined) return false;
  const s = String(raw).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return lower !== "none" && lower !== "ok" && lower !== "unknown" && lower !== "unavailable";
}

/** Status chip data (English labels). Optional action: filter_reset | error_reset. */
function statusChip(kind, raw, fanMode) {
  const on = raw === "on" || raw === "Full" || raw === "full";
  switch (kind) {
    case "fan": {
      const fm = (fanMode ?? "off").toLowerCase();
      return {
        icon: "mdi:fan",
        label: "Fan",
        sub: FAN_MODE_LABELS[fm] ?? fm,
        active: fm !== "off",
        color: "#03a9f4",
      };
    }
    case "filter":
      return {
        icon: "mdi:air-filter",
        label: "Filter",
        sub: on ? "Replace" : "OK",
        active: on,
        color: "#f5a623",
        action: on ? "filter_reset" : null,
        title: on ? "Click to reset filter timer" : "Filter status",
      };
    case "error": {
      const active = hasActiveError(raw);
      const sub = active ? String(raw) : "None";
      return {
        icon: active ? "mdi:alert-circle" : "mdi:check-circle-outline",
        label: "Error",
        sub,
        active,
        color: "#e53935",
        action: active ? "error_reset" : null,
        title: active ? `Click to reset errors (${sub})` : "No active errors",
      };
    }
    case "bypass":
      return {
        icon: "mdi:valve",
        label: "Bypass",
        sub: on ? "Open" : "Closed",
        active: on,
        color: "#36c46b",
      };
    case "preheat":
      return {
        icon: "mdi:radiator",
        label: "Preheat",
        sub: on ? "Active" : "Off",
        active: on,
        color: "#ff7043",
      };
    case "season":
      return on
        ? {
            icon: "mdi:weather-sunny",
            label: "Summer",
            sub: "",
            active: true,
            color: "#ffb300",
          }
        : {
            icon: "mdi:snowflake",
            label: "Winter",
            sub: "",
            active: true,
            color: "#4fc3f7",
          };
    default:
      return { icon: "mdi:help", label: "?", sub: "", active: false, color: "#888" };
  }
}

/** Flap select options used by esphome-comfoair test mode. */
const FLAP_OPTIONS = ["Closed", "Open", "Stop"];

/** Relay / output switches exposed in test mode. */
const TEST_OUTPUT_SWITCHES = [
  { key: "testPreheatRelay", suffix: "test_preheat_relay", label: "Preheat relay" },
  { key: "testPreheatTriac", suffix: "test_preheat_triac", label: "Preheat triac" },
  { key: "testEwtSupply", suffix: "test_ewt_supply", label: "EWT supply" },
  { key: "testEwtDirection", suffix: "test_ewt_direction", label: "EWT direction" },
  { key: "testKitchenHood", suffix: "test_kitchen_hood", label: "Kitchen hood" },
  { key: "testErrorOutput", suffix: "test_error_output", label: "Error output" },
  { key: "testFilterLed", suffix: "test_filter_led", label: "Filter LED" },
];

class ComfoAirCard extends LitElement {
  static get properties() {
    return {
      hass: {},
      config: {},
      _testDialogOpen: { type: Boolean },
    };
  }

  constructor() {
    super();
    // Unique SVG paint-server IDs when multiple cards share a page
    this._uid = Math.random().toString(36).slice(2, 9);
    this._testDialogOpen = false;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("Please define a climate entity (entity: climate....)");
    }
    this.config = config;
  }

  /** Card-level flag (default false). ESPHome must also enable test mode. */
  _testModeEnabled() {
    return this.config?.enable_test_mode === true;
  }

  static async getConfigElement() {
    return document.createElement("comfoair-card-editor");
  }

  static getStubConfig(hass) {
    if (!hass?.states) {
      return { entity: "" };
    }
    const climates = Object.keys(hass.states).filter((id) =>
      id.startsWith("climate.")
    );
    const climate =
      climates.find((id) => /comfo|wtw|ca\d{3}|esphome/i.test(id)) ||
      climates[0] ||
      "";
    if (!climate) {
      return { entity: "" };
    }
    return {
      entity: climate,
      prefix: resolvePrefix(hass, climate, undefined),
      animation: "static",
      color_scale: "fixed",
      temp_min: DEFAULT_TEMP_MIN,
      temp_max: DEFAULT_TEMP_MAX,
    };
  }

  getCardSize() {
    return 5;
  }

  /** Effective sensor prefix (config or auto-detected from climate entity). */
  _prefix() {
    return resolvePrefix(this.hass, this.config?.entity, this.config?.prefix);
  }

  /** Resolve entity id: config override, TimWeyand alias, or domain.prefix_suffix. */
  _entityId(domain, suffix, ...configKeys) {
    for (const key of configKeys) {
      if (this.config[key]) return this.config[key];
    }
    const prefix = this._prefix();
    return `${domain}.${prefix}_${suffix}`;
  }

  _ids() {
    return {
      climate: this.config.entity,
      // Outside / outdoor
      outside: this._entityId(
        "sensor",
        "outside_air_temperature",
        "outside_air_temperature",
        "tempSensor1"
      ),
      // Exhaust air (leaving the building)
      exhaust: this._entityId(
        "sensor",
        "exhaust_air_temperature",
        "exhaust_air_temperature",
        "tempSensor2"
      ),
      // Extract / return air (from rooms)
      returnTemp: this._entityId(
        "sensor",
        "return_air_temperature",
        "return_air_temperature",
        "tempSensor3"
      ),
      // Supply air (into rooms)
      supply: this._entityId(
        "sensor",
        "supply_air_temperature",
        "supply_air_temperature",
        "tempSensor4"
      ),
      intakeRpm: this._entityId(
        "sensor",
        "intake_fan_speed_rpm",
        "intake_fan_speed_rpm",
        "fan_speed_supply"
      ),
      exhaustRpm: this._entityId(
        "sensor",
        "exhaust_fan_speed_rpm",
        "exhaust_fan_speed_rpm",
        "fan_speed_exhaust"
      ),
      returnLevel: this._entityId(
        "sensor",
        "return_air_level",
        "return_air_level"
      ),
      supplyLevel: this._entityId(
        "sensor",
        "supply_air_level",
        "supply_air_level"
      ),
      filter: this._entityId(
        "sensor",
        "filter_status",
        "filter_status",
        "filterstatus"
      ),
      error: this._entityId(
        "sensor",
        "error_status",
        "error_status"
      ),
      filterReset: this._entityId(
        "button",
        "filter_reset",
        "filter_reset"
      ),
      errorReset: this._entityId(
        "button",
        "error_reset",
        "error_reset"
      ),
      testMode: this._entityId("switch", "test_mode", "test_mode"),
      selfTest: this._entityId("button", "self_test", "self_test"),
      testSupplyFan: this._entityId(
        "number",
        "test_supply_fan",
        "test_supply_fan"
      ),
      testExhaustFan: this._entityId(
        "number",
        "test_exhaust_fan",
        "test_exhaust_fan"
      ),
      testPostheat: this._entityId(
        "number",
        "test_postheat",
        "test_postheat"
      ),
      testBypassFlap: this._entityId(
        "select",
        "test_bypass_flap",
        "test_bypass_flap"
      ),
      testPreheatFlap: this._entityId(
        "select",
        "test_preheat_flap",
        "test_preheat_flap"
      ),
      testPreheatRelay: this._entityId(
        "switch",
        "test_preheat_relay",
        "test_preheat_relay"
      ),
      testPreheatTriac: this._entityId(
        "switch",
        "test_preheat_triac",
        "test_preheat_triac"
      ),
      testEwtSupply: this._entityId(
        "switch",
        "test_ewt_supply",
        "test_ewt_supply"
      ),
      testEwtDirection: this._entityId(
        "switch",
        "test_ewt_direction",
        "test_ewt_direction"
      ),
      testKitchenHood: this._entityId(
        "switch",
        "test_kitchen_hood",
        "test_kitchen_hood"
      ),
      testErrorOutput: this._entityId(
        "switch",
        "test_error_output",
        "test_error_output"
      ),
      testFilterLed: this._entityId(
        "switch",
        "test_filter_led",
        "test_filter_led"
      ),
      bypass: this._entityId(
        "binary_sensor",
        "bypass_valve_open",
        "bypass_valve_open",
        "bypass_valve"
      ),
      preheat: this._entityId(
        "binary_sensor",
        "preheating_state",
        "preheating_state",
        "preheat"
      ),
      summer: this._entityId(
        "binary_sensor",
        "summer_mode",
        "summer_mode"
      ),
    };
  }

  _state(entityId) {
    if (!this.hass || !entityId) return undefined;
    return this.hass.states[entityId];
  }

  _stateValue(entityId, fallback = "—") {
    const st = this._state(entityId);
    if (!st || st.state === undefined || st.state === null) return fallback;
    if (st.state === "unavailable" || st.state === "unknown" || st.state === "") {
      return fallback;
    }
    return st.state;
  }

  _numState(entityId) {
    const st = this._state(entityId);
    if (!st) return undefined;
    const n = parseFloat(st.state);
    return Number.isNaN(n) ? undefined : n;
  }

  _attr(entityId, attr, fallback) {
    const st = this._state(entityId);
    if (!st || !st.attributes || st.attributes[attr] === undefined) {
      return fallback;
    }
    return st.attributes[attr];
  }

  _requiredEntities() {
    const ids = this._ids();
    return [
      ids.climate,
      ids.outside,
      ids.exhaust,
      ids.returnTemp,
      ids.supply,
      ids.intakeRpm,
      ids.exhaustRpm,
      ids.returnLevel,
      ids.supplyLevel,
    ];
  }

  _missingEntities() {
    if (!this.hass) return [];
    return this._requiredEntities().filter((id) => !this.hass.states[id]);
  }

  _moreInfo(entityId) {
    if (!entityId) return;
    const ev = new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      detail: { entityId },
    });
    this.dispatchEvent(ev);
  }

  _setFan(mode) {
    if (!this.config.entity || !this.hass) return;
    this.hass.callService("climate", "set_fan_mode", {
      entity_id: this.config.entity,
      fan_mode: mode,
    });
  }

  _pressButton(entityId) {
    if (!this.hass || !entityId) return;
    if (!this.hass.states[entityId]) return;
    this.hass.callService("button", "press", { entity_id: entityId });
  }

  _turnSwitch(entityId, on) {
    if (!this.hass || !entityId || !this.hass.states[entityId]) return;
    this.hass.callService("switch", on ? "turn_on" : "turn_off", {
      entity_id: entityId,
    });
  }

  _setNumber(entityId, value) {
    if (!this.hass || !entityId || !this.hass.states[entityId]) return;
    this.hass.callService("number", "set_value", {
      entity_id: entityId,
      value: Number(value),
    });
  }

  _setSelect(entityId, option) {
    if (!this.hass || !entityId || !this.hass.states[entityId]) return;
    this.hass.callService("select", "select_option", {
      entity_id: entityId,
      option,
    });
  }

  _openTestDialog() {
    this._testDialogOpen = true;
  }

  _closeTestDialog() {
    this._testDialogOpen = false;
  }

  _onTestDialogKey(ev) {
    if (ev.key === "Escape") this._closeTestDialog();
  }

  /**
   * Status chip click: active filter/error chips confirm + press reset buttons;
   * otherwise open more-info on the related entity when present.
   */
  _onChipClick(chip, ids) {
    if (chip.action === "filter_reset") {
      if (
        this.hass?.states?.[ids.filterReset] &&
        window.confirm("Reset the filter timer on the ventilation unit?")
      ) {
        this._pressButton(ids.filterReset);
      } else if (!this.hass?.states?.[ids.filterReset] && ids.filter) {
        this._moreInfo(ids.filter);
      }
      return;
    }
    if (chip.action === "error_reset") {
      if (
        this.hass?.states?.[ids.errorReset] &&
        window.confirm("Reset active fault codes on the ventilation unit?")
      ) {
        this._pressButton(ids.errorReset);
      } else if (!this.hass?.states?.[ids.errorReset] && ids.error) {
        this._moreInfo(ids.error);
      }
      return;
    }
    if (chip.entityId) this._moreInfo(chip.entityId);
  }

  _stepTemp(direction) {
    if (!this.hass || !this.config.entity) return;
    const climate = this._state(this.config.entity);
    const current = Number(climate?.attributes?.temperature);
    if (!Number.isFinite(current)) return;
    const stepRaw = Number(climate.attributes.target_temp_step);
    const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 0.5;
    const min = Number(climate.attributes.min_temp);
    const max = Number(climate.attributes.max_temp);
    const next = clampTemperature(
      current,
      step,
      Number.isFinite(min) ? min : -Infinity,
      Number.isFinite(max) ? max : Infinity,
      direction
    );
    this.hass.callService("climate", "set_temperature", {
      entity_id: this.config.entity,
      temperature: next,
    });
  }

  _flowGroup(durS, durE) {
    const halfS = (Number(durS) / 2).toFixed(1);
    const halfE = (Number(durE) / 2).toFixed(1);
    const soft = `url(#soft-${this._uid})`;
    return svg`<g class="flow-hi" filter=${soft}>
      <circle r="11" fill="#fff"><animateMotion path=${SUPPLY_PATH} dur="${durS}s" begin="0s" repeatCount="indefinite"></animateMotion></circle>
      <circle r="11" fill="#fff"><animateMotion path=${SUPPLY_PATH} dur="${durS}s" begin="-${halfS}s" repeatCount="indefinite"></animateMotion></circle>
      <circle r="11" fill="#fff"><animateMotion path=${EXHAUST_PATH} dur="${durE}s" begin="0s" repeatCount="indefinite"></animateMotion></circle>
      <circle r="11" fill="#fff"><animateMotion path=${EXHAUST_PATH} dur="${durE}s" begin="-${halfE}s" repeatCount="indefinite"></animateMotion></circle>
    </g>`;
  }

  render() {
    if (!this.config) return html``;

    if (!this.hass) {
      return html`<ha-card><div class="not-found">Waiting for Home Assistant…</div></ha-card>`;
    }

    const missing = this._missingEntities();
    if (missing.length) {
      const prefix = this._prefix();
      const prefixSource = this.config.prefix
        ? "from config"
        : "auto-detected from climate entity";
      return html`
        <ha-card>
          <div class="not-found">
            <strong>ComfoAir card: missing entities</strong>
            <p>
              Expected sensors with prefix <code>${prefix}</code>
              (${prefixSource}). Set <code>prefix:</code> explicitly if
              auto-detection is wrong, or override individual entity IDs.
            </p>
            <ul>
              ${missing.map((id) => html`<li><code>${id}</code></li>`)}
            </ul>
            <p>Climate entity: <code>${this.config.entity}</code></p>
          </div>
        </ha-card>
      `;
    }

    const cfg = this.config;
    const ids = this._ids();
    const climate = this._state(ids.climate);
    const fanMode = climate?.attributes?.fan_mode;
    const fanModeLc = fanMode?.toLowerCase?.() ?? "";
    const setpoint = climate?.attributes?.temperature;
    const animated = cfg.animation === "animated";
    // Fixed scale by default: -20 °C → dark blue, 40 °C → red (auto only if requested)
    const scale = cfg.color_scale === "auto" ? "auto" : "fixed";
    const running = !!fanModeLc && fanModeLc !== "off";

    const t1 = this._numState(ids.outside);
    const t2 = this._numState(ids.exhaust);
    const t3 = this._numState(ids.returnTemp);
    const t4 = this._numState(ids.supply);
    const tmin = Number.isFinite(Number(cfg.temp_min))
      ? Number(cfg.temp_min)
      : DEFAULT_TEMP_MIN;
    const tmax = Number.isFinite(Number(cfg.temp_max))
      ? Number(cfg.temp_max)
      : DEFAULT_TEMP_MAX;
    const dom = tempDomain([t1, t2, t3, t4], scale, tmin, tmax);
    const [c1, c2, c3, c4] = [t1, t2, t3, t4].map((v) => tempColor(v, dom));

    let facSup = 1;
    let facExh = 1;
    if (animated) {
      const src = cfg.animation_speed_source === "level" ? "level" : "fixed";
      facSup = animSpeedFactor(src, cfg.animation_speed, this._numState(ids.supplyLevel));
      facExh = animSpeedFactor(src, cfg.animation_speed, this._numState(ids.returnLevel));
    }
    const durSup = (FLOW_BASE / facSup).toFixed(1);
    const durExh = (FLOW_BASE / facExh).toFixed(1);

    const bypassState = this._stateValue(ids.bypass, undefined);
    const recov =
      bypassState === "on" ? null : recoveryPct(t1, t3, t4);

    const filterChip = statusChip(
      "filter",
      this._stateValue(ids.filter, undefined)
    );
    filterChip.entityId = ids.filter;

    const errorChip = statusChip(
      "error",
      this._stateValue(ids.error, undefined)
    );
    errorChip.entityId = ids.error;

    const chips = [
      statusChip("fan", undefined, fanMode),
      filterChip,
      errorChip,
      statusChip("bypass", bypassState),
      statusChip("preheat", this._stateValue(ids.preheat, undefined)),
      statusChip("season", this._stateValue(ids.summer, undefined)),
    ];

    const tempBadge = (color, entityId) => {
      const stl = `--fg:${color};--bd:color-mix(in srgb, ${color} 45%, transparent);--bg:color-mix(in srgb, ${color} 14%, transparent)`;
      return html`<div
        class="tempbadge ${entityId ? "clickable" : ""}"
        style=${stl}
        @click=${() => this._moreInfo(entityId)}
        title=${entityId ? "Show history" : ""}
      >
        <span class="v">${this._stateValue(entityId)}</span
        ><span class="u">°C</span>
      </div>`;
    };

    const subRpm = (entityId, factor) => {
      const r = this._numState(entityId) ?? 0;
      const spin = animated && running && r > 0;
      const dur = SPIN_BASE / factor;
      return html`<div
        class="subt ${entityId ? "clickable" : ""}"
        @click=${() => this._moreInfo(entityId)}
      >
        <ha-icon
          class=${spin ? "spinico spin" : "spinico"}
          style=${spin ? `animation-duration:${dur.toFixed(2)}s` : ""}
          icon="mdi:fan"
        ></ha-icon>
        <span>${this._stateValue(entityId)}</span>&nbsp;rpm
      </div>`;
    };

    const subPct = (entityId) => html`<div
      class="subt ${entityId ? "clickable" : ""}"
      @click=${() => this._moreInfo(entityId)}
    >
      <ha-icon icon="mdi:gauge"></ha-icon
      ><span>${this._stateValue(entityId)}</span>&nbsp;%
    </div>`;

    const lbl = (icon, text, rev = false) =>
      html`<div class="lbl ${rev ? "rev" : ""}">
        <ha-icon icon=${icon}></ha-icon>${text}
      </div>`;

    const hub = html`
      <div class="hub corehub">
        <div class="setpc">
          <button @click=${() => this._stepTemp(-1)} aria-label="Cooler">−</button>
          <div class="val">
            ${setpoint != null ? setpoint : "—"}<small>°C</small>
          </div>
          <button @click=${() => this._stepTemp(1)} aria-label="Warmer">+</button>
        </div>
        <div class="fanrow">
          ${FAN_BUTTONS.map(
            (b) => html`<button
              class=${isFanModeActive(fanMode, b.mode) ? "on" : ""}
              title=${FAN_MODE_LABELS[b.mode] || b.mode}
              @click=${() => this._setFan(b.mode)}
            >
              <ha-icon icon=${b.icon}></ha-icon>
            </button>`
          )}
        </div>
      </div>
    `;

    const testModeOn =
      this._stateValue(ids.testMode, "off") === "on";

    return html`
      <ha-card class=${animated ? "animated" : ""}>
        <div class="hd">
          <div class="ic"><ha-icon icon="mdi:hvac"></ha-icon></div>
          <div>
            <div class="ttl">${cfg.name || "ComfoAir"}</div>
            <div class="st">
              <span class="dot ${running ? "live" : ""}"></span>
              <span
                >${fanModeLc
                  ? FAN_MODE_LABELS[fanModeLc] ?? fanMode
                  : "—"}</span
              >
            </div>
          </div>
          <div class="grow"></div>
          ${this._testModeEnabled()
            ? html`<button
                class="testbtn ${testModeOn ? "live" : ""}"
                title="Open test mode dialog"
                @click=${() => this._openTestDialog()}
              >
                <ha-icon icon="mdi:test-tube"></ha-icon>
              </button>`
            : ""}
          <div class="recov">
            ${recov != null
              ? html`<b>${recov}%</b><span>Recovery</span>`
              : ""}
          </div>
        </div>

        <div class="lanes">
          <div class="trow top">
            <div class="tcell l">
              ${subRpm(ids.intakeRpm, facSup)}${tempBadge(c1, ids.outside)}
              ${lbl("mdi:tree-outline", "Outside air")}
            </div>
            <div></div>
            <div class="tcell r">
              ${subPct(ids.returnLevel)}${tempBadge(c3, ids.returnTemp)}
              ${lbl("mdi:home-thermometer-outline", "Extract air", true)}
            </div>
          </div>

          <div class="flowband">
            <svg
              class="airsvg"
              viewBox="0 0 440 132"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <defs>
                <linearGradient
                  id="gSupply-${this._uid}"
                  x1="6"
                  y1="19"
                  x2="434"
                  y2="113"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stop-color=${c1}></stop>
                  <stop offset="100%" stop-color=${c4}></stop>
                </linearGradient>
                <linearGradient
                  id="gExhaust-${this._uid}"
                  x1="434"
                  y1="19"
                  x2="6"
                  y2="113"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stop-color=${c3}></stop>
                  <stop offset="100%" stop-color=${c2}></stop>
                </linearGradient>
                <filter
                  id="soft-${this._uid}"
                  x="-60%"
                  y="-60%"
                  width="220%"
                  height="220%"
                >
                  <feGaussianBlur stdDeviation="4.5"></feGaussianBlur>
                </filter>
              </defs>
              <path
                class="airrib"
                d=${SUPPLY_PATH}
                stroke="url(#gSupply-${this._uid})"
              ></path>
              <path
                class="airrib"
                d=${EXHAUST_PATH}
                stroke="url(#gExhaust-${this._uid})"
              ></path>
              <polygon class="airarrow" points="86,11 86,27 102,19"></polygon>
              <polygon class="airarrow" points="354,11 354,27 338,19"></polygon>
              <polygon class="airarrow" points="102,105 102,121 86,113"></polygon>
              <polygon class="airarrow" points="338,105 338,121 354,113"></polygon>
              ${animated && running ? this._flowGroup(durSup, durExh) : ""}
            </svg>
            ${hub}
          </div>

          <div class="trow bot">
            <div class="tcell l">
              ${lbl("mdi:export", "Exhaust air")}${tempBadge(c2, ids.exhaust)}
              ${subRpm(ids.exhaustRpm, facExh)}
            </div>
            <div></div>
            <div class="tcell r">
              ${lbl("mdi:import", "Supply air", true)}${tempBadge(c4, ids.supply)}
              ${subPct(ids.supplyLevel)}
            </div>
          </div>
        </div>

        ${cfg.show_legend
          ? html`<div class="legend">
              <span class="mn">${Math.round(dom[0])}°C</span>
              <div
                class="bar"
                style="background:linear-gradient(90deg, ${rampColor(0)}, ${rampColor(
                  0.25
                )}, ${rampColor(0.5)}, ${rampColor(0.75)}, ${rampColor(1)})"
              ></div>
              <span class="mx">${Math.round(dom[1])}°C</span>
            </div>`
          : ""}

        <div class="status">
          ${chips.map(
            (c) => html`<div
              class="chip ${c.active ? "on" : ""} ${c.action || c.entityId
                ? "clickable"
                : ""}"
              style="--c:${c.color}"
              title=${c.title || c.sub || c.label}
              @click=${() => this._onChipClick(c, ids)}
            >
              <ha-icon icon=${c.icon}></ha-icon>
              <span class="nm">${c.label}</span>
              ${c.sub
                ? html`<span class="vs" title=${c.sub}>${c.sub}</span>`
                : ""}
            </div>`
          )}
        </div>
        ${this._testModeEnabled() && this._testDialogOpen
          ? this._renderTestDialog(ids, testModeOn)
          : ""}
      </ha-card>
    `;
  }

  _renderTestDialog(ids, testModeOn) {
    const hasTestMode = !!this.hass?.states?.[ids.testMode];
    const hasSelfTest = !!this.hass?.states?.[ids.selfTest];
    const numVal = (id) => {
      const n = this._numState(id);
      return n == null ? 0 : n;
    };
    const flapVal = (id) => {
      const v = this._stateValue(id, "Closed");
      return FLAP_OPTIONS.includes(v) ? v : "Closed";
    };
    const swOn = (id) => this._stateValue(id, "off") === "on";

    return html`
      <div
        class="dlg-backdrop"
        @click=${(e) => {
          if (e.target === e.currentTarget) this._closeTestDialog();
        }}
        @keydown=${this._onTestDialogKey}
      >
        <div
          class="dlg"
          role="dialog"
          aria-modal="true"
          aria-label="ComfoAir test mode"
        >
          <div class="dlg-hd">
            <ha-icon icon="mdi:test-tube"></ha-icon>
            <div>
              <div class="dlg-ttl">Service / test mode</div>
              <div class="dlg-sub">
                Overrides normal operation. Exit when finished.
              </div>
            </div>
            <button class="dlg-x" @click=${() => this._closeTestDialog()} aria-label="Close">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>

          ${!hasTestMode
            ? html`<div class="dlg-warn">
                No <code>switch…_test_mode</code> entity found. Enable
                <code>enable_test_mode: true</code> on the ESPHome comfoair
                component and reflash.
              </div>`
            : ""}

          <section class="dlg-sec">
            <div class="dlg-row">
              <div>
                <div class="dlg-lab">PC test mode</div>
                <div class="dlg-hint">Enter (0x01) / exit (0x19)</div>
              </div>
              <label class="tgl ${!hasTestMode ? "dis" : ""}">
                <input
                  type="checkbox"
                  .checked=${testModeOn}
                  ?disabled=${!hasTestMode}
                  @change=${(e) =>
                    this._turnSwitch(ids.testMode, e.target.checked)}
                />
                <span>${testModeOn ? "On" : "Off"}</span>
              </label>
            </div>
            <div class="dlg-row">
              <div>
                <div class="dlg-lab">Self-test</div>
                <div class="dlg-hint">Unit self-test (0xDB)</div>
              </div>
              <button
                class="dlg-act"
                ?disabled=${!hasSelfTest}
                @click=${() => {
                  if (
                    window.confirm(
                      "Start the ventilation unit self-test? Fans and flaps will cycle."
                    )
                  ) {
                    this._pressButton(ids.selfTest);
                  }
                }}
              >
                Start
              </button>
            </div>
          </section>

          <section class="dlg-sec ${testModeOn ? "" : "dim"}">
            <div class="dlg-sec-ttl">Flaps ${testModeOn ? "" : "(enter test mode first)"}</div>
            ${[
              { id: ids.testBypassFlap, label: "Bypass" },
              { id: ids.testPreheatFlap, label: "Preheat" },
            ].map(
              (f) => html`<div class="dlg-row col">
                <div class="dlg-lab">${f.label}</div>
                <div class="seg">
                  ${FLAP_OPTIONS.map(
                    (opt) => html`<button
                      class=${flapVal(f.id) === opt ? "on" : ""}
                      ?disabled=${!testModeOn || !this.hass?.states?.[f.id]}
                      @click=${() => this._setSelect(f.id, opt)}
                    >
                      ${opt}
                    </button>`
                  )}
                </div>
              </div>`
            )}
          </section>

          <section class="dlg-sec ${testModeOn ? "" : "dim"}">
            <div class="dlg-sec-ttl">Fans / post-heat</div>
            ${[
              { id: ids.testSupplyFan, label: "Supply fan" },
              { id: ids.testExhaustFan, label: "Exhaust fan" },
              { id: ids.testPostheat, label: "Post-heat" },
            ].map(
              (n) => html`<div class="dlg-row col">
                <div class="dlg-lab">
                  ${n.label}
                  <span class="dlg-val">${numVal(n.id)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  .value=${String(numVal(n.id))}
                  ?disabled=${!testModeOn || !this.hass?.states?.[n.id]}
                  @change=${(e) => this._setNumber(n.id, e.target.value)}
                />
              </div>`
            )}
          </section>

          <section class="dlg-sec ${testModeOn ? "" : "dim"}">
            <div class="dlg-sec-ttl">Outputs / relays</div>
            <div class="dlg-grid">
              ${TEST_OUTPUT_SWITCHES.map((o) => {
                const id = ids[o.key];
                return html`<label
                  class="chipsw ${!testModeOn || !this.hass?.states?.[id]
                    ? "dis"
                    : ""}"
                >
                  <input
                    type="checkbox"
                    .checked=${swOn(id)}
                    ?disabled=${!testModeOn || !this.hass?.states?.[id]}
                    @change=${(e) => this._turnSwitch(id, e.target.checked)}
                  />
                  <span>${o.label}</span>
                </label>`;
              })}
            </div>
          </section>

          <div class="dlg-ft">
            <button class="dlg-act ghost" @click=${() => this._closeTestDialog()}>
              Close
            </button>
            ${testModeOn
              ? html`<button
                  class="dlg-act danger"
                  @click=${() => this._turnSwitch(ids.testMode, false)}
                >
                  Exit test mode
                </button>`
              : ""}
          </div>
        </div>
      </div>
    `;
  }

  static get styles() {
    return css`
      ha-card {
        padding: 14px 16px 12px;
        --arrow: rgba(255, 255, 255, 0.92);
      }
      .not-found {
        background-color: var(--warning-color, #fff3cd);
        color: var(--primary-text-color, #333);
        font-family: var(--paper-font-body1_-_font-family, sans-serif);
        font-size: 14px;
        padding: 12px 16px;
        line-height: 1.4;
      }
      .not-found ul {
        margin: 8px 0;
        padding-left: 1.2em;
        max-height: 160px;
        overflow: auto;
      }
      .not-found code {
        font-size: 12px;
      }

      .hd {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 2px 2px 12px;
      }
      .hd .ic {
        width: 34px;
        height: 34px;
        border-radius: 10px;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.14);
        color: var(--primary-color);
      }
      .hd .ttl {
        font-size: 15.5px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .hd .st {
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-top: 1px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hd .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--disabled-text-color, #777);
      }
      .hd .dot.live {
        background: #36c46b;
      }
      .hd .grow {
        flex: 1;
      }
      .hd .recov {
        text-align: right;
        line-height: 1.05;
        min-height: 30px;
      }
      .hd .recov b {
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .hd .recov span {
        display: block;
        font-size: 10px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--secondary-text-color);
        margin-top: 1px;
      }

      .tempbadge {
        display: inline-flex;
        align-items: baseline;
        justify-content: center;
        gap: 1px;
        width: 88px;
        padding: 3px 4px;
        border-radius: 10px;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        background: var(--bg);
        color: var(--fg);
        border: 1px solid var(--bd);
        box-shadow: 0 2px 10px -4px rgba(0, 0, 0, 0.5);
        transition: background 0.5s, color 0.5s, border-color 0.5s;
      }
      .tempbadge .v {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .tempbadge .u {
        font-size: 12px;
        font-weight: 600;
        opacity: 0.7;
      }
      .lbl {
        font-size: 9.5px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--secondary-text-color);
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .lbl.rev {
        flex-direction: row-reverse;
      }
      .lbl ha-icon {
        --mdc-icon-size: 14px;
      }
      .subt {
        font-size: 11px;
        color: var(--secondary-text-color);
        display: flex;
        align-items: center;
        gap: 4px;
        font-variant-numeric: tabular-nums;
      }
      .subt ha-icon {
        --mdc-icon-size: 15px;
        opacity: 0.85;
      }
      .clickable {
        cursor: pointer;
      }
      .tempbadge.clickable:hover {
        filter: brightness(1.08);
      }
      .subt.clickable:hover {
        color: var(--primary-text-color);
      }

      .corehub {
        background: var(--card-background-color);
        border: 1px solid var(--divider-color);
        border-radius: 15px;
        padding: 6px 9px;
        box-shadow: 0 6px 22px -6px rgba(0, 0, 0, 0.55);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
      }
      .setpc {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .setpc button {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 1px solid var(--divider-color);
        background: transparent;
        color: var(--primary-text-color);
        font-size: 15px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: 0.15s;
      }
      .setpc button:hover {
        border-color: var(--primary-color);
        color: var(--primary-color);
      }
      .setpc .val {
        min-width: 56px;
        text-align: center;
        font-size: 17px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      .setpc .val small {
        font-size: 11px;
        font-weight: 600;
        color: var(--secondary-text-color);
      }
      .fanrow {
        display: flex;
        gap: 2px;
        background: rgba(127, 127, 127, 0.14);
        border-radius: 11px;
        padding: 3px;
      }
      .fanrow button {
        width: 32px;
        height: 26px;
        border: 0;
        background: transparent;
        border-radius: 8px;
        color: var(--secondary-text-color);
        cursor: pointer;
        transition: 0.15s;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .fanrow button:hover {
        color: var(--primary-text-color);
      }
      .fanrow button.on {
        background: var(--primary-color);
        color: #fff;
        box-shadow: 0 2px 8px -2px var(--primary-color);
      }
      .fanrow ha-icon {
        --mdc-icon-size: 18px;
      }

      .lanes {
        display: flex;
        flex-direction: column;
        gap: 3px;
        --hub-w: 188px;
      }
      .trow {
        display: grid;
        grid-template-columns: 1fr var(--hub-w) 1fr;
        gap: 10px;
        padding: 0 6px;
      }
      .trow.top {
        align-items: end;
      }
      .trow.bot {
        align-items: start;
      }
      .tcell {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .tcell.l {
        align-items: flex-start;
      }
      .tcell.r {
        align-items: flex-end;
        text-align: right;
      }

      .flowband {
        position: relative;
        width: 100%;
        aspect-ratio: 440 / 132;
      }
      .airsvg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .airrib {
        fill: none;
        stroke-width: 38;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .airarrow {
        fill: var(--arrow);
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.28));
      }
      .flow-hi {
        opacity: 0.5;
      }
      .hub {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 4;
      }

      .spinico.spin {
        animation-name: spin;
        animation-timing-function: linear;
        animation-iteration-count: infinite;
        transform-origin: center;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .legend {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 8px 4px 2px;
      }
      .legend .bar {
        flex: 1;
        height: 7px;
        border-radius: 4px;
      }
      .legend .mn,
      .legend .mx {
        font-size: 11px;
        color: var(--secondary-text-color);
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        min-width: 44px;
      }
      .legend .mx {
        text-align: right;
      }

      .testbtn {
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--secondary-text-color);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 6px;
      }
      .testbtn:hover {
        color: var(--primary-text-color);
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      }
      .testbtn.live {
        color: #e53935;
        background: color-mix(in srgb, #e53935 14%, transparent);
      }
      .testbtn ha-icon {
        --mdc-icon-size: 22px;
      }

      .dlg-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .dlg {
        width: min(440px, 100%);
        max-height: min(90vh, 720px);
        overflow: auto;
        background: var(--card-background-color, var(--ha-card-background, #1c1c1c));
        color: var(--primary-text-color);
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
        padding: 14px 16px 12px;
      }
      .dlg-hd {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin-bottom: 12px;
      }
      .dlg-hd > ha-icon {
        --mdc-icon-size: 26px;
        color: var(--primary-color);
        margin-top: 2px;
      }
      .dlg-ttl {
        font-weight: 700;
        font-size: 16px;
      }
      .dlg-sub {
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-top: 2px;
      }
      .dlg-x {
        margin-left: auto;
        border: 0;
        background: transparent;
        color: var(--secondary-text-color);
        cursor: pointer;
        border-radius: 8px;
        padding: 4px;
      }
      .dlg-warn {
        background: color-mix(in srgb, #f5a623 16%, transparent);
        color: var(--primary-text-color);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 12.5px;
        margin-bottom: 12px;
        line-height: 1.4;
      }
      .dlg-sec {
        border-top: 1px solid var(--divider-color);
        padding: 10px 0 4px;
      }
      .dlg-sec.dim {
        opacity: 0.55;
      }
      .dlg-sec-ttl {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--secondary-text-color);
        margin-bottom: 8px;
      }
      .dlg-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .dlg-row.col {
        flex-direction: column;
        align-items: stretch;
      }
      .dlg-lab {
        font-size: 13.5px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .dlg-hint {
        font-size: 11px;
        color: var(--secondary-text-color);
      }
      .dlg-val {
        font-variant-numeric: tabular-nums;
        color: var(--secondary-text-color);
        font-weight: 600;
      }
      .dlg-act {
        border: 0;
        border-radius: 8px;
        padding: 7px 14px;
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
        font-weight: 600;
        cursor: pointer;
      }
      .dlg-act:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .dlg-act.ghost {
        background: transparent;
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color);
      }
      .dlg-act.danger {
        background: #e53935;
      }
      .tgl {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .tgl.dis {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .seg {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
      }
      .seg button {
        border: 1px solid var(--divider-color);
        background: transparent;
        color: var(--secondary-text-color);
        border-radius: 8px;
        padding: 6px 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      .seg button.on {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
        border-color: var(--primary-color);
      }
      .seg button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .dlg-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      .chipsw {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        padding: 6px 8px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--primary-color) 6%, transparent);
        cursor: pointer;
      }
      .chipsw.dis {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .dlg-ft {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
        padding-top: 10px;
        border-top: 1px solid var(--divider-color);
      }
      input[type="range"] {
        width: 100%;
      }

      .status {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 6px;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--divider-color);
      }
      .chip {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 7px 2px 4px;
        border-radius: 11px;
        color: var(--secondary-text-color);
        transition: 0.25s;
        min-width: 0;
      }
      .chip.clickable {
        cursor: pointer;
      }
      .chip.clickable:hover {
        background: color-mix(in srgb, var(--c, var(--primary-color)) 8%, transparent);
      }
      .chip ha-icon {
        --mdc-icon-size: 23px;
        transition: 0.25s;
      }
      .chip .nm {
        font-size: 10.5px;
        font-weight: 600;
      }
      .chip .vs {
        font-size: 9px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--secondary-text-color);
        opacity: 0.65;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 2px;
      }
      .chip.on {
        color: var(--c);
        background: color-mix(in srgb, var(--c) 12%, transparent);
      }
      .chip.on .vs {
        color: var(--c);
        opacity: 0.9;
        text-transform: none;
        letter-spacing: 0;
      }
      .chip.on ha-icon {
        filter: drop-shadow(0 0 7px var(--c));
      }
      @media (max-width: 420px) {
        .status {
          grid-template-columns: repeat(3, 1fr);
        }
      }
    `;
  }
}

/** Fire a Lovelace config-changed (or similar) event without custom-card-helpers. */
function fireEvent(node, type, detail = {}) {
  node.dispatchEvent(
    new CustomEvent(type, {
      detail,
      bubbles: true,
      composed: true,
    })
  );
}

/** Config keys that override auto-built entity IDs (cleared when climate entity changes). */
const ENTITY_OVERRIDE_KEYS = [
  "prefix",
  "outside_air_temperature",
  "exhaust_air_temperature",
  "return_air_temperature",
  "supply_air_temperature",
  "intake_fan_speed_rpm",
  "exhaust_fan_speed_rpm",
  "return_air_level",
  "supply_air_level",
  "filter_status",
  "error_status",
  "filter_reset",
  "error_reset",
  "bypass_valve_open",
  "preheating_state",
  "summer_mode",
  "tempSensor1",
  "tempSensor2",
  "tempSensor3",
  "tempSensor4",
  "fan_speed_supply",
  "fan_speed_exhaust",
  "filterstatus",
  "bypass_valve",
  "preheat",
];

/**
 * Visual card editor (Dashboard → Edit → ComfoAir Card).
 * Uses HA's ha-form; auto-fills prefix when the climate entity changes.
 */
class ComfoAirCardEditor extends LitElement {
  static get properties() {
    return {
      hass: {},
      _config: {},
      _detectedPrefix: { type: String },
    };
  }

  setConfig(config) {
    this._config = { ...config };
    this._detectedPrefix = "";
  }

  _label = (schemaItem) => {
    const labels = {
      entity: "Climate entity (required)",
      name: "Name",
      prefix: "Entity prefix",
      animation: "Animation",
      animation_speed_source: "Animation speed source",
      animation_speed: "Fixed animation speed (%)",
      color_scale: "Color scale",
      temp_min: "Fixed scale min (°C)",
      temp_max: "Fixed scale max (°C)",
      show_legend: "Show temperature legend",
      enable_test_mode: "Enable test mode UI",
      outside_air_temperature: "Outside air temperature",
      exhaust_air_temperature: "Exhaust air temperature",
      return_air_temperature: "Extract / return air temperature",
      supply_air_temperature: "Supply air temperature",
      intake_fan_speed_rpm: "Intake fan speed (rpm)",
      exhaust_fan_speed_rpm: "Exhaust fan speed (rpm)",
      return_air_level: "Return air level (%)",
      supply_air_level: "Supply air level (%)",
      filter_status: "Filter status",
      error_status: "Error status",
      filter_reset: "Filter reset button",
      error_reset: "Error reset button",
      bypass_valve_open: "Bypass valve",
      preheating_state: "Preheat",
      summer_mode: "Summer mode",
    };
    return labels[schemaItem.name] || schemaItem.name;
  };

  _mainSchema() {
    const cfg = this._config || {};
    const schema = [
      {
        name: "entity",
        required: true,
        selector: { entity: { domain: "climate" } },
      },
      { name: "name", selector: { text: {} } },
      {
        name: "animation",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "static", label: "Static" },
              { value: "animated", label: "Animated (flows + fans)" },
            ],
          },
        },
      },
    ];

    if (cfg.animation === "animated") {
      schema.push({
        name: "animation_speed_source",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "fixed", label: "Fixed speed (%)" },
              { value: "level", label: "From supply/return air level" },
            ],
          },
        },
      });
      if (cfg.animation_speed_source !== "level") {
        schema.push({
          name: "animation_speed",
          selector: {
            number: {
              min: 10,
              max: 200,
              step: 10,
              unit_of_measurement: "%",
              mode: "slider",
            },
          },
        });
      }
    }

    schema.push({
      name: "color_scale",
      selector: {
        select: {
          mode: "dropdown",
          options: [
            { value: "fixed", label: "Fixed range (min/max)" },
            { value: "auto", label: "Auto (stretch to current temps)" },
          ],
        },
      },
    });

    if (cfg.color_scale !== "auto") {
      schema.push(
        {
          name: "temp_min",
          selector: {
            number: {
              min: -40,
              max: 20,
              step: 1,
              unit_of_measurement: "°C",
              mode: "box",
            },
          },
        },
        {
          name: "temp_max",
          selector: {
            number: {
              min: 0,
              max: 60,
              step: 1,
              unit_of_measurement: "°C",
              mode: "box",
            },
          },
        }
      );
    }

    schema.push({ name: "show_legend", selector: { boolean: {} } });
    schema.push({ name: "enable_test_mode", selector: { boolean: {} } });
    return schema;
  }

  _advancedSchema() {
    return [
      {
        name: "prefix",
        selector: { text: {} },
      },
      {
        name: "outside_air_temperature",
        selector: { entity: { domain: "sensor", device_class: "temperature" } },
      },
      {
        name: "exhaust_air_temperature",
        selector: { entity: { domain: "sensor", device_class: "temperature" } },
      },
      {
        name: "return_air_temperature",
        selector: { entity: { domain: "sensor", device_class: "temperature" } },
      },
      {
        name: "supply_air_temperature",
        selector: { entity: { domain: "sensor", device_class: "temperature" } },
      },
      {
        name: "intake_fan_speed_rpm",
        selector: { entity: { domain: "sensor" } },
      },
      {
        name: "exhaust_fan_speed_rpm",
        selector: { entity: { domain: "sensor" } },
      },
      {
        name: "return_air_level",
        selector: { entity: { domain: "sensor" } },
      },
      {
        name: "supply_air_level",
        selector: { entity: { domain: "sensor" } },
      },
      {
        name: "filter_status",
        selector: { entity: { domain: ["sensor", "binary_sensor"] } },
      },
      {
        name: "error_status",
        selector: { entity: { domain: "sensor" } },
      },
      {
        name: "filter_reset",
        selector: { entity: { domain: "button" } },
      },
      {
        name: "error_reset",
        selector: { entity: { domain: "button" } },
      },
      {
        name: "bypass_valve_open",
        selector: { entity: { domain: "binary_sensor" } },
      },
      {
        name: "preheating_state",
        selector: { entity: { domain: "binary_sensor" } },
      },
      {
        name: "summer_mode",
        selector: { entity: { domain: "binary_sensor" } },
      },
    ];
  }

  render() {
    if (!this.hass || !this._config) {
      return html``;
    }

    const hintPrefix =
      this._detectedPrefix ||
      resolvePrefix(this.hass, this._config.entity, this._config.prefix);

    return html`
      <div class="editor">
        <ha-form
          .hass=${this.hass}
          .data=${this._config}
          .schema=${this._mainSchema()}
          .computeLabel=${this._label}
          @value-changed=${this._mainChanged}
        ></ha-form>
        ${this._config.entity
          ? html`<div class="hint">
              Sensor prefix:
              <code>${hintPrefix}</code>
              ${this._config.prefix
                ? "(from config)"
                : "(auto-detected — override under Advanced)"}
            </div>`
          : ""}
        <ha-expansion-panel outlined>
          <span slot="header">Advanced / entity overrides</span>
          <ha-form
            .hass=${this.hass}
            .data=${this._config}
            .schema=${this._advancedSchema()}
            .computeLabel=${this._label}
            @value-changed=${this._advancedChanged}
          ></ha-form>
        </ha-expansion-panel>
      </div>
    `;
  }

  _mainChanged(ev) {
    ev.stopPropagation();
    const value = ev.detail?.value || {};
    const newEntity = value.entity || "";
    const entityChanged = !!newEntity && newEntity !== this._config.entity;

    let next = { ...this._config, ...value };

    if (entityChanged) {
      // Drop previous device's overrides, then fill a fresh auto prefix
      for (const key of ENTITY_OVERRIDE_KEYS) {
        delete next[key];
      }
      const detected = resolvePrefix(this.hass, newEntity, undefined);
      next.entity = newEntity;
      next.prefix = detected;
      this._detectedPrefix = detected;
    }

    this._emit(next);
  }

  _advancedChanged(ev) {
    ev.stopPropagation();
    const value = ev.detail?.value || {};
    // Empty string prefix → treat as cleared (re-enable auto-detect)
    if (Object.prototype.hasOwnProperty.call(value, "prefix") && value.prefix === "") {
      const next = { ...this._config, ...value };
      delete next.prefix;
      this._detectedPrefix = resolvePrefix(this.hass, next.entity, undefined);
      this._emit(next);
      return;
    }
    this._emit({ ...this._config, ...value });
  }

  _emit(config) {
    this._config = config;
    fireEvent(this, "config-changed", { config });
  }

  static get styles() {
    return css`
      .editor {
        padding: 4px 0;
      }
      .hint {
        color: var(--secondary-text-color);
        padding: 6px 0 10px;
        font-size: 0.9em;
      }
      .hint code {
        font-size: 0.95em;
        color: var(--primary-text-color);
      }
      ha-form {
        display: block;
      }
      ha-expansion-panel {
        margin-top: 8px;
      }
    `;
  }
}

customElements.define("comfoair-card", ComfoAirCard);
customElements.define("comfoair-card-editor", ComfoAirCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "comfoair-card",
  name: "ComfoAir Card",
  preview: false,
  description:
    "Visualize and control a Zehnder ComfoAir unit (esphome-comfoair).",
});
