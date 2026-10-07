// Daikin UDP Discovery
// Part of homebridge-daikin-accfactory
//
// Finds Daikin systems by broadcasting the local DAIKIN_UDP basic-info query.
// Discovery only supplies candidate addresses; system.js validates identity
// through the Daikin HTTP API before publishing an accessory.
//
// Responsibilities:
// - Open a UDP reply socket and broadcast each discovery query
// - Forward answering IPv4 addresses for HTTP identity inspection
// - Repeat scans and release sockets and timers on shutdown
//
// Notes:
// - Daikin replies are accepted as candidates because basic_info checks the MAC
// - Each scan has a short reply window so UDP port 30000 is not held indefinitely
//
// Code version 2026.10.07
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { createSocket } from 'node:dgram';
import { clearTimeout, setTimeout } from 'node:timers';

const QUERY = 'DAIKIN_UDP/common/basic_info';
const REPLY_WINDOW = 5000;
const QUERY_PORT = 30050;
const REPLY_PORT = 30000;
const BROADCAST_ADDRESS = '255.255.255.255';

function startDiscovery(
  { onDevice, onError, interval = 60000 } = {},
  createUdpSocket = createSocket,
  clock = { setTimeout, clearTimeout },
) {
  // Discovery knows neither Homebridge logging nor accessory creation.
  if (typeof onDevice !== 'function' || typeof onError !== 'function') {
    throw new TypeError('Discovery requires onDevice and onError callbacks');
  }

  let stopped = false;
  let socket = undefined;
  let closeTimer = undefined;
  let nextTimer = undefined;
  let scanInterval = Number.isFinite(Number(interval)) === true ? Math.max(30000, Number(interval)) : 60000;

  let reportError = (error) => {
    if (stopped === false) {
      try {
        Promise.resolve(onError(error)).catch(() => {});
      } catch {
        // A reporting callback must not crash Homebridge's UDP event handler.
      }
    }
  };

  let closeSocket = () => {
    if (socket === undefined) {
      return;
    }
    let current = socket;
    socket = undefined;
    current.removeAllListeners?.();
    // Closing a real socket is asynchronous. Keep a listener for errors queued
    // before close, while removing message/listening handlers that could do work.
    current.on('error', reportError);
    try {
      current.close();
    } catch {
      // A socket can already be closed after an asynchronous UDP error.
    }
  };

  let search = () => {
    // A scan already listening for replies should not bind a second socket.
    if (stopped === true || socket !== undefined) {
      return;
    }
    try {
      socket = createUdpSocket({ type: 'udp4', reuseAddr: true });
      let seen = new Set();
      socket.on('error', reportError);
      socket.on('message', (_message, remote) => {
        if (stopped === false && typeof remote?.address === 'string' && seen.has(remote.address) === false) {
          seen.add(remote.address);
          try {
            Promise.resolve(onDevice({ host: remote.address, address: remote.address })).catch(reportError);
          } catch (error) {
            reportError(error);
          }
        }
      });
      socket.on('listening', () => {
        try {
          socket.setBroadcast(true);
          socket.send(QUERY, QUERY_PORT, BROADCAST_ADDRESS, (error) => {
            if (error instanceof Error) {
              reportError(error);
            }
          });
        } catch (error) {
          reportError(error);
        }
      });
      socket.bind(REPLY_PORT, '0.0.0.0');

      // Close the reply socket before the next scan. The interval is measured
      // from the start of this scan, matching the configuration description.
      closeTimer = clock.setTimeout(() => {
        closeTimer = undefined;
        closeSocket();
        if (stopped === false) {
          nextTimer = clock.setTimeout(() => {
            nextTimer = undefined;
            search();
          }, scanInterval - REPLY_WINDOW);
        }
      }, REPLY_WINDOW);
    } catch (error) {
      closeSocket();
      reportError(error);
      if (stopped === false) {
        nextTimer = clock.setTimeout(() => {
          nextTimer = undefined;
          search();
        }, scanInterval);
      }
    }
  };

  search();

  return {
    search,
    stop() {
      // Homebridge and error paths may both request shutdown.
      if (stopped === true) {
        return;
      }
      stopped = true;
      clock.clearTimeout(closeTimer);
      clock.clearTimeout(nextTimer);
      closeTimer = undefined;
      nextTimer = undefined;
      closeSocket();
    },
  };
}

export { startDiscovery };
