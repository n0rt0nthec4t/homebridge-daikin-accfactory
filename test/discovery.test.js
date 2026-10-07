// Daikin UDP discovery lifecycle tests
// Part of homebridge-daikin-accfactory

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { startDiscovery } from '../dist/discovery.js';

class TestSocket extends EventEmitter {
  sent = [];
  closed = false;

  bind(port, address) {
    this.bound = { port, address };
    this.emit('listening');
  }

  addMembership(address) {
    this.membership = address;
  }

  setBroadcast(value) {
    this.broadcast = value;
  }

  send(query, port, address, callback) {
    this.sent.push({ query, port, address });
    callback(null);
  }

  close() {
    this.closed = true;
  }
}

function fakeClock() {
  let pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout(callback, delay) {
      let id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    run(delay) {
      let entry = [...pending].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'expected timer at ' + delay + ' ms');
      pending.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('discovery broadcasts, forwards candidates, repeats, and stops cleanly', () => {
  let sockets = [];
  let candidates = [];
  let errors = [];
  let clock = fakeClock();
  let browser = startDiscovery(
    {
      interval: 60000,
      onDevice: (candidate) => candidates.push(candidate),
      onError: (error) => errors.push(error),
    },
    () => {
      let socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
    clock,
  );

  assert.deepEqual(sockets[0].bound, { port: 30000, address: '0.0.0.0' });
  assert.equal(sockets[0].membership, undefined);
  assert.equal(sockets[0].broadcast, true);
  assert.deepEqual(sockets[0].sent, [{ query: 'DAIKIN_UDP/common/basic_info', port: 30050, address: '255.255.255.255' }]);
  sockets[0].emit('message', Buffer.from('ret=OK'), { address: '192.0.2.15' });
  assert.deepEqual(candidates, [{ host: '192.0.2.15', address: '192.0.2.15' }]);

  clock.run(5000);
  assert.equal(sockets[0].closed, true);
  clock.run(55000);
  assert.equal(sockets.length, 2);
  sockets[1].emit('error', new Error('UDP failure'));
  assert.equal(errors.length, 1);
  browser.stop();
  assert.equal(sockets[1].closed, true);
  assert.equal(clock.pending.size, 0);
  browser.stop();
});

test('discovery requires candidate and error callbacks', () => {
  assert.throws(() => startDiscovery(), /requires onDevice and onError callbacks/);
});

test('discovery retries a later scan when opening the UDP socket fails', () => {
  let clock = fakeClock();
  let attempts = 0;
  let errors = [];
  let socket = new TestSocket();
  let browser = startDiscovery(
    { onDevice: () => {}, onError: (error) => errors.push(error), interval: 60000 },
    () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Port unavailable');
      }
      return socket;
    },
    clock,
  );
  try {
    assert.equal(errors.length, 1);
    clock.run(60000);
    assert.equal(attempts, 2);
    assert.equal(socket.sent.length, 1);
  } finally {
    browser.stop();
  }
});

test('each scan deduplicates replies and contains errors from reporting callbacks', () => {
  let clock = fakeClock();
  let socket = new TestSocket();
  let candidates = [];
  let browser = startDiscovery(
    {
      onDevice(candidate) {
        candidates.push(candidate);
      },
      onError() {
        throw new Error('logger failed');
      },
    },
    () => socket,
    clock,
  );
  socket.emit('message', Buffer.from('ret=OK'), { address: '192.0.2.15' });
  socket.emit('message', Buffer.from('ret=OK'), { address: '192.0.2.15' });
  assert.equal(candidates.length, 1);
  assert.doesNotThrow(() => socket.emit('error', new Error('UDP failed')));
  browser.stop();
  assert.doesNotThrow(() => socket.emit('error', new Error('late UDP error')));
  socket.emit('message', Buffer.from('ret=OK'), { address: '192.0.2.16' });
  assert.equal(candidates.length, 1);
});
