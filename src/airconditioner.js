// Daikin HomeKit Air Conditioner
// Part of homebridge-daikin-accfactory
//
// Presents one Daikin system through heater/cooler, fan, and dehumidifier
// services. The services share one physical operating mode.
//
// Responsibilities:
// - Create and update HomeKit services and characteristic handlers
// - Translate HomeKit mode, temperature, humidity, fan, and swing changes
// - Route complete control changes through the HomeKitDevice SET handler
//
// Notes:
// - Only the service matching the current mode sends speed and swing changes
// - DaikinClient merges partial commands with the latest control snapshot
//
// Code version 2026.10.16
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { TEMPERATURE_DEFAULTS } from './config.js';

// Daikin values used by the local HTTP API
const POWER = { ON: 1, OFF: 0 };
const MODE = { AUTO: 7, DEHUMIDIFIER: 2, COOL: 3, HEAT: 4, FAN: 6 };
const FAN_RATE = { AUTO: 'A', QUIET: 'B', LEVEL1: '3', LEVEL2: '4', LEVEL3: '5', LEVEL4: '6', LEVEL5: '7' };
const FAN_DIRECTION = { STOP: 0, VERTICAL: 1, HORIZONTAL: 2, SWING: 3 };
const FAN_RATES = Object.values(FAN_RATE);

function fanRatePercent(rate) {
  let index = FAN_RATES.indexOf(String(rate).toUpperCase());
  return index < 0 ? 0 : Math.round(((index + 1) / FAN_RATES.length) * 100);
}

export default class Airconditioner extends HomeKitDevice {
  static TYPE = 'airconditioner';
  static VERSION = '2026.10.16';
  static REPORT = 'Daikin.onReport'; // Publish polled state after SET releases state ownership.

  heaterCoolerService = undefined; // HomeKit HeaterCooler service
  fanService = undefined; // HomeKit Fanv2 service
  dehumidifierService = undefined; // HomeKit HumidifierDehumidifier service

  // Class functions
  onAdd() {
    // Setup the primary heater/cooler service and link it to Eve when history is enabled.
    this.heaterCoolerService = this.addService(this.hap.Service.HeaterCooler, '', 1, { messages: this.message.bind(this) });
    this.heaterCoolerService.setPrimaryService();

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.CurrentTemperature, {
      onGet: () => {
        let value =
          Number.isFinite(this.deviceData.htemp) === true
            ? this.deviceData.htemp
            : this.heaterCoolerService.getCharacteristic(this.hap.Characteristic.CurrentTemperature).value;
        return Number.isFinite(value) === true ? value : 0;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.CurrentRelativeHumidity, {
      onGet: () => {
        let value =
          Number.isFinite(this.deviceData.hhum) === true
            ? this.deviceData.hhum
            : this.heaterCoolerService.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity).value;
        return Number.isFinite(value) === true ? value : 0;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.Active, {
      onSet: (value) => {
        // Active controls power only; TargetHeaterCoolerState owns the mode.
        // A simultaneous power-on must not resend the previous cooling mode.
        return this.setState({ pow: value === this.hap.Characteristic.Active.ACTIVE ? POWER.ON : POWER.OFF });
      },
      onGet: () => {
        return this.deviceData.pow === POWER.ON && [MODE.AUTO, MODE.COOL, MODE.HEAT].includes(this.deviceData.mode) === true
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.TargetHeaterCoolerState, {
      onSet: (value) => {
        let mode = MODE.AUTO;
        if (value === this.hap.Characteristic.TargetHeaterCoolerState.COOL) {
          mode = MODE.COOL;
        }
        if (value === this.hap.Characteristic.TargetHeaterCoolerState.HEAT) {
          mode = MODE.HEAT;
        }
        return this.setMode(mode);
      },
      onGet: () => {
        if (this.deviceData.mode === MODE.COOL) {
          return this.hap.Characteristic.TargetHeaterCoolerState.COOL;
        }
        if (this.deviceData.mode === MODE.HEAT) {
          return this.hap.Characteristic.TargetHeaterCoolerState.HEAT;
        }
        return this.hap.Characteristic.TargetHeaterCoolerState.AUTO;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.CoolingThresholdTemperature, {
      initialValue: this.deviceData.mode === MODE.AUTO ? this.deviceData.dt7 : this.deviceData.dt3,
      props: {
        minValue: this.deviceData.mode === MODE.AUTO ? this.deviceData.autoMin : this.deviceData.coolingMin,
        maxValue: this.deviceData.mode === MODE.AUTO ? this.deviceData.autoMax : this.deviceData.coolingMax,
        minStep: 1,
      },
      onSet: (value) => this.setTemperature(value, MODE.COOL),
      onGet: () => {
        return this.deviceData.mode === MODE.AUTO ? this.deviceData.dt7 : this.deviceData.dt3;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.HeatingThresholdTemperature, {
      initialValue: this.deviceData.mode === MODE.AUTO ? this.deviceData.dt7 : this.deviceData.dt4,
      props: {
        minValue: this.deviceData.mode === MODE.AUTO ? this.deviceData.autoMin : this.deviceData.heatingMin,
        maxValue: this.deviceData.mode === MODE.AUTO ? this.deviceData.autoMax : this.deviceData.heatingMax,
        minStep: 1,
      },
      onSet: (value) => this.setTemperature(value, MODE.HEAT),
      onGet: () => {
        return this.deviceData.mode === MODE.AUTO ? this.deviceData.dt7 : this.deviceData.dt4;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.SwingMode, {
      onSet: (value) => this.setAirflow('heater', { swing: value }),
      onGet: () => {
        let suffix = [MODE.AUTO, MODE.COOL, MODE.HEAT].includes(this.deviceData.mode) === true ? this.deviceData.mode : MODE.AUTO;
        return this.deviceData['dfd' + suffix] === FAN_DIRECTION.STOP
          ? this.hap.Characteristic.SwingMode.SWING_DISABLED
          : this.hap.Characteristic.SwingMode.SWING_ENABLED;
      },
    });

    this.addCharacteristic(this.heaterCoolerService, this.hap.Characteristic.RotationSpeed, {
      props: { minValue: 0, maxValue: 100, minStep: 100 / FAN_RATES.length },
      onSet: (value) => this.setAirflow('heater', { speed: value }),
      onGet: () => {
        let suffix = [MODE.AUTO, MODE.COOL, MODE.HEAT].includes(this.deviceData.mode) === true ? this.deviceData.mode : MODE.AUTO;
        return fanRatePercent(this.deviceData['dfr' + suffix]);
      },
    });

    // Fan and dehumidifier are secondary controls for the same physical system.
    this.fanService = this.addService(this.hap.Service.Fanv2, '', 1);
    this.heaterCoolerService.addLinkedService(this.fanService);
    this.addCharacteristic(this.fanService, this.hap.Characteristic.Active, {
      onSet: (value) => this.setMode(MODE.FAN, value),
      onGet: () => {
        return this.deviceData.pow === POWER.ON && this.deviceData.mode === MODE.FAN
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    this.addCharacteristic(this.fanService, this.hap.Characteristic.SwingMode, {
      onSet: (value) => this.setAirflow('fan', { swing: value }),
      onGet: () => {
        return this.deviceData.dfd6 === FAN_DIRECTION.STOP
          ? this.hap.Characteristic.SwingMode.SWING_DISABLED
          : this.hap.Characteristic.SwingMode.SWING_ENABLED;
      },
    });

    this.addCharacteristic(this.fanService, this.hap.Characteristic.RotationSpeed, {
      props: { minValue: 0, maxValue: 100, minStep: 100 / FAN_RATES.length },
      onSet: (value) => this.setAirflow('fan', { speed: value }),
      onGet: () => {
        return fanRatePercent(this.deviceData.dfr6);
      },
    });

    this.dehumidifierService = this.addService(this.hap.Service.HumidifierDehumidifier, '', 1);
    this.heaterCoolerService.addLinkedService(this.dehumidifierService);
    this.addCharacteristic(this.dehumidifierService, this.hap.Characteristic.Active, {
      onSet: (value) => this.setMode(MODE.DEHUMIDIFIER, value),
      onGet: () => {
        return this.deviceData.pow === POWER.ON && this.deviceData.mode === MODE.DEHUMIDIFIER
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    this.addCharacteristic(this.dehumidifierService, this.hap.Characteristic.CurrentHumidifierDehumidifierState, {
      onGet: () => {
        return this.deviceData.pow === POWER.ON && this.deviceData.mode === MODE.DEHUMIDIFIER
          ? this.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING
          : this.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
      },
    });

    this.addCharacteristic(this.dehumidifierService, this.hap.Characteristic.TargetHumidifierDehumidifierState, {
      props: {
        validValues: [this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
      },
      initialValue: this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
    });

    // HumidifierDehumidifier requires this characteristic even without a sensor.
    // Retain its last reading, or the numeric default when none exists, so a
    // missing sensor cannot make the service unavailable to HomeKit.
    this.addCharacteristic(this.dehumidifierService, this.hap.Characteristic.CurrentRelativeHumidity, {
      onGet: () => {
        let value =
          Number.isFinite(this.deviceData.hhum) === true
            ? this.deviceData.hhum
            : this.dehumidifierService.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity).value;
        return Number.isFinite(value) === true ? value : 0;
      },
    });

    this.addCharacteristic(this.dehumidifierService, this.hap.Characteristic.SwingMode, {
      onSet: (value) => this.setAirflow('dry', { swing: value }),
      onGet: () => {
        return this.deviceData.dfd2 === FAN_DIRECTION.STOP
          ? this.hap.Characteristic.SwingMode.SWING_DISABLED
          : this.hap.Characteristic.SwingMode.SWING_ENABLED;
      },
    });

    this.addCharacteristic(this.dehumidifierService, this.hap.Characteristic.RelativeHumidityDehumidifierThreshold, {
      onSet: (value) => {
        if (this.deviceData.mode === MODE.DEHUMIDIFIER) {
          return this.setState({ shum: value });
        }
      },
      onGet: () => {
        return this.deviceData.dh2;
      },
    });
  }

  onRemove() {
    this.removeService(this.heaterCoolerService);
    this.removeService(this.fanService);
    this.removeService(this.dehumidifierService);
    this.heaterCoolerService = undefined;
    this.fanService = undefined;
    this.dehumidifierService = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.heaterCoolerService === undefined ||
      this.fanService === undefined ||
      this.dehumidifierService === undefined
    ) {
      return;
    }

    let powered = deviceData.pow === POWER.ON;
    let heaterMode = [MODE.AUTO, MODE.COOL, MODE.HEAT].includes(deviceData.mode) === true;
    let targetState = this.hap.Characteristic.TargetHeaterCoolerState.AUTO;
    let currentState = this.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    let heaterSuffix = '7';
    let historyEntry = {
      status: 0,
      target: { low: 0, high: 0 },
    };

    // Report availability and current environmental readings.
    this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);
    this.heaterCoolerService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );
    if (Number.isFinite(deviceData.htemp) === true) {
      this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.htemp);
    }
    if (Number.isFinite(deviceData.hhum) === true) {
      this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.hhum);
    }

    // Widen limits before applying a new mode's readings. Overrides can make
    // auto wider than cooling or heating, so either transition can expand them.
    let thresholds = [
      [this.hap.Characteristic.CoolingThresholdTemperature, 'cooling'],
      [this.hap.Characteristic.HeatingThresholdTemperature, 'heating'],
    ];
    for (let [type, mode] of thresholds) {
      let characteristic = this.heaterCoolerService.getCharacteristic(type);
      let prefix = deviceData.mode === MODE.AUTO ? 'auto' : mode;
      characteristic.setProps({
        minValue: Math.min(characteristic.props.minValue, deviceData[prefix + 'Min']),
        maxValue: Math.max(characteristic.props.maxValue, deviceData[prefix + 'Max']),
      });
    }

    // Map the selected Daikin heating/cooling mode and its target temperatures.
    if (deviceData.mode === MODE.AUTO) {
      if (powered === true) {
        currentState = this.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
      }
      if (Number.isFinite(deviceData.dt7) === true) {
        this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature, deviceData.dt7);
        this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, deviceData.dt7);
        historyEntry.target = { low: deviceData.dt7, high: deviceData.dt7 };
      }
      if (powered === true && Number.isFinite(deviceData.htemp) === true && Number.isFinite(deviceData.dt7) === true) {
        currentState =
          deviceData.htemp > deviceData.dt7
            ? this.hap.Characteristic.CurrentHeaterCoolerState.COOLING
            : deviceData.htemp < deviceData.dt7
              ? this.hap.Characteristic.CurrentHeaterCoolerState.HEATING
              : this.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
      }
    }

    if (deviceData.mode === MODE.COOL) {
      targetState = this.hap.Characteristic.TargetHeaterCoolerState.COOL;
      heaterSuffix = '3';
      if (Number.isFinite(deviceData.dt3) === true) {
        this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature, deviceData.dt3);
        historyEntry.target = { low: deviceData.dt3, high: 0 };
      }
      if (powered === true) {
        currentState = this.hap.Characteristic.CurrentHeaterCoolerState.COOLING;
      }
    }

    if (deviceData.mode === MODE.HEAT) {
      targetState = this.hap.Characteristic.TargetHeaterCoolerState.HEAT;
      heaterSuffix = '4';
      if (Number.isFinite(deviceData.dt4) === true) {
        this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, deviceData.dt4);
        historyEntry.target = { low: 0, high: deviceData.dt4 };
      }
      if (powered === true) {
        currentState = this.hap.Characteristic.CurrentHeaterCoolerState.HEATING;
      }
    }

    if (powered === true && heaterMode === false) {
      currentState = this.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
    }
    if (powered === false) {
      historyEntry.target = { low: 0, high: 0 };
    }

    // Finish with the selected mode's limits after replacing its target.
    for (let [type, mode] of thresholds) {
      let prefix = deviceData.mode === MODE.AUTO ? 'auto' : mode;
      this.heaterCoolerService.getCharacteristic(type).setProps({
        minValue: deviceData[prefix + 'Min'],
        maxValue: deviceData[prefix + 'Max'],
        minStep: 1,
      });
    }

    this.heaterCoolerService.updateCharacteristic(
      this.hap.Characteristic.Active,
      powered === true && heaterMode === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );
    this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.TargetHeaterCoolerState, targetState);
    this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.CurrentHeaterCoolerState, currentState);
    this.heaterCoolerService.updateCharacteristic(
      this.hap.Characteristic.SwingMode,
      deviceData['dfd' + heaterSuffix] === FAN_DIRECTION.STOP
        ? this.hap.Characteristic.SwingMode.SWING_DISABLED
        : this.hap.Characteristic.SwingMode.SWING_ENABLED,
    );
    this.heaterCoolerService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, fanRatePercent(deviceData['dfr' + heaterSuffix]));

    // Update the fan service. It is active only when the shared system is in fan mode.
    this.fanService.updateCharacteristic(
      this.hap.Characteristic.Active,
      powered === true && deviceData.mode === MODE.FAN ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );
    this.fanService.updateCharacteristic(
      this.hap.Characteristic.SwingMode,
      deviceData.dfd6 === FAN_DIRECTION.STOP
        ? this.hap.Characteristic.SwingMode.SWING_DISABLED
        : this.hap.Characteristic.SwingMode.SWING_ENABLED,
    );
    this.fanService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, fanRatePercent(deviceData.dfr6));

    // Update the dehumidifier service. It shares power and mode with the air conditioner.
    this.dehumidifierService.updateCharacteristic(
      this.hap.Characteristic.Active,
      powered === true && deviceData.mode === MODE.DEHUMIDIFIER
        ? this.hap.Characteristic.Active.ACTIVE
        : this.hap.Characteristic.Active.INACTIVE,
    );
    this.dehumidifierService.updateCharacteristic(
      this.hap.Characteristic.CurrentHumidifierDehumidifierState,
      powered === true && deviceData.mode === MODE.DEHUMIDIFIER
        ? this.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING
        : this.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
    );
    this.dehumidifierService.updateCharacteristic(
      this.hap.Characteristic.SwingMode,
      deviceData.dfd2 === FAN_DIRECTION.STOP
        ? this.hap.Characteristic.SwingMode.SWING_DISABLED
        : this.hap.Characteristic.SwingMode.SWING_ENABLED,
    );
    if (Number.isFinite(deviceData.hhum) === true) {
      this.dehumidifierService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.hhum);
    }
    if (Number.isFinite(deviceData.dh2) === true) {
      this.dehumidifierService.updateCharacteristic(this.hap.Characteristic.RelativeHumidityDehumidifierThreshold, deviceData.dh2);
    }

    // Record one Eve history entry for the physical system.
    if (powered === true) {
      if (currentState === this.hap.Characteristic.CurrentHeaterCoolerState.HEATING) {
        historyEntry.status = 2;
      }
      if (currentState === this.hap.Characteristic.CurrentHeaterCoolerState.COOLING) {
        historyEntry.status = 1;
      }
    }
    if (deviceData.online === true && Number.isFinite(deviceData.htemp) === true) {
      this.history(
        this.heaterCoolerService,
        {
          ...historyEntry,
          temperature: deviceData.htemp,
          humidity: Number.isFinite(deviceData.hhum) === true ? deviceData.hhum : 0,
        },
        { timegap: 300, force: true },
      );
    }
  }

  setMode(mode, active = this.hap.Characteristic.Active.ACTIVE) {
    // Turning an inactive service off must not stop a different active mode.
    let requestedFamily = mode === MODE.FAN ? 'fan' : mode === MODE.DEHUMIDIFIER ? 'dry' : 'heater';
    let currentFamily = this.deviceData.mode === MODE.FAN ? 'fan' : this.deviceData.mode === MODE.DEHUMIDIFIER ? 'dry' : 'heater';
    if (active === this.hap.Characteristic.Active.INACTIVE) {
      if (requestedFamily === currentFamily) {
        return this.setState({ pow: POWER.OFF });
      }
      return;
    }

    if ([MODE.AUTO, MODE.DEHUMIDIFIER, MODE.COOL, MODE.HEAT, MODE.FAN].includes(mode) === false) {
      return;
    }

    // The client fills mode-specific protocol fields from the latest queued
    // snapshot. HomeKit services are refreshed through onUpdate after polling.
    return this.setState({ pow: POWER.ON, mode });
  }

  setTemperature(value, mode) {
    // Only write the temperature of the currently selected heating family.
    if ([MODE.COOL, MODE.HEAT, MODE.AUTO].includes(mode) === false) {
      return;
    }
    let prefix = this.deviceData.mode === MODE.AUTO || mode === MODE.AUTO ? 'auto' : mode === MODE.COOL ? 'cooling' : 'heating';
    let minimum = this.deviceData[prefix + 'Min'] ?? TEMPERATURE_DEFAULTS[prefix + 'Min'];
    let maximum = this.deviceData[prefix + 'Max'] ?? TEMPERATURE_DEFAULTS[prefix + 'Max'];
    if (Number.isFinite(value) === false || value < minimum || value > maximum) {
      return;
    }
    if (this.deviceData.mode === MODE.AUTO || this.deviceData.mode === mode) {
      return this.setState({ stemp: value });
    }
  }

  setAirflow(family, values) {
    // Only the service representing the active Daikin mode can change airflow.
    let currentFamily = this.deviceData.mode === MODE.FAN ? 'fan' : this.deviceData.mode === MODE.DEHUMIDIFIER ? 'dry' : 'heater';
    if (family !== currentFamily || typeof values !== 'object' || values?.constructor !== Object) {
      return;
    }

    if (Number.isFinite(values.speed) === true) {
      // HomeKit exposes each rate at the upper edge of its percentage band,
      // so use the matching one-based band when converting it back to Daikin.
      let index = Math.min(FAN_RATES.length - 1, Math.max(0, Math.round((values.speed / 100) * FAN_RATES.length) - 1));
      return this.setState({ f_rate: FAN_RATES[index] });
    }
    if (values.swing !== undefined) {
      return this.setState({
        f_dir: values.swing === this.hap.Characteristic.SwingMode.SWING_ENABLED ? FAN_DIRECTION.SWING : FAN_DIRECTION.STOP,
      });
    }
  }

  async setState(values) {
    // HomeKit must receive an error when the Daikin rejects or cannot receive a command.
    // Keep protocol requests separate from deviceData: only a reported UPDATE
    // should change the accessory snapshot, including after a failed command.
    let result = await HomeKitDevice.message(this.uuid, HomeKitDevice.SET, { control: values });
    if (result === false) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    // UPDATE cannot take state ownership inside SET. Await the report only after
    // SET has completed; the platform keeps its network queue independent of it.
    await this.message(Airconditioner.REPORT);
  }
}
