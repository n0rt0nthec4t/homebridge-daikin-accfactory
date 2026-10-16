// Daikin Air Conditioner Platform
// Part of homebridge-daikin-accfactory
//
// Coordinates configuration, UDP discovery, Daikin clients, and bridged
// HomeKit accessories. DaikinClient owns protocol data and writes;
// the platform feeds reported state to accessories through UPDATE messages.
//
// Responsibilities:
// - Set up manually configured and discovered systems by stable MAC address
// - Give configured hosts precedence when the same system is rediscovered
// - Refresh the air conditioner and optional outdoor sensor together
// - Release discovery and platform polling during shutdown
//
// Code version 2026.10.16
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import Airconditioner from './airconditioner.js';
import TemperatureSensor from './tempsensor.js';
import { processConfig, TEMPERATURE_DEFAULTS } from './config.js';
import DaikinClient from './daikinclient.js';
import { startDiscovery } from './discovery.js';
import { setInterval, clearInterval } from 'node:timers';

export default class DaikinAccfactory {
  cachedAccessories = []; // Accessories restored from the Homebridge cache
  #trackedDevices = new Map(); // Clients and accessories keyed by Daikin MAC
  #inFlight = new Map(); // Setup requests keyed by host
  #browser = undefined; // UDP discovery session
  #shuttingDown = false; // Stop new work during shutdown
  #retryTimer = undefined; // Retry configured systems that have not yet published

  constructor(log, config, api) {
    this.log = log;
    this.api = api;

    // Set the shared HomeKitDevice module logger so device modules don't need it passed in.
    HomeKitDevice.LOGGER = log;

    // Perform validation on the configuration passed into us and set defaults if not present
    this.config = processConfig(config, this.log);

    this.api?.on?.('didFinishLaunching', async () => {
      // Manual hosts are set up first so a later UDP reply cannot replace
      // their configured address or HTTP port for the same physical unit.
      await Promise.allSettled(this.config.devices.map((device) => this.setupAirconditioner(device.system, true)));
      if (this.#shuttingDown === false && this.config.devices.length !== 0) {
        // An unidentified unit has no client to poll yet. Retry it even
        // when UDP discovery is disabled or cannot reach its network segment.
        this.#retryTimer = setInterval(async () => {
          let pending = this.config.devices.filter(
            (device) =>
              device.exclude === false &&
              [...this.#trackedDevices.values()].some(
                (tracked) => tracked.configuredSystem === device.system && tracked.device !== undefined,
              ) === false,
          );
          await Promise.allSettled(pending.map((device) => this.setupAirconditioner(device.system, true)));
        }, this.config.options.discoveryInterval * 1000);
        this.#retryTimer?.unref?.();
      }
      if (this.config.options.autoDiscover === true && this.#shuttingDown === false) {
        try {
          this.#browser = startDiscovery({
            interval: this.config.options.discoveryInterval * 1000,
            onDevice: (candidate) => this.setupAirconditioner(candidate.address, false),
            onError: (error) => this.log?.debug?.('Daikin discovery error: %s', error.message),
          });
        } catch (error) {
          this.log?.debug?.('Unable to start Daikin discovery: %s', error.message);
        }
      }
    });

    this.api?.on?.('shutdown', async () => {
      this.#shuttingDown = true;
      for (let tracked of this.#trackedDevices.values()) {
        clearInterval(tracked.timer);
        tracked.timer = undefined;
      }
      clearInterval(this.#retryTimer);
      this.#retryTimer = undefined;
      this.#browser?.stop();
      this.#browser = undefined;
      // Finish work already underway before clearing the tracked accessories.
      await Promise.allSettled([...this.#inFlight.values()]);
      await Promise.allSettled([...this.#trackedDevices.values()].map((tracked) => tracked.refresh));
      let devices = [...this.#trackedDevices.values()].flatMap((tracked) => [tracked.device, tracked.sensor].filter(Boolean));
      await Promise.allSettled(devices.map((device) => device.shutdown()));
      this.#trackedDevices.clear();
      this.#inFlight.clear();
      this.cachedAccessories = [];
    });
  }

  configureAccessory(accessory) {
    // This gets called from Homebridge each time it restores an accessory from its cache
    this?.log?.info?.('Loading accessory from cache:', accessory.displayName);

    let informationService = accessory?.getService?.(this.api.hap.Service.AccessoryInformation);
    if (informationService === undefined) {
      // Accessory is missing the required AccessoryInformation service
      // means it's not going to work and is likely a stale entry in the cache. Remove it and log an error.
      this?.log?.warn?.('Cached accessory "%s" is missing AccessoryInformation service. Removing from cache', accessory.displayName);

      try {
        this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }

      return;
    }

    // Accessory has the required AccessoryInformation service, so we can add the restored accessory to the accessories cache
    // This allows us to track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async setupAirconditioner(system, configured) {
    // A repeated UDP reply for one host shares its current setup request.
    if (this.#shuttingDown === true || this.#inFlight.has(system) === true) {
      return this.#inFlight.get(system);
    }

    let operation = (async () => {
      let override = this.config.devices.find((device) => device.system === system);
      let client = new DaikinClient(system, override?.httpPort ?? this.config.options.httpPort);
      let mac = await client.identify();
      if (mac === undefined || this.#shuttingDown === true) {
        if (mac === undefined && configured === true) {
          this.log?.error?.('Specified Daikin system "%s" could not be contacted', system);
        }
        return;
      }

      // Map insertion is synchronous. Concurrent hosts resolving the same MAC
      // share one tracked entry before asynchronous publication starts.
      let tracked = this.#trackedDevices.get(mac);
      if (tracked === undefined) {
        tracked = {
          client,
          configuredSystem: configured === true ? system : undefined,
          device: undefined,
          sensor: undefined,
          refresh: undefined,
          timer: undefined,
          polling: false,
        };
        this.#trackedDevices.set(mac, tracked);
      } else {
        if (configured === true || tracked.configuredSystem === undefined) {
          tracked.client.setAddress(system, client.httpPort);
        }
        if (configured === true) {
          tracked.configuredSystem = system;
        }
        tracked.client.info = client.info;
      }
      await this.refresh(tracked);
      this.#startPolling(tracked);
    })()
      .catch((error) => {
        if (configured === true) {
          this.log?.error?.('Specified Daikin system "%s" could not be contacted: %s', system, error.message);
        } else {
          this.log?.debug?.('Unable to inspect Daikin system at %s: %s', system, error.message);
        }
      })
      .finally(() => this.#inFlight.delete(system));

    this.#inFlight.set(system, operation);
    return operation;
  }

  #startPolling(tracked) {
    if (this.#shuttingDown === true || tracked.device === undefined || tracked.timer !== undefined) {
      return;
    }

    // Like Denon's REST connections, each client is polled independently by
    // the platform. Slow requests skip that unit's next tick rather than
    // delaying other units or accumulating queued refreshes.
    let poll = async () => {
      if (this.#shuttingDown === true || tracked.polling === true) {
        return;
      }
      tracked.polling = true;
      try {
        await this.refresh(tracked);
      } finally {
        tracked.polling = false;
      }
    };
    tracked.timer = setInterval(poll, this.config.options.pollInterval * 1000);
    tracked.timer?.unref?.();
  }

  refresh(tracked, changes = undefined) {
    // Only HTTP work owns this queue. Waiting for a HomeKit UPDATE here would
    // deadlock when an active SET is waiting for a preceding poll to finish.
    let update = async () => {
      if (this.#shuttingDown === true) {
        if (changes !== undefined) {
          throw new Error('Daikin platform is shutting down');
        }
        return;
      }
      let client = tracked.client;
      // Commands and polls share one queue. Each partial command is merged
      // only after earlier writes and their status refreshes have completed.
      if (changes !== undefined) {
        await client.set(changes, tracked.device?.deviceData);
      }
      try {
        await client.poll();
      } catch (error) {
        this.log?.debug?.('Daikin poll failed for %s: %s', client.system, error.message);
      }
      if (this.#shuttingDown === true) {
        return;
      }

      return true;
    };

    tracked.refresh = (tracked.refresh ?? Promise.resolve()).then(update).catch((error) => {
      this.log?.warn?.('Unable to update Daikin accessory: %s', error.message);
      // Preserve the caller's failure result while keeping subsequent HTTP work usable.
      return false;
    });
    return tracked.refresh
      .then((refreshed) => {
        // The SET caller requests publication after its state ownership ends.
        if (changes !== undefined || refreshed !== true) {
          return refreshed;
        }
        if (tracked.device === undefined) {
          // Discovery and configured-host setup can converge on the same MAC
          // before add() finishes. Keep initial publication ordered as well.
          tracked.publication = (tracked.publication ?? Promise.resolve()).catch(() => {}).then(() => this.#publish(tracked));
          return tracked.publication;
        }
        return HomeKitDevice.message(tracked.device.uuid, Airconditioner.REPORT);
      })
      .catch((error) => {
        this.log?.warn?.('Unable to publish Daikin accessory: %s', error.message);
        return false;
      });
  }

  // Publication has its own HomeKit lifecycle slot, outside the HTTP queue and SET.
  async #publish(tracked) {
    if (this.#shuttingDown === true) {
      return;
    }
    let client = tracked.client;
    let override = this.config.devices.find((device) => device.system === client.system);
    let data = client.deviceData(override);
    if (data === undefined) {
      return;
    }
    data.description = HomeKitDevice.makeValidHKName(data.description) || 'Daikin Air Conditioner';
    for (let field of Object.keys(TEMPERATURE_DEFAULTS)) {
      data[field] = override?.[field] ?? TEMPERATURE_DEFAULTS[field];
    }
    data.eveHistory = override?.eveHistory ?? this.config.options.eveHistory;
    let deviceUuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, data.serialNumber);
    let sensorUuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, data.serialNumber + 'OUTSIDE');
    if (tracked.device === undefined && data.excluded === true) {
      this.log?.warn?.('Device "%s" is ignored due to it being marked as excluded', data.description);
      let accessories = this.cachedAccessories.filter((accessory) => accessory?.UUID === deviceUuid || accessory?.UUID === sensorUuid);
      if (accessories.length !== 0) {
        try {
          this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, accessories);
          this.cachedAccessories = this.cachedAccessories.filter((accessory) => accessories.includes(accessory) === false);
        } catch (error) {
          this.log?.debug?.('Unable to remove excluded accessory "%s" from cache: %s', data.description, error.message);
        }
      }
      return;
    }

    if (tracked.device === undefined) {
      let device = new Airconditioner(this.cachedAccessories, this.api, data);
      HomeKitDevice.message(device.uuid, HomeKitDevice.SET, async (values) => {
        let refreshed = await this.refresh(tracked, values.control ?? values);
        if (refreshed === false) {
          throw new Error('Daikin control request failed');
        }
      });
      HomeKitDevice.message(device.uuid, Airconditioner.REPORT, () => this.#publish(tracked));
      let added = await device.add({
        hapAccessoryName: 'Daikin Air Conditioner',
        hapCategory: this.api.hap.Categories.AIR_CONDITIONER,
        enableHistory: data.eveHistory === true,
      });
      if (added !== true) {
        await device.remove();
        return;
      }
      tracked.device = device;
    }
    await HomeKitDevice.message(tracked.device.uuid, HomeKitDevice.UPDATE, data);

    let externalSensor = override?.externalSensor ?? this.config.options.externalSensor;
    let cachedSensor = this.cachedAccessories.find((accessory) => accessory?.UUID === sensorUuid);
    if (externalSensor === false && cachedSensor !== undefined) {
      try {
        this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [cachedSensor]);
        this.cachedAccessories = this.cachedAccessories.filter((accessory) => accessory !== cachedSensor);
      } catch (error) {
        this.log?.debug?.('Unable to remove disabled outdoor sensor for "%s" from cache: %s', data.description, error.message);
      }
    }
    if (externalSensor === true && (data.otemp !== undefined || tracked.sensor !== undefined || cachedSensor !== undefined)) {
      let sensorData = {
        serialNumber: data.serialNumber + 'OUTSIDE',
        manufacturer: data.manufacturer,
        description: HomeKitDevice.makeValidHKName(data.description + ' Outside Temperature'),
        model: data.model,
        softwareVersion: data.softwareVersion,
        online: data.online === true && data.otemp !== undefined,
        oTemp: data.otemp ?? tracked.sensor?.deviceData.oTemp,
        eveHistory: data.eveHistory,
      };
      if (tracked.sensor === undefined) {
        let sensor = new TemperatureSensor(this.cachedAccessories, this.api, sensorData);
        let added = await sensor.add({
          hapAccessoryName: 'Daikin Outdoor Temperature Sensor',
          hapCategory: this.api.hap.Categories.SENSOR,
          enableHistory: sensorData.eveHistory === true,
        });
        if (added !== true) {
          await sensor.remove();
          return;
        }
        tracked.sensor = sensor;
      }
      await HomeKitDevice.message(tracked.sensor.uuid, HomeKitDevice.UPDATE, sensorData);
    }
  }
}
