import assert from 'node:assert/strict';
import test from 'node:test';

import register from '../dist/index.js';
import DaikinAccfactory from '../dist/system.js';

test('entry point validates the API and registers the Daikin platform', () => {
  assert.throws(() => register(undefined), /registerPlatform/);
  let calls = [];
  register({ registerPlatform: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['DaikinAccfactory', DaikinAccfactory]]);
});
