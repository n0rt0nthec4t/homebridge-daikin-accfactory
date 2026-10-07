// Daikin protocol validation and snapshot regression tests
// Part of homebridge-daikin-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';
import { URLSearchParams } from 'node:url';
import { mockDaikin } from './helpers.js';

import DaikinClient from '../dist/daikinclient.js';

test('Daikin request parses encoded values and validates API status', async (context) => {
  let body = 'ret=OK,name=Living%20Room,token=a=b';
  context.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => body }));
  let client = new DaikinClient('10.0.0.2', 80);
  assert.deepEqual(await client.request('/common/basic_info'), { ret: 'OK', name: 'Living Room', token: 'a=b' });
  body = 'ret=PARAM NG';
  await assert.rejects(client.request('/common/basic_info'), /Daikin API/);
});

test('control commands send all required fields from the latest snapshot', async (context) => {
  let path;
  mockDaikin(context, async (_system, requestPath) => {
    path = requestPath;
    return { ret: 'OK' };
  });
  let client = new DaikinClient('10.0.0.2', 80);
  client.control = { pow: '1', mode: '3', stemp: '24', shum: '0', f_rate: 'A', f_dir: '3' };
  await client.set({ pow: 0 });
  assert.equal(path, '/aircon/set_control_info?pow=0&mode=3&stemp=24&shum=0&f_rate=A&f_dir=3');
  client.control = {};
  assert.throws(() => client.set({ pow: 0 }), /Incomplete/);
});

test('Daikin client uses the shared fetch wrapper and parses its response', async (context) => {
  let calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => 'ret=OK,name=Living%20Room' };
  });
  let client = new DaikinClient('10.0.0.2', 80);
  let data = await client.request('/common/basic_info');
  assert.deepEqual(data, { ret: 'OK', name: 'Living Room' });
  assert.equal(calls[0].url, 'http://10.0.0.2/common/basic_info');
  assert.equal(calls[0].options.method, 'get');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('Daikin client uses a non-default HTTP port for API requests', async (context) => {
  let received;
  context.mock.method(globalThis, 'fetch', async (url) => {
    received = url;
    return { ok: true, text: async () => 'ret=OK,pow=1' };
  });
  let client = new DaikinClient('10.0.0.2', 8080);
  await client.request('/aircon/get_control_info');
  assert.equal(received, 'http://10.0.0.2:8080/aircon/get_control_info');
  client.httpPort = 70000;
  await assert.rejects(client.request('/common/basic_info'), /HTTP port/);
});

test('client owns identity, paired polling, normalized data, and complete control writes', async (context) => {
  let requests = [];
  mockDaikin(context, async (_system, path, port) => {
    requests.push({ path, port });
    if (path === '/common/basic_info') {
      return { mac: 'aa:bb:cc:dd:ee:ff', name: 'Indoor Unit', ver: '1_2_3' };
    }
    if (path === '/aircon/get_control_info') {
      return { pow: '1', mode: '3', stemp: '24', shum: '0', f_rate: 'A', f_dir: '3', dt3: '24', dt4: '22', dt7: '23' };
    }
    if (path === '/aircon/get_sensor_info') {
      return { htemp: '26', hhum: '55', otemp: '30' };
    }
    return { ret: 'OK' };
  });
  let client = new DaikinClient('10.0.0.2', 8080);
  assert.equal(await client.identify(), 'AABBCCDDEEFF');
  await client.poll();
  let data = client.deviceData({ name: 'Living Room', exclude: false });
  assert.equal(data.serialNumber, 'AABBCCDDEEFF');
  assert.equal(data.description, 'Living Room');
  assert.equal(data.softwareVersion, '1.2.3');
  assert.equal(data.htemp, 26);
  assert.equal(data.hhum, 55);
  assert.equal(data.otemp, 30);
  await client.set({ pow: 0 });
  assert.ok(requests.some(({ path }) => path === '/aircon/set_control_info?pow=0&mode=3&stemp=24&shum=0&f_rate=A&f_dir=3'));
  assert.ok(requests.every(({ port }) => port === 8080));
});

test('unavailable sensor tokens are not converted into zero readings', () => {
  let client = new DaikinClient('10.0.0.2');
  client.info = { name: 'Indoor Unit' };
  client.mac = 'AABBCCDDEEFF';
  client.control = { pow: '1', mode: '3' };
  client.sensor = { htemp: '--', hhum: '-', otemp: '' };
  let data = client.deviceData();
  assert.equal(data.htemp, undefined);
  assert.equal(data.hhum, undefined);
  assert.equal(data.otemp, undefined);
});

test('malformed HTTP responses cannot masquerade as successful Daikin requests', async (context) => {
  for (let body of ['', '<html>unavailable</html>', 'pow=1,mode=3']) {
    context.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => body }));
    let client = new DaikinClient('10.0.0.2', 80);
    await assert.rejects(client.request('/aircon/get_control_info'), /missing return status/);
  }
});

test('identity accepts MAC separators but rejects corrupt identities', async (context) => {
  for (let mac of ['aabbccddeeff', 'aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF']) {
    mockDaikin(context, async () => ({ mac }));
    let client = new DaikinClient('10.0.0.2', 80);
    assert.equal(await client.identify(), 'AABBCCDDEEFF');
  }
  for (let mac of ['xxAA:BB:CC:DD:EE:FF', 'AA/BB/CC/DD/EE/FF', 'AA:BB:CC:DD:EE', undefined]) {
    mockDaikin(context, async () => ({ mac }));
    let client = new DaikinClient('10.0.0.2', 80);
    assert.equal(await client.identify(), undefined);
  }
});

test('incomplete polls mark the client offline and retain the last complete snapshot', async (context) => {
  let control = { pow: '1', mode: '3', stemp: '25', shum: '0', f_rate: 'B', f_dir: '0' };
  let sensor = { htemp: '26' };
  mockDaikin(context, async (_system, path) => (path === '/aircon/get_control_info' ? control : sensor));
  let client = new DaikinClient('10.0.0.2', 80);
  await client.poll();
  let previous = client.control;
  control = { pow: '1' };
  await assert.rejects(client.poll(), /Incomplete/);
  assert.equal(client.online, false);
  assert.equal(client.control, previous);
  control = previous;
  sensor = {};
  await assert.rejects(client.poll(), /Incomplete/);
  sensor = { htemp: '--' };
  await client.poll();
  assert.equal(client.online, true);
});

test('mode memory fields map directly and accepted commands update them', async (context) => {
  mockDaikin(context, async () => ({ ret: 'OK' }));
  let client = new DaikinClient('10.0.0.2', 80);
  client.mac = 'AABBCCDDEEFF';
  client.info = {};
  client.control = { pow: '1', mode: '3', stemp: '25', shum: '0', f_rate: 'B', f_dir: '0', dt3: '23', dfr3: 'A', dfd3: '3' };
  client.sensor = { htemp: '26' };
  let data = client.deviceData();
  assert.equal(data.dt3, 23);
  assert.equal(data.dfr3, 'A');
  assert.equal(data.dfd3, 3);
  await client.set({ stemp: 27 });
  assert.equal(client.control.stemp, '27');
  assert.equal(client.deviceData().dt3, 27);
  mockDaikin(context, async () => ({ ret: 'PARAM NG' }));
  await assert.rejects(client.set({ stemp: 28 }), /Daikin API/);
  assert.equal(client.control.stemp, '27');
});

test('control writes are never replayed after a transport failure', async (context) => {
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    throw new TypeError('connection lost after write');
  });
  let client = new DaikinClient('10.0.0.2', 80);
  client.control = { pow: '1', mode: '3', stemp: '24', shum: '0', f_rate: 'A', f_dir: '3' };
  await assert.rejects(client.set({ pow: 0 }), /connection lost/);
  assert.equal(attempts, 1);
  assert.equal(client.control.pow, '1');
});

test('mode commands resolve remembered temperatures within device overrides', async (context) => {
  let path;
  mockDaikin(context, async (_system, requestPath) => {
    path = requestPath;
    return { ret: 'OK' };
  });
  let client = new DaikinClient('10.0.0.2', 80);
  client.control = { pow: '1', mode: '3', stemp: '24', shum: '0', f_rate: 'A', f_dir: '3', dt3: '12', dt4: '40', dt7: '35' };
  for (let [mode, minimum, maximum, expected] of [
    [3, 16, 34, '16'],
    [4, 8, 28, '28'],
    [7, 15, 33, '33'],
  ]) {
    let prefix = mode === 3 ? 'cooling' : mode === 4 ? 'heating' : 'auto';
    await client.set({ pow: 1, mode }, { [prefix + 'Min']: minimum, [prefix + 'Max']: maximum });
    let values = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
    assert.equal(values.mode, String(mode));
    assert.equal(values.stemp, expected);
  }
});
