// Daikin Outdoor Temperature Sensor
// Part of homebridge-daikin-accfactory
//
// Publishes a separate HomeKit sensor from the outdoor compressor reading
// when enabled in platform configuration.
//
// Responsibilities:
// - Create or restore the HomeKit TemperatureSensor service
// - Apply polled outdoor temperature
//
// Notes:
// - The platform retains the last valid temperature if a reading is missing
// - Daikin reports indoor humidity (hhum), but no outdoor humidity or air pressure
// - Network acquisition stays in the platform and Daikin client modules
//
// Code version 2026.10.07
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

export default class TemperatureSensor extends HomeKitDevice {
  static TYPE = 'temperature';
  static VERSION = '2026.10.07';

  batteryService = undefined;
  temperatureService = undefined;

  // Class functions
  onAdd() {
    // Setup temperature service if not already present on the accessory
    this.temperatureService = this.addService(this.hap.Service.TemperatureSensor, '', 1, { messages: this.message.bind(this) });
    this.temperatureService.setPrimaryService();

    // Setup battery service if not already present on the accessory (required for EveHome support)
    this.batteryService = this.addService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);

    // Older versions added a weather service even though Daikin supplies no
    // pressure reading. Remove it from restored accessories.
    if (this.hap.Service?.EveAirPressureSensor !== undefined) {
      this.removeService(this.accessory.getService(this.hap.Service.EveAirPressureSensor));
    }
  }

  onRemove() {
    this.removeService(this.temperatureService);
    this.removeService(this.batteryService);
    this.temperatureService = undefined;
    this.batteryService = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.temperatureService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    if (Number.isFinite(deviceData.oTemp) === true) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.oTemp);
    }

    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, 100);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.temperatureService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);
    this.temperatureService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    // If we have the history service running, record temperature every 5mins
    if (deviceData.online === true && Number.isFinite(deviceData.oTemp) === true) {
      this.history(this.temperatureService, { temperature: deviceData.oTemp }, { timegap: 300, force: true });
    }
  }
}
