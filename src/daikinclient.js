// Daikin HTTP Client and Control Formatting
// Part of homebridge-daikin-accfactory
//
// Acquires key/value responses from Daikin's local HTTP API and formats the
// complete control requests required by /aircon/set_control_info.
//
// Responsibilities:
// - Parse Daikin responses and validate their return status
// - Normalise MAC addresses for stable physical-system identity
// - Use the configured HTTP port and shared fetch wrapper for bounded requests
// - Merge partial HomeKit changes into a complete six-field control request
// - Keep the latest Daikin snapshot and translate it for the accessory
//
// Notes:
// - Daikin values can contain an equals sign or percent-encoded text
// - Network tests replace the fetch boundary for deterministic results
//
// Code version 2026.10.22
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { URL, URLSearchParams } from 'node:url';

// Import our modules
import { fetchWrapper } from './fetchWrapper.js';
import { TEMPERATURE_DEFAULTS } from './config.js';

const CONTROL_FIELDS = ['pow', 'mode', 'stemp', 'shum', 'f_rate', 'f_dir'];

// Own one physical system's HTTP endpoint and protocol-shaped state. The
// platform manages lifecycle; no Daikin response fields need mapping there.
export default class DaikinClient {
  #failedPolls = 0;

  constructor(system, httpPort = 80) {
    this.system = system;
    this.httpPort = httpPort;
    this.info = undefined;
    this.control = undefined;
    this.sensor = undefined;
    this.online = false;
  }

  setAddress(system, httpPort) {
    // Discovery may find a new address for the same stable MAC identity.
    this.system = system;
    this.httpPort = httpPort;
  }

  async request(path) {
    let host = typeof this.system === 'string' ? this.system.trim() : '';
    if (host === '' || /[\s/@?#]/.test(host) === true) {
      throw new TypeError('Invalid Daikin host');
    }
    if (Number.isInteger(this.httpPort) === false || this.httpPort < 1 || this.httpPort > 65535) {
      throw new TypeError('Invalid Daikin HTTP port');
    }
    let url = new URL(path, 'http://' + host);
    url.port = String(this.httpPort);
    // The shared wrapper bounds/retries HTTP requests. A Daikin ret error is checked
    // after HTTP succeeds and must not repeat an accepted transport request.
    // A lost command response does not prove the unit rejected the write.
    // Retry reads, but never replay a control request automatically.
    let retry = url.pathname === '/aircon/set_control_info' ? 1 : 2;
    let response = await fetchWrapper('get', url.href, { timeout: 3000, retry });
    let body = await response.text();
    if (typeof body !== 'string') {
      throw new TypeError('Invalid Daikin response');
    }
    let values = {};
    for (let pair of body.trim().split(',')) {
      // Values may contain another equals sign, so split at the first one.
      let divider = pair.indexOf('=');
      if (divider < 1) {
        continue;
      }
      let key = pair.slice(0, divider).trim();
      if (['__proto__', 'constructor', 'prototype'].includes(key) === true) {
        continue;
      }
      let value = pair.slice(divider + 1);
      try {
        values[key] = decodeURIComponent(value);
      } catch {
        values[key] = value;
      }
    }
    if (values.ret === undefined) {
      throw new TypeError('Invalid Daikin response: missing return status');
    }
    if (values.ret !== 'OK') {
      throw new Error('Daikin API returned ' + values.ret);
    }
    return values;
  }

  async identify() {
    let info = await this.request('/common/basic_info');
    // Firmware varies separator and letter case; twelve hex digits are stable.
    let rawMac = typeof info.mac === 'string' ? info.mac.trim() : '';
    let validMac = /^(?:[a-f0-9]{12}|(?:[a-f0-9]{2}:){5}[a-f0-9]{2}|(?:[a-f0-9]{2}-){5}[a-f0-9]{2})$/i.test(rawMac);
    let mac = validMac === true ? rawMac.replace(/[:-]/g, '').toUpperCase() : '';
    if (mac.length === 12) {
      this.info = info;
      this.mac = mac;
      return mac;
    }
    return;
  }

  async poll() {
    // Publish a pair only after both requests succeed; preserve the previous
    // snapshot when a poll is incomplete, including during the offline grace poll.
    try {
      let [control, sensor] = await Promise.all([this.request('/aircon/get_control_info'), this.request('/aircon/get_sensor_info')]);
      // HTTP success alone does not establish a usable state snapshot. Missing
      // sensor values such as '--' are valid, but a missing sensor field is not.
      if (
        CONTROL_FIELDS.some((field) => control[field] === undefined || control[field] === null || control[field] === '') === true ||
        ['0', '1'].includes(String(control.pow)) === false ||
        ['0', '1', '2', '3', '4', '6', '7'].includes(String(control.mode)) === false ||
        sensor.htemp === undefined
      ) {
        throw new TypeError('Incomplete Daikin status response');
      }
      this.control = control;
      this.sensor = sensor;
      this.#failedPolls = 0;
      this.online = true;
    } catch (error) {
      // A single failed poll must not flap an established accessory offline.
      // Keep startup offline until a complete snapshot succeeds, and continue
      // rejecting failures so the platform retains its debug diagnostics.
      this.#failedPolls = Math.min(this.#failedPolls + 1, 2);
      if (this.#failedPolls === 2) {
        this.online = false;
      }
      throw error;
    }
  }

  set(changes, settings = undefined) {
    // Power-off still needs all six fields from the latest control snapshot.
    let state = { ...this.control, ...changes };
    if (changes.mode !== undefined) {
      // Resolve mode memory here, when the serialized write actually runs,
      // rather than capturing stale accessory values in a HomeKit handler.
      let mode = Number(changes.mode);
      if ([3, 4, 7].includes(mode) === true) {
        let prefix = mode === 3 ? 'cooling' : mode === 4 ? 'heating' : 'auto';
        let minimum = settings?.[prefix + 'Min'] ?? TEMPERATURE_DEFAULTS[prefix + 'Min'];
        let maximum = settings?.[prefix + 'Max'] ?? TEMPERATURE_DEFAULTS[prefix + 'Max'];
        let target = Number(changes.stemp ?? this.control?.['dt' + mode] ?? 24);
        state.stemp = Math.min(maximum, Math.max(minimum, target));
      } else {
        state.stemp = mode === 6 ? '--' : 'M';
      }
      state.shum = changes.shum ?? (mode === 2 ? (this.control?.dh2 ?? 50) : mode === 6 ? '--' : 0);
      state.f_rate = changes.f_rate ?? this.control?.['dfr' + mode] ?? 'A';
      state.f_dir = changes.f_dir ?? this.control?.['dfd' + mode] ?? 3;
    }
    let required = CONTROL_FIELDS;
    if (required.some((field) => state[field] === undefined || state[field] === null) === true) {
      throw new TypeError('Incomplete Daikin control state');
    }
    let query = new URLSearchParams(required.map((field) => [field, String(state[field])]));
    return this.request('/aircon/set_control_info?' + query.toString()).then((result) => {
      // Preserve accepted changes if the following poll fails. Failed writes
      // must leave the previous snapshot untouched.
      let accepted = Object.fromEntries(required.map((field) => [field, String(state[field])]));
      let mode = accepted.mode;
      this.control = {
        ...state,
        ...accepted,
        ['dfr' + mode]: accepted.f_rate,
        ['dfd' + mode]: accepted.f_dir,
      };
      if (['3', '4', '7'].includes(mode) === true) {
        this.control['dt' + mode] = accepted.stemp;
      }
      if (mode === '2') {
        this.control.dh2 = accepted.shum;
      }
      return result;
    });
  }

  deviceData({ name, exclude } = {}) {
    // Convert Daikin's string-valued response to the stable accessory contract.
    // Identity/display overrides are supplied by the platform configuration.
    if (this.info === undefined || this.control === undefined || this.sensor === undefined || this.mac === undefined) {
      return;
    }

    let control = this.control;
    let sensor = this.sensor;
    return {
      serialNumber: this.mac,
      manufacturer: 'Daikin',
      description: name || this.info.name || 'Daikin Air Conditioner',
      model: this.info.model || 'Airconditioner',
      softwareVersion: typeof this.info.ver === 'string' ? this.info.ver.replaceAll('_', '.') : '0.0.0',
      online: this.online === true,
      excluded: exclude === true,
      pow:
        ((typeof control.pow === 'string' && control.pow.trim() !== '') || typeof control.pow === 'number') &&
        Number.isFinite(Number(control.pow)) === true
          ? Number(control.pow)
          : undefined,
      mode:
        ((typeof control.mode === 'string' && control.mode.trim() !== '') || typeof control.mode === 'number') &&
        Number.isFinite(Number(control.mode)) === true
          ? Number(control.mode)
          : 7,
      htemp:
        ((typeof sensor.htemp === 'string' && sensor.htemp.trim() !== '') || typeof sensor.htemp === 'number') &&
        Number.isFinite(Number(sensor.htemp)) === true
          ? Number(sensor.htemp)
          : undefined,
      hhum:
        ((typeof sensor.hhum === 'string' && sensor.hhum.trim() !== '') || typeof sensor.hhum === 'number') &&
        Number.isFinite(Number(sensor.hhum)) === true
          ? Number(sensor.hhum)
          : undefined,
      otemp:
        ((typeof sensor.otemp === 'string' && sensor.otemp.trim() !== '') || typeof sensor.otemp === 'number') &&
        Number.isFinite(Number(sensor.otemp)) === true
          ? Number(sensor.otemp)
          : undefined,
      dt7:
        ((typeof control.dt7 === 'string' && control.dt7.trim() !== '') || typeof control.dt7 === 'number') &&
        Number.isFinite(Number(control.dt7)) === true
          ? Number(control.dt7)
          : 24,
      dt3:
        ((typeof control.dt3 === 'string' && control.dt3.trim() !== '') || typeof control.dt3 === 'number') &&
        Number.isFinite(Number(control.dt3)) === true
          ? Number(control.dt3)
          : 24,
      dt4:
        ((typeof control.dt4 === 'string' && control.dt4.trim() !== '') || typeof control.dt4 === 'number') &&
        Number.isFinite(Number(control.dt4)) === true
          ? Number(control.dt4)
          : 24,
      dh2:
        ((typeof control.dh2 === 'string' && control.dh2.trim() !== '') || typeof control.dh2 === 'number') &&
        Number.isFinite(Number(control.dh2)) === true
          ? Number(control.dh2)
          : 50,
      dfr7: control.dfr7,
      dfr2: control.dfr2,
      dfr3: control.dfr3,
      dfr4: control.dfr4,
      dfr6: control.dfr6,
      dfd7:
        ((typeof control.dfd7 === 'string' && control.dfd7.trim() !== '') || typeof control.dfd7 === 'number') &&
        Number.isFinite(Number(control.dfd7)) === true
          ? Number(control.dfd7)
          : undefined,
      dfd2:
        ((typeof control.dfd2 === 'string' && control.dfd2.trim() !== '') || typeof control.dfd2 === 'number') &&
        Number.isFinite(Number(control.dfd2)) === true
          ? Number(control.dfd2)
          : undefined,
      dfd3:
        ((typeof control.dfd3 === 'string' && control.dfd3.trim() !== '') || typeof control.dfd3 === 'number') &&
        Number.isFinite(Number(control.dfd3)) === true
          ? Number(control.dfd3)
          : undefined,
      dfd4:
        ((typeof control.dfd4 === 'string' && control.dfd4.trim() !== '') || typeof control.dfd4 === 'number') &&
        Number.isFinite(Number(control.dfd4)) === true
          ? Number(control.dfd4)
          : undefined,
      dfd6:
        ((typeof control.dfd6 === 'string' && control.dfd6.trim() !== '') || typeof control.dfd6 === 'number') &&
        Number.isFinite(Number(control.dfd6)) === true
          ? Number(control.dfd6)
          : undefined,
    };
  }
}
