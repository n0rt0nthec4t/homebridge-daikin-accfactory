// Configuration Processing
// Part of homebridge-daikin-accfactory
//
// Validates user configuration and applies defaults before the platform opens
// sockets, performs HTTP requests, or creates accessories.
//
// Responsibilities:
// - Apply discovery, HTTP port, polling, and outdoor-sensor defaults
// - Bound configured discovery and polling intervals
// - Normalise manual system names, host addresses, port overrides, and exclusions
// - Warn when configuration cannot yield any systems
//
// Code version 2026.10.07
// Mark Hulskamp
'use strict';

// Default setpoint limits shared by configuration validation and HomeKit setup.
const TEMPERATURE_DEFAULTS = {
  coolingMin: 18,
  coolingMax: 32,
  heatingMin: 10,
  heatingMax: 30,
  autoMin: 18,
  autoMax: 30,
};

function processConfig(config = {}, log = undefined) {
  // Normalize the supplied configuration in place, matching Nest's processor.
  if (config?.constructor !== Object) {
    config = {};
  }

  let options = (config.options = config.options?.constructor === Object ? config.options : {});
  options.autoDiscover = options?.autoDiscover !== false; // Default to true if not explicitly set to false
  options.eveHistory = config.options?.eveHistory !== false; // Default to true if not explicitly set to false
  options.exclude = config.options?.exclude === true; // Default to false if not explicitly set to true
  options.httpPort =
    Number.isInteger(options?.httpPort) === true && options.httpPort >= 1 && options.httpPort <= 65535 ? options.httpPort : 80;
  options.discoveryInterval =
    Number.isInteger(options?.discoveryInterval) === true ? Math.min(3600, Math.max(30, options.discoveryInterval)) : 60;
  options.pollInterval = Number.isInteger(options.pollInterval) === true ? Math.min(300, Math.max(5, options.pollInterval)) : 15;

  // Process per device configuration(s)
  if (config?.devices === undefined) {
    config.devices = [];
  }

  config.devices = config.devices.filter(
    (device) => device?.constructor === Object && typeof device?.system === 'string' && device.system.trim() !== '',
  );

  for (let device of config.devices) {
    device.system = device.system.trim();
    device.name = typeof device?.name === 'string' && device.name.trim() !== '' ? device.name.trim() : undefined;
    device.httpPort =
      Number.isInteger(device.httpPort) === true && device.httpPort >= 1 && device.httpPort <= 65535 ? device.httpPort : undefined;
    device.exclude = device.exclude === true;
    device.eveHistory = typeof device?.eveHistory === 'boolean' ? device.eveHistory : undefined;
    device.externalSensor = typeof device?.externalSensor === 'boolean' ? device.externalSensor : undefined;

    // Omitted bounds retain defaults. Validate the effective pair so a single
    // override cannot invert the range against its default partner.
    for (let mode of ['cooling', 'heating', 'auto']) {
      let minKey = mode + 'Min';
      let maxKey = mode + 'Max';
      for (let key of [minKey, maxKey]) {
        let value = device[key];
        device[key] = Number.isInteger(value) === true && value >= 0 && value <= 100 ? value : TEMPERATURE_DEFAULTS[key];
        if (value !== undefined && device[key] !== value) {
          log?.warn?.('Ignoring invalid %s temperature override for Daikin system "%s"', key, device.system);
        }
      }
      if (device[minKey] >= device[maxKey]) {
        log?.warn?.('Ignoring invalid %s temperature range for Daikin system "%s": minimum must be below maximum', mode, device.system);
        device[minKey] = TEMPERATURE_DEFAULTS[minKey];
        device[maxKey] = TEMPERATURE_DEFAULTS[maxKey];
      }
    }
  }

  // Manual-only mode needs at least one usable address.
  if (options.autoDiscover === false && config.devices.length === 0) {
    log?.warn?.('Automatic discovery is disabled and no Daikin systems are configured');
  }
  return config;
}

// Define exports
export { processConfig, TEMPERATURE_DEFAULTS };
