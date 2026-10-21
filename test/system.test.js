// Homebridge publication, command, recovery, and shutdown regression tests
// Part of homebridge-daikin-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';
import { URLSearchParams } from 'node:url';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import timers from 'node:timers';
import { mockBuiltin, mockDaikin } from './helpers.js';
import * as hap from '@homebridge/hap-nodejs';

import HomeKitDevice from '../dist/HomeKitDevice.js';
import HomeKitHistory from '../dist/HomeKitHistory.js';
import DaikinAccfactory from '../dist/system.js';
import Airconditioner from '../dist/airconditioner.js';

function setup(context, fetchDaikin, config = { options: { autoDiscover: false }, devices: [{ system: '10.0.0.2' }] }) {
  mockDaikin(context, fetchDaikin);
  let events = new Map();
  let registered = [];
  let externallyPublished = [];
  let removed = [];
  let api = {
    hap,
    version: 2,
    platformAccessory: class extends hap.Accessory {
      constructor(name, uuid, category) {
        super(name, uuid);
        this.category = category;
      }
    },
    on(event, callback) {
      events.set(event, [...(events.get(event) ?? []), callback]);
    },
    publishExternalAccessories(_plugin, accessories) {
      externallyPublished.push(...accessories);
    },
    registerPlatformAccessories(_plugin, platform, accessories) {
      for (let accessory of accessories) {
        accessory._associatedPlatform = platform;
      }
      registered.push(...accessories);
    },
    unregisterPlatformAccessories(_plugin, _platform, accessories) {
      removed.push(...accessories);
    },
    updatePlatformAccessories() {},
  };
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  HomeKitDevice.PLUGIN_NAME = 'homebridge-daikin-accfactory';
  HomeKitDevice.PLATFORM_NAME = 'DaikinAccfactory';
  HomeKitDevice.EVEHOME = HomeKitHistory;
  let platform = new DaikinAccfactory(log, config, api);
  return { events, registered, externallyPublished, removed, platform };
}

function snapshot(_system, path, mac = 'AA:BB:CC:DD:EE:FF') {
  if (path === '/common/basic_info') {
    return { ret: 'OK', mac, name: 'Living Room', ver: '1_2_3' };
  }
  if (path === '/aircon/get_control_info') {
    return {
      ret: 'OK',
      pow: '1',
      mode: '3',
      stemp: '24',
      shum: '0',
      f_rate: 'A',
      f_dir: '3',
      dt3: '24',
      dt4: '22',
      dt7: '23',
      dh2: '50',
      dfr3: 'A',
      dfr4: 'A',
      dfr7: 'A',
      dfr6: 'A',
      dfr2: 'A',
      dfd3: '3',
      dfd4: '3',
      dfd7: '3',
      dfd6: '3',
      dfd2: '3',
    };
  }
  if (path === '/aircon/get_sensor_info') {
    return { ret: 'OK', htemp: '26', hhum: '55', otemp: '30' };
  }
  return { ret: 'OK' };
}

test('manual system publishes a heater/cooler and writes complete Daikin control commands', async (context) => {
  let paths = [];
  let runtime = setup(context, async (system, path) => {
    paths.push(path);
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 1);
    assert.equal(runtime.externallyPublished.length, 0);
    let accessory = runtime.registered[0];
    assert.ok(accessory.getService(hap.Service.HeaterCooler));
    assert.ok(accessory.services.some((service) => service.UUID === hap.Service.EveHomeHistory.UUID));
    assert.equal(accessory.category, hap.Categories.AIR_CONDITIONER);
    let active = accessory.getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.Active);
    await active.handleSetRequest(hap.Characteristic.Active.INACTIVE);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=0&mode=3&stemp=24&shum=0&f_rate=A&f_dir=3'));
    let dryActive = accessory.getService(hap.Service.HumidifierDehumidifier).getCharacteristic(hap.Characteristic.Active);
    await dryActive.handleSetRequest(hap.Characteristic.Active.ACTIVE);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=1&mode=2&stemp=M&shum=50&f_rate=A&f_dir=3'));
    let fanActive = accessory.getService(hap.Service.Fanv2).getCharacteristic(hap.Characteristic.Active);
    await fanActive.handleSetRequest(hap.Characteristic.Active.ACTIVE);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=1&mode=6&stemp=--&shum=--&f_rate=A&f_dir=3'));
    let heater = accessory.getService(hap.Service.HeaterCooler);
    await heater
      .getCharacteristic(hap.Characteristic.TargetHeaterCoolerState)
      .handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=1&mode=4&stemp=22&shum=0&f_rate=A&f_dir=3'));
    let reportedSpeed = await heater.getCharacteristic(hap.Characteristic.RotationSpeed).handleGetRequest();
    await heater.getCharacteristic(hap.Characteristic.RotationSpeed).handleSetRequest(reportedSpeed);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=1&mode=3&stemp=24&shum=0&f_rate=A&f_dir=3'));
    await heater.getCharacteristic(hap.Characteristic.RotationSpeed).handleSetRequest(100);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=1&mode=3&stemp=24&shum=0&f_rate=7&f_dir=3'));
    await heater.getCharacteristic(hap.Characteristic.SwingMode).handleSetRequest(hap.Characteristic.SwingMode.SWING_DISABLED);
    assert.ok(paths.some((path) => path === '/aircon/set_control_info?pow=1&mode=3&stemp=24&shum=0&f_rate=A&f_dir=0'));
    assert.equal(paths.filter((path) => path === '/aircon/get_control_info').length, 8);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('air-conditioner characteristics read the latest Daikin state', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path));
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let accessory = runtime.registered[0];
    let heater = accessory.getService(hap.Service.HeaterCooler);
    let fan = accessory.getService(hap.Service.Fanv2);
    let dry = accessory.getService(hap.Service.HumidifierDehumidifier);

    assert.equal(await heater.getCharacteristic(hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.ACTIVE);
    assert.equal(
      await heater.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState).handleGetRequest(),
      hap.Characteristic.TargetHeaterCoolerState.COOL,
    );
    assert.equal(await heater.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), 26);
    assert.equal(await heater.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).handleGetRequest(), 55);
    assert.equal(await heater.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).handleGetRequest(), 24);
    assert.equal(await heater.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).handleGetRequest(), 22);
    assert.equal(
      await heater.getCharacteristic(hap.Characteristic.SwingMode).handleGetRequest(),
      hap.Characteristic.SwingMode.SWING_ENABLED,
    );
    assert.equal(await heater.getCharacteristic(hap.Characteristic.RotationSpeed).handleGetRequest(), 100 / 7);

    assert.equal(await fan.getCharacteristic(hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.INACTIVE);
    assert.equal(await fan.getCharacteristic(hap.Characteristic.SwingMode).handleGetRequest(), hap.Characteristic.SwingMode.SWING_ENABLED);
    assert.equal(await fan.getCharacteristic(hap.Characteristic.RotationSpeed).handleGetRequest(), 100 / 7);

    assert.equal(await dry.getCharacteristic(hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.INACTIVE);
    assert.equal(
      await dry.getCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState).handleGetRequest(),
      hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
    );
    assert.equal(
      await dry.getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState).handleGetRequest(),
      hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
    );
    assert.equal(await dry.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).handleGetRequest(), 55);
    assert.equal(await dry.getCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold).handleGetRequest(), 50);
    assert.equal(await dry.getCharacteristic(hap.Characteristic.SwingMode).handleGetRequest(), hap.Characteristic.SwingMode.SWING_ENABLED);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('matching cached accessory is restored without duplicate registration', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path));
  let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFF');
  let cached = new hap.Accessory('Cached Daikin', uuid);
  cached._associatedPlatform = HomeKitDevice.PLATFORM_NAME;
  runtime.platform.configureAccessory(cached);
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 0);
    assert.ok(cached.getService(hap.Service.HeaterCooler));
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('disabled outdoor sensor is removed from the Homebridge cache', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false, externalSensor: false },
    devices: [{ system: '10.0.0.2' }],
  });
  let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFFOUTSIDE');
  let cached = new hap.Accessory('Cached Outdoor Sensor', uuid);
  cached.getService(hap.Service.AccessoryInformation).updateCharacteristic(hap.Characteristic.SerialNumber, 'AABBCCDDEEFFOUTSIDE');
  runtime.platform.configureAccessory(cached);
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.deepEqual(runtime.removed, [cached]);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('cached outdoor sensor is restored as faulted when its reading is unavailable', async (context) => {
  let runtime = setup(
    context,
    async (system, path) => {
      let result = snapshot(system, path);
      return path === '/aircon/get_sensor_info' ? { ...result, otemp: '-' } : result;
    },
    { options: { autoDiscover: false, externalSensor: true }, devices: [{ system: '10.0.0.2' }] },
  );
  let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFFOUTSIDE');
  let cached = new hap.Accessory('Cached Outdoor Sensor', uuid);
  cached.addService(hap.Service.TemperatureSensor, '', 1).updateCharacteristic(hap.Characteristic.CurrentTemperature, 31);
  runtime.platform.configureAccessory(cached);
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 1);
    let service = cached.getService(hap.Service.TemperatureSensor);
    assert.equal(service.getCharacteristic(hap.Characteristic.CurrentTemperature).value, 31);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusFault).value, hap.Characteristic.StatusFault.GENERAL_FAULT);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('failed Daikin command is returned to HomeKit', async (context) => {
  let runtime = setup(context, async (system, path) => {
    if (path.startsWith('/aircon/set_control_info?')) {
      throw new Error('write failed');
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let active = runtime.registered[0].getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.Active);
    await assert.rejects(active.handleSetRequest(hap.Characteristic.Active.INACTIVE));
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('per-system setting can disable Eve history', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false, eveHistory: true },
    devices: [{ system: '10.0.0.2', eveHistory: false }],
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(
      runtime.registered[0].services.some((service) => service.UUID === hap.Service.EveHomeHistory?.UUID),
      false,
    );
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('excluded system is inspected but not published', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false },
    devices: [{ system: '10.0.0.2', exclude: true }],
  });
  let device = new hap.Accessory('Cached Daikin', HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFF'));
  let sensor = new hap.Accessory(
    'Cached Outdoor Sensor',
    HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFFOUTSIDE'),
  );
  runtime.platform.configureAccessory(device);
  runtime.platform.configureAccessory(sensor);
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 0);
    assert.deepEqual(runtime.removed, [device, sensor]);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('optional outdoor sensor publishes separately and follows the polled temperature', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false, externalSensor: true },
    devices: [{ system: '10.0.0.2' }],
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 2);
    let sensor = runtime.registered.find((accessory) => accessory.getService(hap.Service.TemperatureSensor));
    assert.ok(sensor);
    assert.equal(sensor.category, hap.Categories.SENSOR);
    assert.equal(sensor.getService(hap.Service.TemperatureSensor).getCharacteristic(hap.Characteristic.CurrentTemperature).value, 30);
    assert.equal(sensor.getService(hap.Service.HumiditySensor), undefined);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('platform polling feeds air-conditioner and outdoor sensor updates and stops on shutdown', async (context) => {
  let timer = mockPollTimer(context);
  let outside = '30';
  let inside = '26';
  let requests = 0;
  let runtime = setup(
    context,
    async (system, path) => {
      requests += 1;
      let result = snapshot(system, path);
      return path === '/aircon/get_sensor_info' ? { ...result, otemp: outside, htemp: inside } : result;
    },
    {
      options: { autoDiscover: false, externalSensor: true, pollInterval: 5 },
      devices: [{ system: '10.0.0.2' }],
    },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let aircon = runtime.registered.find((accessory) => accessory.getService(hap.Service.HeaterCooler));
    let sensor = runtime.registered.find((accessory) => accessory.getService(hap.Service.TemperatureSensor));
    outside = '32';
    inside = '28';
    await timer.callback();
    assert.equal(aircon.getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.CurrentTemperature).value, 28);
    assert.equal(sensor.getService(hap.Service.TemperatureSensor).getCharacteristic(hap.Characteristic.CurrentTemperature).value, 32);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
  assert.equal(timer.cleared, true);
  let previousRequests = requests;
  await timer.callback();
  assert.equal(requests, previousRequests);
});

test('poll failures debounce offline publication for the air conditioner and outdoor sensor', async (context) => {
  let timer = mockPollTimer(context);
  let available = true;
  let runtime = setup(
    context,
    async (system, path) => {
      if (available === false && path === '/aircon/get_control_info') {
        return { pow: '1' };
      }
      return snapshot(system, path);
    },
    {
      options: { autoDiscover: false, externalSensor: true, pollInterval: 5 },
      devices: [{ system: '10.0.0.2' }],
    },
  );
  // Accessory loggers bind the supplied methods when the devices are created.
  let warnings = context.mock.method(HomeKitDevice.LOGGER, 'warn');
  let successes = context.mock.method(HomeKitDevice.LOGGER, 'success');
  let debug = context.mock.method(HomeKitDevice.LOGGER, 'debug');
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    warnings.mock.resetCalls();
    successes.mock.resetCalls();
    debug.mock.resetCalls();
    let sensor = runtime.registered.find((accessory) => accessory.getService(hap.Service.TemperatureSensor));
    let service = sensor.getService(hap.Service.TemperatureSensor);
    available = false;
    await timer.callback();
    assert.equal(warnings.mock.calls.length, 0);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusActive).value, true);
    assert.equal(service.getCharacteristic(hap.Characteristic.CurrentTemperature).value, 30);
    await timer.callback();
    assert.equal(warnings.mock.calls.filter((call) => call.arguments[0] === 'Device "%s" is offline').length, 2);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusActive).value, false);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusFault).value, hap.Characteristic.StatusFault.GENERAL_FAULT);
    assert.equal(debug.mock.calls.filter((call) => call.arguments[0] === 'Daikin poll failed for %s: %s').length, 2);
    available = true;
    await timer.callback();
    assert.equal(successes.mock.calls.filter((call) => call.arguments[0] === 'Device "%s" is online').length, 2);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusActive).value, true);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusFault).value, hap.Characteristic.StatusFault.NO_FAULT);
    assert.equal(runtime.registered.length, 2);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('per-system HTTP port applies to identity, polling, and control writes', async (context) => {
  let requests = [];
  let runtime = setup(
    context,
    async (system, path, httpPort) => {
      requests.push({ path, httpPort });
      return snapshot(system, path, 'AA:BB:CC:DD:EE:01');
    },
    {
      options: { autoDiscover: false, httpPort: 8080 },
      devices: [{ system: '10.0.0.2', httpPort: 9090 }],
    },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let active = runtime.registered[0].getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.Active);
    await active.handleSetRequest(hap.Characteristic.Active.INACTIVE);
    assert.ok(requests.some((request) => request.path === '/common/basic_info'));
    assert.ok(requests.some((request) => request.path.startsWith('/aircon/set_control_info?')));
    assert.ok(requests.every((request) => request.httpPort === 9090));
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('platform HTTP port applies when a system has no override', async (context) => {
  let ports = [];
  let runtime = setup(
    context,
    async (system, path, httpPort) => {
      ports.push(httpPort);
      return snapshot(system, path, 'AA:BB:CC:DD:EE:02');
    },
    {
      options: { autoDiscover: false, httpPort: 8080 },
      devices: [{ system: '10.0.0.2' }],
    },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.ok(ports.every((port) => port === 8080));
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

// Platform discovery tests replace the actual UDP boundary rather than the
// platform's discovery implementation.
class TestSocket extends EventEmitter {
  closed = false;

  bind() {
    this.emit('listening');
  }

  setBroadcast() {}

  send(_query, _port, _address, callback) {
    callback(null);
  }

  close() {
    this.closed = true;
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate() === true) {
      return;
    }
    await new Promise((resolve) => timers.setImmediate(resolve));
  }
  assert.equal(predicate(), true, 'expected asynchronous platform update');
}

function mockPollTimer(context) {
  return mockInterval(context, 5000);
}

function mockRetryTimer(context) {
  return mockInterval(context, 60000);
}

function mockInterval(context, milliseconds) {
  let originalSet = timers.setInterval;
  let originalClear = timers.clearInterval;
  let timer = { callback: undefined, cleared: false, handles: [] };
  mockBuiltin(context, timers, 'setInterval', (callback, interval, ...args) => {
    if (interval === milliseconds) {
      let handle = timer.handles.length === 0 ? timer : { callback: undefined, cleared: false };
      handle.callback = callback;
      timer.handles.push(handle);
      return handle;
    }
    return originalSet(callback, interval, ...args);
  });
  mockBuiltin(context, timers, 'clearInterval', (handle) => {
    if (timer.handles.includes(handle) === true) {
      handle.cleared = true;
      return;
    }
    originalClear(handle);
  });
  return timer;
}

test('platform forwards discovery candidates and stops the discovery session', async (context) => {
  let socket = new TestSocket();
  mockBuiltin(context, dgram, 'createSocket', () => socket);
  let inspected = [];
  let runtime = setup(
    context,
    async (system, path, httpPort) => {
      inspected.push({ system, path, httpPort });
      return snapshot(system, path, 'AA:BB:CC:DD:EE:03');
    },
    { options: { autoDiscover: true, httpPort: 8080, discoveryInterval: 45 }, devices: [] },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    socket.emit('message', Buffer.from('ret=OK'), { address: '10.0.0.3' });
    await waitFor(() => runtime.registered.length === 1);
    assert.ok(inspected.every((request) => request.system === '10.0.0.3' && request.httpPort === 8080));
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
  assert.equal(socket.closed, true);
});

test('discovery of a configured MAC keeps its configured host and does not publish twice', async (context) => {
  let socket = new TestSocket();
  mockBuiltin(context, dgram, 'createSocket', () => socket);
  let requests = [];
  let runtime = setup(
    context,
    async (system, path, httpPort) => {
      requests.push({ system, path, httpPort });
      return snapshot(system, path);
    },
    { options: { autoDiscover: true, httpPort: 8080 }, devices: [{ system: '10.0.0.2', httpPort: 9090 }] },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    socket.emit('message', Buffer.from('ret=OK'), { address: '10.0.0.3' });
    await waitFor(() => requests.filter((request) => request.path === '/aircon/get_control_info').length === 2);
    // Wait for the shared in-flight setup before checking publication.
    await runtime.platform.setupAirconditioner('10.0.0.3', false);
    assert.equal(runtime.registered.length, 1);
    assert.ok(requests.some((request) => request.system === '10.0.0.3' && request.path === '/common/basic_info'));
    let polls = requests.filter((request) => request.path === '/aircon/get_control_info');
    assert.ok(polls.every((request) => request.system === '10.0.0.2' && request.httpPort === 9090));
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('unreachable manual systems retry without UDP and release the retry timer on shutdown', async (context) => {
  let timer = mockRetryTimer(context);
  let available = false;
  let runtime = setup(context, async (system, path) => {
    if (available === false) {
      throw new Error('unit offline');
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 0);
    available = true;
    await timer.callback();
    assert.equal(runtime.registered.length, 1);
    await timer.callback();
    assert.equal(runtime.registered.length, 1);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
  assert.equal(timer.cleared, true);
  await timer.callback();
  assert.equal(runtime.registered.length, 1);
});

test('a manual system retries an incomplete first poll', async (context) => {
  let timer = mockRetryTimer(context);
  let available = false;
  let runtime = setup(context, async (system, path) => {
    if (path === '/aircon/get_control_info' && available === false) {
      return { ret: 'OK' };
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 0);
    available = true;
    await timer.callback();
    assert.equal(runtime.registered.length, 1);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('concurrent HomeKit commands merge after the preceding write and poll', async (context) => {
  let control = snapshot('', '/aircon/get_control_info');
  let writes = [];
  let release;
  let entered;
  let firstWrite = new Promise((resolve) => {
    entered = resolve;
  });
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let runtime = setup(context, async (system, path) => {
    if (path === '/aircon/get_control_info') {
      return { ...control };
    }
    if (path.startsWith('/aircon/set_control_info?') === true) {
      let values = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
      writes.push(values);
      if (writes.length === 1) {
        entered();
        await gate;
      }
      control = { ...control, ...values, dt3: values.stemp, dfd3: values.f_dir };
      return { ret: 'OK' };
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let heater = runtime.registered[0].getService(hap.Service.HeaterCooler);
    let temperature = heater.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).handleSetRequest(27);
    await firstWrite;
    let swing = heater.getCharacteristic(hap.Characteristic.SwingMode).handleSetRequest(hap.Characteristic.SwingMode.SWING_DISABLED);
    assert.equal(writes.length, 1);
    release();
    await Promise.all([temperature, swing]);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].stemp, '27');
    assert.equal(writes[1].f_dir, '0');
  } finally {
    release();
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('a failed command does not prevent a later command from succeeding', async (context) => {
  let failed = true;
  let runtime = setup(context, async (system, path) => {
    if (path.startsWith('/aircon/set_control_info?') === true && failed === true) {
      throw new Error('write failed');
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let active = runtime.registered[0].getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.Active);
    await assert.rejects(active.handleSetRequest(hap.Characteristic.Active.INACTIVE));
    failed = false;
    await active.handleSetRequest(hap.Characteristic.Active.INACTIVE);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('outdoor sensor exposes Eve temperature history without an unsupported pressure service', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false, externalSensor: true },
    devices: [{ system: '10.0.0.2' }],
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let sensor = runtime.registered.find((accessory) => accessory.getService(hap.Service.TemperatureSensor));
    assert.equal(sensor.getService(hap.Service.EveAirPressureSensor), undefined);
    assert.ok(sensor.getService(hap.Service.EveHomeHistory));
    assert.equal(sensor.getService(hap.Service.EveHomeHistory).testCharacteristic(hap.Characteristic.EveHistoryStatus), true);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('shutdown waits for an active write and rejects queued commands', async (context) => {
  let entered;
  let release;
  let writes = 0;
  let firstWrite = new Promise((resolve) => {
    entered = resolve;
  });
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let runtime = setup(context, async (system, path) => {
    if (path.startsWith('/aircon/set_control_info?') === true) {
      writes++;
      entered();
      await gate;
      return { ret: 'OK' };
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let uuid = runtime.registered[0].UUID;
    let active = HomeKitDevice.message(uuid, HomeKitDevice.SET, { stemp: 27 });
    await firstWrite;
    let queued = HomeKitDevice.message(uuid, HomeKitDevice.SET, { f_dir: 0 });
    let finished = false;
    let shutdown = runtime.events
      .get('shutdown')[0]()
      .then(() => {
        finished = true;
      });
    assert.equal(finished, false);
    release();
    assert.notEqual(await active, false);
    await assert.rejects(queued, /Daikin control request failed/);
    await shutdown;
    assert.equal(finished, true);
    assert.equal(writes, 1);
  } finally {
    release();
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('temperature commands enforce Daikin cooling, heating, and auto boundaries', async () => {
  for (let [mode, minimum, maximum] of [
    [3, 18, 32],
    [4, 10, 30],
    [7, 18, 30],
  ]) {
    let writes = [];
    let device = {
      deviceData: { mode },
      setState(values) {
        writes.push(values);
      },
    };
    for (let characteristicMode of mode === 7 ? [3, 4] : [mode]) {
      writes = [];
      await Airconditioner.prototype.setTemperature.call(device, minimum, characteristicMode);
      await Airconditioner.prototype.setTemperature.call(device, maximum, characteristicMode);
      assert.deepEqual(writes, [{ stemp: minimum }, { stemp: maximum }]);
      for (let invalid of [minimum - 1, maximum + 1, NaN, Infinity, '24']) {
        await Airconditioner.prototype.setTemperature.call(device, invalid, characteristicMode);
      }
      assert.equal(writes.length, 2);
    }
    if (mode !== 7) {
      await Airconditioner.prototype.setTemperature.call(device, 24, mode === 3 ? 4 : 3);
      assert.equal(writes.length, 2);
    }
  }
});

test('HomeKit temperature limits follow auto mode and restore heating and cooling extremes', async (context) => {
  let control = { ...snapshot('', '/aircon/get_control_info'), dt3: '32', dt4: '10', dt7: '23' };
  let runtime = setup(context, async (system, path) => {
    if (path === '/aircon/get_control_info') {
      return { ...control };
    }
    if (path.startsWith('/aircon/set_control_info?') === true) {
      let values = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
      control = { ...control, ...values, ['dt' + values.mode]: values.stemp };
      return { ret: 'OK' };
    }
    return snapshot(system, path);
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let heater = runtime.registered[0].getService(hap.Service.HeaterCooler);
    let cooling = heater.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature);
    let heating = heater.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature);
    let target = heater.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState);
    assert.equal(cooling.props.minValue, 18);
    assert.equal(cooling.props.maxValue, 32);
    assert.equal(heating.props.minValue, 10);
    assert.equal(heating.props.maxValue, 30);
    await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.AUTO);
    assert.equal(cooling.props.minValue, 18);
    assert.equal(cooling.props.maxValue, 30);
    assert.equal(heating.props.minValue, 18);
    assert.equal(heating.props.maxValue, 30);
    assert.equal(cooling.value, 23);
    assert.equal(heating.value, 23);
    await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
    assert.equal(heating.props.minValue, 10);
    assert.equal(heating.value, 10);
    await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.COOL);
    assert.equal(cooling.props.maxValue, 32);
    assert.equal(cooling.value, 32);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('auto mode initializes both HomeKit thresholds from the auto target', async (context) => {
  let runtime = setup(context, async (system, path) => {
    let data = snapshot(system, path);
    return path === '/aircon/get_control_info' ? { ...data, mode: '7', dt3: '32', dt4: '10', dt7: '23' } : data;
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let heater = runtime.registered[0].getService(hap.Service.HeaterCooler);
    for (let type of [hap.Characteristic.CoolingThresholdTemperature, hap.Characteristic.HeatingThresholdTemperature]) {
      let characteristic = heater.getCharacteristic(type);
      assert.equal(characteristic.props.minValue, 18);
      assert.equal(characteristic.props.maxValue, 30);
      assert.equal(await characteristic.handleGetRequest(), 23);
    }
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('per-device range overrides apply to HomeKit controls and survive mode changes', async (context) => {
  let writes = [];
  let control = { ...snapshot('', '/aircon/get_control_info'), dt3: '24', dt4: '22', dt7: '23' };
  let runtime = setup(
    context,
    async (system, path) => {
      if (path === '/aircon/get_control_info') {
        return { ...control };
      }
      if (path.startsWith('/aircon/set_control_info?') === true) {
        let values = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
        writes.push(values);
        control = { ...control, ...values, ['dt' + values.mode]: values.stemp };
        return { ret: 'OK' };
      }
      return snapshot(system, path);
    },
    {
      options: { autoDiscover: false },
      devices: [{ system: '10.0.0.2', coolingMin: 16, coolingMax: 34, heatingMin: 8, heatingMax: 28, autoMin: 15, autoMax: 33 }],
    },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let heater = runtime.registered[0].getService(hap.Service.HeaterCooler);
    let cooling = heater.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature);
    let heating = heater.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature);
    let target = heater.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState);
    assert.equal(cooling.props.minValue, 16);
    assert.equal(cooling.props.maxValue, 34);
    assert.equal(heating.props.minValue, 8);
    assert.equal(heating.props.maxValue, 28);
    await cooling.handleSetRequest(16);
    assert.equal(writes.at(-1).stemp, '16');
    await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.AUTO);
    for (let characteristic of [cooling, heating]) {
      assert.equal(characteristic.props.minValue, 15);
      assert.equal(characteristic.props.maxValue, 33);
    }
    await heating.handleSetRequest(33);
    assert.equal(writes.at(-1).mode, '7');
    assert.equal(writes.at(-1).stemp, '33');
    await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
    assert.equal(heating.props.minValue, 8);
    assert.equal(heating.props.maxValue, 28);
    await heating.handleSetRequest(8);
    assert.equal(writes.at(-1).stemp, '8');
    await target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.COOL);
    assert.equal(cooling.props.minValue, 16);
    assert.equal(cooling.props.maxValue, 34);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('custom limits validate temperature writes and mode handlers emit only mode and power', async () => {
  let writes = [];
  let device = {
    hap,
    deviceData: {
      mode: 3,
      dt3: 12,
      dt4: 40,
      dt7: 35,
      coolingMin: 16,
      coolingMax: 34,
      heatingMin: 8,
      heatingMax: 28,
      autoMin: 15,
      autoMax: 33,
    },
    setState(values) {
      writes.push(values);
    },
  };
  await Airconditioner.prototype.setTemperature.call(device, 16, 3);
  await Airconditioner.prototype.setTemperature.call(device, 15, 3);
  await Airconditioner.prototype.setTemperature.call(device, 35, 3);
  assert.deepEqual(writes, [{ stemp: 16 }]);
  for (let mode of [3, 4, 7]) {
    await Airconditioner.prototype.setMode.call(device, mode);
    assert.deepEqual(writes.at(-1), { pow: 1, mode });
  }
});

test('per-device outdoor sensor can be enabled when the platform default is disabled', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false, externalSensor: false },
    devices: [{ system: '10.0.0.2', externalSensor: true }],
  });
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 2);
    let sensor = runtime.registered.find((accessory) => accessory.getService(hap.Service.TemperatureSensor));
    assert.equal(sensor.getService(hap.Service.TemperatureSensor).getCharacteristic(hap.Characteristic.CurrentTemperature).value, 30);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('per-device outdoor sensor can be disabled and removed from cache despite the platform default', async (context) => {
  let runtime = setup(context, async (system, path) => snapshot(system, path), {
    options: { autoDiscover: false, externalSensor: true },
    devices: [{ system: '10.0.0.2', externalSensor: false }],
  });
  let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFFOUTSIDE');
  let cached = new hap.Accessory('Cached Outdoor Sensor', uuid);
  runtime.platform.configureAccessory(cached);
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(runtime.registered.length, 1);
    assert.equal(runtime.registered[0].getService(hap.Service.TemperatureSensor), undefined);
    assert.deepEqual(runtime.removed, [cached]);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

// Home can send Active and TargetHeaterCoolerState together in either order.
for (let powerFirst of [false, true]) {
  test('overlapping heat and power writes retain heat, power first: ' + powerFirst, async (context) => {
    let control = snapshot('10.0.0.2', '/aircon/get_control_info');
    let writes = [];
    let release;
    let entered;
    let gate = new Promise((resolve) => {
      release = resolve;
    });
    let started = new Promise((resolve) => {
      entered = resolve;
    });
    let runtime = setup(context, async (system, path) => {
      if (path.startsWith('/aircon/set_control_info?') === true) {
        let values = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
        writes.push(values);
        if (writes.length === 1) {
          entered();
          await gate;
        }
        control = { ...control, ...values, ['dt' + values.mode]: values.stemp };
        return { ret: 'OK' };
      }
      return path === '/aircon/get_control_info' ? control : snapshot(system, path);
    });
    try {
      await runtime.events.get('didFinishLaunching')[0]();
      let heater = runtime.registered[0].getService(hap.Service.HeaterCooler);
      let target = heater.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState);
      let active = heater.getCharacteristic(hap.Characteristic.Active);
      let first =
        powerFirst === true
          ? active.handleSetRequest(hap.Characteristic.Active.ACTIVE)
          : target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
      await started;
      let second =
        powerFirst === true
          ? target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT)
          : active.handleSetRequest(hap.Characteristic.Active.ACTIVE);
      release();
      await Promise.all([first, second]);
      assert.deepEqual(
        writes.map((values) => values.mode),
        powerFirst === true ? ['3', '4'] : ['4', '4'],
      );
      assert.equal(await target.handleGetRequest(), hap.Characteristic.TargetHeaterCoolerState.HEAT);
      assert.equal(await active.handleGetRequest(), hap.Characteristic.Active.ACTIVE);
    } finally {
      release();
      for (let callback of runtime.events.get('shutdown') ?? []) {
        await callback();
      }
    }
  });
}

for (let accepted of [true, false]) {
  test('mode reads follow the unit after a heat command, accepted: ' + accepted, async (context) => {
    let runtime = setup(context, async (system, path) => {
      if (path.startsWith('/aircon/set_control_info?') === true) {
        return { ret: accepted === true ? 'OK' : 'PARAM NG' };
      }
      // The unit still reports cooling even when it acknowledges the command.
      return snapshot(system, path);
    });
    try {
      await runtime.events.get('didFinishLaunching')[0]();
      let target = runtime.registered[0].getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.TargetHeaterCoolerState);
      let command = target.handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
      if (accepted === true) {
        await command;
      } else {
        await assert.rejects(command);
      }
      assert.equal(await target.handleGetRequest(), hap.Characteristic.TargetHeaterCoolerState.COOL);
    } finally {
      for (let callback of runtime.events.get('shutdown') ?? []) {
        await callback();
      }
    }
  });
}

test('a HomeKit command during an active poll completes and publishes reported state', { timeout: 2000 }, async (context) => {
  let timer = mockPollTimer(context);
  let control = snapshot('', '/aircon/get_control_info');
  let pause = false;
  let writes = 0;
  let entered;
  let release;
  let started = new Promise((resolve) => {
    entered = resolve;
  });
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let runtime = setup(
    context,
    async (system, path) => {
      if (path === '/aircon/get_control_info') {
        if (pause === true) {
          pause = false;
          entered();
          await gate;
        }
        return { ...control };
      }
      if (path.startsWith('/aircon/set_control_info?') === true) {
        writes++;
        let values = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
        control = { ...control, ...values, ['dt' + values.mode]: values.stemp };
        return { ret: 'OK' };
      }
      return snapshot(system, path);
    },
    { options: { autoDiscover: false, pollInterval: 5 }, devices: [{ system: '10.0.0.2' }] },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let heater = runtime.registered[0].getService(hap.Service.HeaterCooler);
    pause = true;
    let poll = timer.callback();
    await started;
    let command = heater
      .getCharacteristic(hap.Characteristic.TargetHeaterCoolerState)
      .handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
    // Allow SET to enter while the HTTP poll still owns the network queue.
    await new Promise((resolve) => timers.setImmediate(resolve));
    assert.equal(writes, 0);
    release();
    await Promise.all([poll, command]);
    assert.equal(writes, 1);
    assert.equal(
      await heater.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState).handleGetRequest(),
      hap.Characteristic.TargetHeaterCoolerState.HEAT,
    );
    assert.equal(
      heater.getCharacteristic(hap.Characteristic.CurrentHeaterCoolerState).value,
      hap.Characteristic.CurrentHeaterCoolerState.HEATING,
    );
  } finally {
    release();
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('platform skips overlapping polls for a unit and resumes after completion', async (context) => {
  let timer = mockPollTimer(context);
  let pause = false;
  let polls = 0;
  let release;
  let entered;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = new Promise((resolve) => {
    entered = resolve;
  });
  let runtime = setup(
    context,
    async (system, path) => {
      if (path === '/aircon/get_control_info') {
        polls += 1;
        if (pause === true) {
          entered();
          await gate;
        }
      }
      return snapshot(system, path);
    },
    { options: { autoDiscover: false, pollInterval: 5 }, devices: [{ system: '10.0.0.2' }] },
  );
  let first;
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    pause = true;
    first = timer.callback();
    await started;
    await timer.callback();
    assert.equal(polls, 2);
    pause = false;
    release();
    await first;
    assert.equal(polls, 2);
    await timer.callback();
    assert.equal(polls, 3);
  } finally {
    release();
    await first;
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('platform polls units independently without duplicate subscriptions on rediscovery', async (context) => {
  let timer = mockPollTimer(context);
  let blocked = '10.0.0.2';
  let healthy = '10.0.0.3';
  let pause = false;
  let temperature = '26';
  let polls = new Map([
    [blocked, 0],
    [healthy, 0],
  ]);
  let release;
  let entered;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = new Promise((resolve) => {
    entered = resolve;
  });
  let runtime = setup(
    context,
    async (system, path) => {
      if (path === '/aircon/get_control_info') {
        polls.set(system, polls.get(system) + 1);
        if (system === blocked && pause === true) {
          entered();
          await gate;
        }
      }
      let result = snapshot(system, path, system === blocked ? 'AA:BB:CC:DD:EE:02' : 'AA:BB:CC:DD:EE:03');
      return path === '/aircon/get_sensor_info' && system === healthy ? { ...result, htemp: temperature } : result;
    },
    { options: { autoDiscover: false, pollInterval: 5 }, devices: [{ system: blocked }, { system: healthy }] },
  );
  let first;
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    assert.equal(timer.handles.length, 2);
    await runtime.platform.setupAirconditioner(healthy, false);
    assert.equal(timer.handles.length, 2);
    let baseline = new Map(polls);
    pause = true;
    first = timer.handles[0].callback();
    await started;
    temperature = '29';
    await timer.handles[1].callback();
    let accessory = runtime.registered.find(
      (device) =>
        device.getService(hap.Service.AccessoryInformation).getCharacteristic(hap.Characteristic.SerialNumber).value === 'AABBCCDDEE03',
    );
    assert.equal(accessory.getService(hap.Service.HeaterCooler).getCharacteristic(hap.Characteristic.CurrentTemperature).value, 29);
    await timer.handles[0].callback();
    assert.equal(polls.get(blocked), baseline.get(blocked) + 1);
    assert.equal(polls.get(healthy), baseline.get(healthy) + 1);
  } finally {
    release();
    await first;
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
  assert.equal(
    timer.handles.every((handle) => handle.cleared === true),
    true,
  );
});

for (let humidity of [undefined, '--', '']) {
  test('missing humidity uses valid fallbacks on both services: ' + humidity, async (context) => {
    let runtime = setup(context, async (system, path) => {
      let result = snapshot(system, path);
      if (path === '/aircon/get_sensor_info') {
        delete result.hhum;
        if (humidity !== undefined) {
          result.hhum = humidity;
        }
      }
      return result;
    });
    // Restore cached humidity characteristics and retain their last readings.
    let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, hap, 'AABBCCDDEEFF');
    let cached = new hap.Accessory('Cached Daikin', uuid);
    cached._associatedPlatform = HomeKitDevice.PLATFORM_NAME;
    cached.addService(hap.Service.HeaterCooler, '', 1).getCharacteristic(hap.Characteristic.CurrentRelativeHumidity);
    if (humidity === '--') {
      cached.addService(hap.Service.HumidifierDehumidifier, '', 1).updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, 48);
    }
    let warnings = [];
    cached.on('characteristic-warning', (warning) => warnings.push(warning));
    runtime.platform.configureAccessory(cached);
    try {
      await runtime.events.get('didFinishLaunching')[0]();
      let heater = cached.getService(hap.Service.HeaterCooler);
      assert.equal(heater.testCharacteristic(hap.Characteristic.CurrentRelativeHumidity), true);
      assert.equal(await heater.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).handleGetRequest(), 0);
      assert.equal(await heater.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), 26);
      let dry = cached.getService(hap.Service.HumidifierDehumidifier).getCharacteristic(hap.Characteristic.CurrentRelativeHumidity);
      for (let read of [1, 2, 3]) {
        assert.equal(await dry.handleGetRequest(), humidity === '--' ? 48 : 0, 'read ' + read);
      }
      await heater
        .getCharacteristic(hap.Characteristic.TargetHeaterCoolerState)
        .handleSetRequest(hap.Characteristic.TargetHeaterCoolerState.HEAT);
      assert.equal(await heater.getCharacteristic(hap.Characteristic.Active).handleGetRequest(), hap.Characteristic.Active.ACTIVE);
      assert.equal(
        warnings.some(
          (warning) =>
            warning.originatorChain.includes('Current Relative Humidity') === true && warning.message.includes('illegal value') === true,
        ),
        false,
      );
    } finally {
      for (let callback of runtime.events.get('shutdown') ?? []) {
        await callback();
      }
    }
  });
}

test('missing sensor readings after a poll retain the last valid readings without null', async (context) => {
  let timer = mockPollTimer(context);
  let missing = false;
  let runtime = setup(
    context,
    async (system, path) => {
      let result = snapshot(system, path);
      return path === '/aircon/get_sensor_info' && missing === true ? { ...result, htemp: '--', hhum: '--' } : result;
    },
    { options: { autoDiscover: false, pollInterval: 5 }, devices: [{ system: '10.0.0.2' }] },
  );
  try {
    await runtime.events.get('didFinishLaunching')[0]();
    let accessory = runtime.registered[0];
    let heater = accessory.getService(hap.Service.HeaterCooler);
    let humidity = heater.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity);
    assert.equal(await humidity.handleGetRequest(), 55);
    let warnings = [];
    accessory.on('characteristic-warning', (warning) => warnings.push(warning));
    missing = true;
    await timer.callback();
    // The shared device snapshot retains prior valid values for missing fields.
    assert.equal(await humidity.handleGetRequest(), 55);
    assert.equal(await heater.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), 26);
    assert.equal(
      warnings.some(
        (warning) =>
          warning.originatorChain.includes('Current Relative Humidity') === true && warning.message.includes('illegal value') === true,
      ),
      false,
    );
    missing = false;
    await timer.callback();
    assert.equal(await humidity.handleGetRequest(), 55);
  } finally {
    for (let callback of runtime.events.get('shutdown') ?? []) {
      await callback();
    }
  }
});
