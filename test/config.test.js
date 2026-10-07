import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { processConfig, TEMPERATURE_DEFAULTS } from '../dist/config.js';

test('configuration defaults and manual entries are normalised in place', () => {
  let source = { options: { autoDiscover: false, pollInterval: 1 }, devices: [{ system: ' 10.0.0.2 ', exclude: true }, { system: '' }] };
  let result = processConfig(source);
  assert.equal(result.options.autoDiscover, false);
  assert.equal(result.options.pollInterval, 5);
  assert.equal(result.options.httpPort, 80);
  assert.equal(result.options.eveHistory, true);
  assert.deepEqual(result.devices, [
    {
      system: '10.0.0.2',
      name: undefined,
      httpPort: undefined,
      exclude: true,
      eveHistory: undefined,
      externalSensor: undefined,
      ...TEMPERATURE_DEFAULTS,
    },
  ]);
  assert.equal(result, source);
  assert.equal(source.devices[0].system, '10.0.0.2');
});

test('HTTP ports accept valid platform and per-system overrides', () => {
  let result = processConfig({ options: { httpPort: 8080 }, devices: [{ system: '10.0.0.2', httpPort: 9090 }] });
  assert.equal(result.options.httpPort, 8080);
  assert.equal(result.devices[0].httpPort, 9090);
  let invalid = processConfig({ options: { httpPort: 70000 }, devices: [{ system: '10.0.0.2', httpPort: 0 }] });
  assert.equal(invalid.options.httpPort, 80);
  assert.equal(invalid.devices[0].httpPort, undefined);
});

test('manual mode without systems warns', () => {
  let warnings = [];
  processConfig({ options: { autoDiscover: false } }, { warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
});

test('per-device temperature ranges accept complete and partial overrides in place', () => {
  let source = {
    devices: [{ system: '10.0.0.2', coolingMin: 16, coolingMax: 34, heatingMin: 8, heatingMax: 32, autoMin: 17, autoMax: 31 }],
  };
  let originalDevice = source.devices[0];
  let device = processConfig(source).devices[0];
  for (let key of Object.keys(TEMPERATURE_DEFAULTS)) {
    assert.equal(device[key], source.devices[0][key]);
  }
  assert.equal(device, originalDevice);
  let partial = processConfig({ devices: [{ system: '10.0.0.3', coolingMin: 16 }] }).devices[0];
  assert.equal(partial.coolingMin, 16);
  assert.equal(partial.coolingMax, 32);
  assert.equal(partial.heatingMin, 10);
});

test('invalid temperature bounds and inverted effective ranges warn and retain defaults', () => {
  let warnings = [];
  for (let overrides of [
    { coolingMin: 32 },
    { coolingMax: 18 },
    { heatingMin: 30, heatingMax: 20 },
    { autoMin: -1, autoMax: 101 },
    { coolingMin: '16', heatingMax: 30.5 },
  ]) {
    let device = processConfig({ devices: [{ system: '10.0.0.2', ...overrides }] }, { warn: (...args) => warnings.push(args) }).devices[0];
    for (let key of Object.keys(TEMPERATURE_DEFAULTS)) {
      assert.equal(device[key], TEMPERATURE_DEFAULTS[key]);
    }
  }
  assert.equal(warnings.length > 0, true);
});

test('configuration schema exposes optional temperature overrides only on device entries', () => {
  let schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  let properties = schema.schema.properties.devices.items.properties;
  // Array entry controls are direct children, matching the sibling plugin layouts.
  let deviceFields = schema.layout[0].items.find((item) => item.key === 'devices').items;
  for (let key of Object.keys(TEMPERATURE_DEFAULTS)) {
    assert.equal(properties[key].type, 'integer');
    assert.equal(properties[key].minimum, 0);
    assert.equal(properties[key].maximum, 100);
    assert.equal(properties[key].default, undefined);
    assert.equal(schema.schema.properties.options.properties[key], undefined);
    assert.equal(
      deviceFields.some((item) => item.key === 'devices[].' + key),
      true,
    );
  }
});

test('per-device outdoor sensor overrides preserve explicit booleans and inherit when omitted or invalid', () => {
  let result = processConfig({
    options: { externalSensor: true },
    devices: [
      { system: '10.0.0.2', externalSensor: false },
      { system: '10.0.0.3', externalSensor: true },
      { system: '10.0.0.4' },
      { system: '10.0.0.5', externalSensor: 'false' },
    ],
  });
  assert.deepEqual(
    result.devices.map((device) => device.externalSensor),
    [false, true, undefined, undefined],
  );
  let schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.schema.properties.devices.items.properties.externalSensor.type, 'boolean');
  assert.equal(schema.schema.properties.devices.items.properties.externalSensor.default, undefined);
  let devices = schema.layout[0].items.find((item) => item.key === 'devices');
  assert.equal(
    devices.items.some((item) => item.key === 'devices[].externalSensor'),
    true,
  );
});

test('configuration processing retains platform, option, and device fields like Nest', () => {
  let options = { httpPort: 8080, extraOption: 'keep' };
  let device = { system: ' 10.0.0.2 ', name: ' Living Room ', extraDevice: 'keep' };
  let source = { name: 'Daikin', options, devices: [device], extraPlatform: 'keep' };
  let result = processConfig(source);
  assert.equal(result, source);
  assert.equal(result.options, options);
  assert.equal(result.devices[0], device);
  assert.equal(result.extraPlatform, 'keep');
  assert.equal(result.options.extraOption, 'keep');
  assert.equal(device.extraDevice, 'keep');
  assert.equal(device.name, 'Living Room');
});

test('invalid configuration containers and placeholder rows normalize safely', () => {
  for (let source of [undefined, null, [], 'invalid']) {
    let result = processConfig(source);
    assert.deepEqual(result.devices, []);
    assert.equal(result.options.httpPort, 80);
  }
  let result = processConfig({ options: null, devices: [null, {}, { system: ' ' }, { system: 123 }, { system: '10.0.0.2' }] });
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].system, '10.0.0.2');
  assert.equal(result.options.autoDiscover, true);
});
