// Test HTTP fixtures and Node built-in mocks for Daikin lifecycle tests.
// Keeps test substitutions outside the Homebridge platform and client APIs.

import { syncBuiltinESMExports } from 'node:module';
import { URL } from 'node:url';

export function mockDaikin(context, handler) {
  // Exercise the same URL construction, fetch wrapper, and protocol parser as
  // production. Fixture values are encoded like real Daikin HTTP responses.
  return context.mock.method(globalThis, 'fetch', async (address) => {
    let url = new URL(address);
    let values = await handler(url.hostname, url.pathname + url.search, Number(url.port || 80));
    let body = Object.entries({ ret: 'OK', ...values })
      .map(([key, value]) => key + '=' + encodeURIComponent(value))
      .join(',');
    return { ok: true, status: 200, text: async () => body };
  });
}

export function mockBuiltin(context, module, method, implementation) {
  // Synchronize named ESM imports after replacing a built-in module method,
  // and restore them before the next test uses the real implementation.
  let mocked = context.mock.method(module, method, implementation);
  syncBuiltinESMExports();
  context.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}
