// HAP-NodeJS accessory for Daikin Aircon
//
// Daikin A/C control 
// https://github.com/ael-code/daikin-control
// https://github.com/Apollon77/daikin-controller
//
// todo
// -- Can we automatically get Model/Serial numbers??
// -- Occupancy sensor for home/away
// -- Can we subscribe to updates rather than poll?? UDP??'
//
//
// done
// -- history recording - testing of own solution
// -- discover all ACs on the local network and create accessories for each one
// -- switched to axios library
// -- Update accessory firmware version in status update 
// -- Create outdoor tempature sensor rather than seperate accessory
// -- accessories are advertised using "ciao" backend for hap-nodejs
// -- dymanically add new devices
// -- rewrite to use "common" HomeKit device class
//
// bugs
// [Daikin Air-conditioner@Air-conditioner@Cooling Threshold Temperature] characteristic was supplied illegal value: number 10 exceeded minimum of 18
// [Daikin Air-conditioner@Air-conditioner@Heating Threshold Temperature] characteristic was supplied illegal value: number 0 exceeded minimum of 18
// [Daikin Air-conditioner@Dehumidifier@Target Humidifier-Dehumidifier State] characteristic value 0 is not contained in valid values array
//
//
// Code version 22/4/2024
// Mark Hulskamp

module.exports = accessories = [];

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define external library requirements
var axios = require("axios");

// Define nodejs module requirements
var util = require("util");
var EventEmitter = require("events");
var dgram = require('dgram');   // for UDP

// Define our external module requirements
var HomeKitHistory = require("./HomeKitHistory");
var HomeKitDevice = require("./HomeKitDevice");
HomeKitDevice.HOMEKITHISTORY = HomeKitHistory;                  // History module for the device
const MDNSPROVIDER = HAP.MDNSAdvertiser.CIAO;                   // mDNS Provider we'll use 
const ACCESSORYNAME = "Daikin";                                 // Used for manufacturer name of HomeKit device
const ACCESSORYPINCODE = "031-45-154";                          // HomeKit pairing code
          

// Daikin Airconditioner
class AirconditionerClass extends HomeKitDevice {
    constructor(initialDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, MDNSPROVIDER, initialDeviceData, globalEventEmitter);

        this.HeaterCoolerService = null;            // HomeKit service for this Airconditioner
        this.DehumidService = null;                 // HomeKit service for the dehumidifier of the airconditioner
        this.FanService = null;                     // HomeKit service for the fan mode of the airconditioner
        this.OccupancyService = null;               // HomeKit service for Status of Away/Home
        this.cachedOptions = {};                    // Options we need to cache for later selecting
    }

    // Class functions
    addHomeKitServices(serviceName) {
        // Add this airconditioner to the "master" accessory and set properties
        this.HeaterCoolerService = this.HomeKitAccessory.addService(HAP.Service.HeaterCooler, "Air-conditioner", 1);
        this.HeaterCoolerService.addCharacteristic(HAP.Characteristic.StatusActive);
        this.HeaterCoolerService.addOptionalCharacteristic(HAP.Characteristic.SwingMode);
        this.HeaterCoolerService.addOptionalCharacteristic(HAP.Characteristic.RotationSpeed);
        if (typeof this.deviceData.hhum == "number") {
            // If the air-conditioner does indoor humidity sensing, add this under the heater/cooler service
            this.HeaterCoolerService.addCharacteristic(HAP.Characteristic.CurrentRelativeHumidity);
        }

        // Add this fan to the "master" accessory and set properties
        this.FanService = this.HomeKitAccessory.addService(HAP.Service.Fanv2, "Fan", 1);
        this.FanService.addOptionalCharacteristic(HAP.Characteristic.SwingMode);
        this.FanService.addOptionalCharacteristic(HAP.Characteristic.RotationSpeed);

        // Add this dehumifier to the "master" accessory and set properties
        this.DehumidService = this.HomeKitAccessory.addService(HAP.Service.HumidifierDehumidifier, "Dehumidifier", 1);
        this.DehumidService.addOptionalCharacteristic(HAP.Characteristic.SwingMode);
        this.DehumidService.addOptionalCharacteristic(HAP.Characteristic.RelativeHumidityDehumidifierThreshold);

        // Limit prop ranges
        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).setProps({minStep: 1, minValue: 18, maxValue: 32});  // Only "whole" temperature values supported by Daikin
        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).setProps({minStep: 1, minValue: 18, maxValue: 32});  // Only "whole" temperature values supported by Daikin
        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.RotationSpeed).setProps({minStep: (100 / Object.keys(FanRate).length), minValue: 0, maxValue: 100});
        this.FanService.getCharacteristic(HAP.Characteristic.RotationSpeed).setProps({minStep: (100 / Object.keys(FanRate).length), minValue: 0, maxValue: 100});
        this.DehumidService.getCharacteristic(HAP.Characteristic.TargetHumidifierDehumidifierState).setProps({validValues: [HAP.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER]});
        
        // Setup callbacks for characteristics
        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.Active).on("set", (value, callback) => {this.setMode(value, callback, "ACTIVESTATE")});
        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.TargetHeaterCoolerState).on("set", (value, callback) => {this.setMode(value, callback, [Mode.AUTO, Mode.COOL, Mode.HEAT])});
        this.FanService.getCharacteristic(HAP.Characteristic.Active).on("set", (value, callback) => {this.setMode(value, callback, Mode.FAN)});
        this.DehumidService.getCharacteristic(HAP.Characteristic.Active).on("set", (value, callback) => {this.setMode(value, callback, Mode.DEHUMIDIFIER)});

        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.RotationSpeed).on("set", (value, callback) => {this.setFanSpeed(value, callback, this.HeaterCoolerService)});
        this.FanService.getCharacteristic(HAP.Characteristic.RotationSpeed).on("set", (value, callback) => {this.setFanSpeed(value, callback, this.FanService)});

        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.SwingMode).on("set", (value, callback) => {this.setFanDirection(value, callback, this.HeaterCoolerService)});
        this.FanService.getCharacteristic(HAP.Characteristic.SwingMode).on("set", (value, callback) => {this.setFanDirection(value, callback, this.FanService)});
        this.DehumidService.getCharacteristic(HAP.Characteristic.SwingMode).on("set", (value, callback) => {this.setFanDirection(value, callback, this.DehumidService)});

        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(value, callback, HAP.Characteristic.CoolingThresholdTemperature)});
        this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(value, callback, HAP.Characteristic.HeatingThresholdTemperature)});

        this.DehumidService.getCharacteristic(HAP.Characteristic.RelativeHumidityDehumidifierThreshold).on("set", (value, callback) => {this.setHumidty(value, callback)});

        this.HomeKitAccessory.setPrimaryService(this.HeaterCoolerService); // This is the primary service

        // Setup linkage to EveHome app if configured todo so
        this.deviceData.EveApp && this.HomeKitHistory && this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.HeaterCoolerService, {});

        outputLogging(ACCESSORYNAME, false, "Setup Air-conditioner '%s'", serviceName);
    }

    setMode(value, callback, context) {
        if (context == Mode.FAN) {
            // We're operating in fan mode.The value parameter will either be 0, off or 1, on
            var powerState = (value == HAP.Characteristic.Active.ACTIVE ? Power.ON : Power.OFF);
            var swingMode = (this.FanService.getCharacteristic(HAP.Characteristic.SwingMode).value == HAP.Characteristic.SwingMode.SWING_ENABLED ? FanDirection.SWING : FanDirection.STOP);
            var rotationSpeed = this.#HomeKitToDaikinFanSpeed(this.FanService.getCharacteristic(HAP.Characteristic.RotationSpeed).value);
            this.set({"pow" : powerState, "mode" : Mode.FAN, "f_dir" : swingMode, "f_rate" : rotationSpeed});
            this.cachedOptions.mode = Mode.FAN;
            this.cachedOptions.pow = powerState;
        }
        if (context == Mode.DEHUMIDIFIER) {
            // We're operating in dehumifier mode. The value parameter will either be 0, off or 1, on
            var powerState = (value == HAP.Characteristic.Active.ACTIVE ? Power.ON : Power.OFF);
            var swingMode = (this.DehumidService.getCharacteristic(HAP.Characteristic.SwingMode).value == HAP.Characteristic.SwingMode.SWING_ENABLED ? FanDirection.SWING : FanDirection.STOP);
            var humidity = this.DehumidService.getCharacteristic(HAP.Characteristic.RelativeHumidityDehumidifierThreshold).value;
            this.set({"pow" : powerState, "mode" : Mode.DEHUMIDIFIER, "stemp" : "--", "shum" : humidity, "f_dir" : swingMode, "f_rate" : FanRate.AUTO});
            this.cachedOptions.mode = Mode.DEHUMIDIFIER;
            this.cachedOptions.pow = powerState;
        }
        if ((context == "ACTIVESTATE" && value == HAP.Characteristic.Active.INACTIVE) || typeof context == "object") {
            // We're using the AC in either auto, cool or heat mode. This will be in the value parameter
            var swingMode = (this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.SwingMode).value == HAP.Characteristic.SwingMode.SWING_ENABLED ? FanDirection.SWING : FanDirection.STOP);
            var rotationSpeed = this.#HomeKitToDaikinFanSpeed(this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.RotationSpeed).value);
            if (typeof context == "object" && value == HAP.Characteristic.TargetHeaterCoolerState.COOL) {
                var temperature = this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).value;
                this.set({"pow" : Power.ON, "mode" : Mode.COOL, "stemp" : temperature, "shum" : 0, "f_dir" : swingMode, "f_rate" : rotationSpeed});
                this.cachedOptions.mode = Mode.COOL;
                this.cachedOptions.pow = Power.ON;
            }
            if (typeof context == "object" && value == HAP.Characteristic.TargetHeaterCoolerState.HEAT) {
                var temperature = this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).value;
                this.set({"pow" : Power.ON, "mode" : Mode.HEAT, "stemp" : temperature, "shum" : 0, "f_dir" : swingMode, "f_rate" : rotationSpeed});
                this.cachedOptions.mode = Mode.AUTO;
                this.cachedOptions.pow = Power.ON;
            }
            if (typeof context == "object" && value == HAP.Characteristic.TargetHeaterCoolerState.AUTO) {
                this.set({"pow" : Power.ON, "mode" : Mode.AUTO, "stemp" : this.deviceData.dt7, "shum" : 0, "f_dir" : swingMode, "f_rate" : rotationSpeed});
                this.cachedOptions.mode = Mode.AUTO
                this.cachedOptions.pow = Power.ON;
            }
            if (context == "ACTIVESTATE") {
                this.set({"pow" : Power.OFF});
                this.cachedOptions.pow = Power.OFF;
            }
        }
        callback();
    }

    setFanSpeed(value, callback, context) {
        var speed = this.#HomeKitToDaikinFanSpeed(value);
        if ((context == this.FanService && this.deviceData.mode == Mode.FAN) || (context == this.DehumidService && this.deviceData.mode == Mode.DEHUMIDIFIER) ||
            (context == this.HeaterCoolerService && this.deviceData.mode == Mode.AUTO) || (context == this.HeaterCoolerService && this.deviceData.mode == Mode.COOL) ||
            (context == this.HeaterCoolerService && this.deviceData.mode == Mode.HEAT)) {
            
            // Since the context matches the current mode on the daikin, we can set directly without caching
            this.set({"f_rate" : speed});
        } else if (context == this.FanService) {
            this.cachedOptions.dfr6 = speed;
        } else if (context == this.DehumidService) {
            this.cachedOptions.dfr2 = speed;
        } else if (context == this.HeaterCoolerService) {
            this.cachedOptions.dfr3 = speed;
            this.cachedOptions.dfr4 = speed;
            this.cachedOptions.dfr7 = speed;
        }

        context.updateCharacteristic(HAP.Characteristic.RotationSpeed, value);  // Update fan rotation speed on the corresponding service
        callback();
    }

    setFanDirection(value, callback, context) {
        var direction = (value == HAP.Characteristic.SwingMode.SWING_ENABLED ? FanDirection.SWING : FanDirection.STOP);
        if ((context == this.FanService && this.deviceData.mode == Mode.FAN) || (context == this.DehumidService && this.deviceData.mode == Mode.DEHUMIDIFIER) ||
            (context == this.HeaterCoolerService && this.deviceData.mode == Mode.AUTO) || (context == this.HeaterCoolerService && this.deviceData.mode == Mode.COOL) ||
            (context == this.HeaterCoolerService && this.deviceData.mode == Mode.HEAT)) {
            
            // Since the context matches the current mode on the daikin, we can set directly without caching
            this.set({"f_dir" : direction});
        } else if (context == this.FanService) {
            this.cachedOptions.dfd6 = direction;
        } else if (context == this.DehumidService) {
            this.cachedOptions.dfd2 = direction;
        } else if (context == this.HeaterCoolerService) {
            this.cachedOptions.dfd3 = direction;
            this.cachedOptions.dfd4 = direction;
            this.cachedOptions.dfd7 = direction;
        }
        context.updateCharacteristic(HAP.Characteristic.SwingMode, value);  // Update the swing mode on the corresponding service
        callback();
    }

    setTemperature(value, callback, context) {
        if (this.deviceData.mode == Mode.COOL && context == HAP.Characteristic.CoolingThresholdTemperature) {
            this.set({"stemp" : value});
            this.cachedOptions.dt3 = value;
            this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, value);
        }
        if (this.deviceData.mode == Mode.HEAT && context == HAP.Characteristic.HeatingThresholdTemperature) {
            this.set({"stemp" : value});
            this.cachedOptions.dt4 = value;
            this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, value);
        }
        if (this.deviceData.mode == Mode.AUTO) {
            // Temperature adjustment of either heating or cooling threshold limits in auto mode
            // Since daikin only supports a single target temperature, we need to calculate what this should be
            if (context == HAP.Characteristic.CoolingThresholdTemperature && value != this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).value) {
                this.set({"stemp" :  value});
                this.cachedOptions.dt7 = value;
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, value);
            }
            if (context == HAP.Characteristic.HeatingThresholdTemperature && value != this.HeaterCoolerService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).value) {
                this.set({"stemp" :  value});
                this.cachedOptions.dt7 = value;
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, value);  
            }
        }
        callback();
    }

    setHumidty(value, callback) {
        if (this.deviceData.mode == Mode.DEHUMIDIFIER) {
            this.set({"shum" : value});
        }
        this.cachedOptions.dh2 = value;
        this.DehumidService.updateCharacteristic(HAP.Characteristic.RelativeHumidityDehumidifierThreshold, value);
        callback();
    }

    updateHomeKitServices(deviceData) {
        var historyEntry = {};

        // Insert any cached parameters we have stored. 
        Object.entries(this.cachedOptions).forEach(([key, value]) => {
            if (JSON.stringify(deviceData[key]) == JSON.stringify(this.deviceData[key]) && JSON.stringify(deviceData[key]) != JSON.stringify(value)) {
                // Since the new data from the device matches the existing device data, use value from cache
                deviceData[key] = value;
            } else if (JSON.stringify(deviceData[key]) != JSON.stringify(this.deviceData[key])) {
                // New data for this key is different than our internally stored data, so we'll assume a change was triggered on external system
                delete this.cachedOptions[key];
            } else if (JSON.stringify(value) == JSON.stringify(deviceData[key]) && JSON.stringify(value) == JSON.stringify(this.deviceData[key])) {
                // Our cached value now matches the incoming device data, so remove from cache
                delete this.cachedOptions[key];
            }
        });

        // Mode has changed, See if we have any cache data to commit for this mode
        // Most obvious case for this si switching fan oscillation on/off for a service that isnt active yet
        if (deviceData.mode != this.deviceData.mode) {
            if (deviceData.mode == Mode.FAN) {
                if (this.cachedOptions.hasOwnProperty("dfd6")) this.set({"f_dir" : this.cachedOptions.dfd6});
            }
            if (deviceData.mode == Mode.DEHUMIDIFIER) {
                if (this.cachedOptions.hasOwnProperty("dfd2")) this.set({"f_dir" : this.cachedOptions.dfd2});
            }
            if (deviceData.mode == Mode.AUTO) {
                if (this.cachedOptions.hasOwnProperty("dfd7")) this.set({"f_dir" : this.cachedOptions.dfd7});
            }
            if (deviceData.mode == Mode.COOL) {
                if (this.cachedOptions.hasOwnProperty("dfd3")) this.set({"f_dir" : this.cachedOptions.dfd3});
            }
            if (deviceData.mode == Mode.HEAT) {
                if (this.cachedOptions.hasOwnProperty("dfd4")) this.set({"f_dir" : this.cachedOptions.dfd4});
            }
        }

        if (this.HeaterCoolerService != null) {
            this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.StatusActive, deviceData.online);
            this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentTemperature, deviceData.htemp);
            if (this.HeaterCoolerService.testCharacteristic(HAP.Characteristic.CurrentRelativeHumidity) == true) this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentRelativeHumidity, deviceData.hhum);

            // Set aircon mode/power/current status
            if (deviceData.mode == Mode.AUTO) {
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, deviceData.dt7);   // cooling temp
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, deviceData.dt7);   // heating temp
            
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.TargetHeaterCoolerState, HAP.Characteristic.TargetHeaterCoolerState.AUTO);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.Active, deviceData.pow == Power.ON ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.SwingMode, deviceData.dfd7 == FanDirection.STOP ? HAP.Characteristic.SwingMode.SWING_DISABLED : HAP.Characteristic.SwingMode.SWING_ENABLED);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.RotationSpeed, this.#DaikinFanSpeedToHomeKit(deviceData.dfr7));

                // Are we heating or cooling? Use current temperature vs target temperature of coolin/heating to work this out
                if (deviceData.htemp > deviceData.dt7) {
                    // current temperature is greater then target temperature, so we're currently cooling
                    this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, deviceData.pow == Power.ON ? HAP.Characteristic.CurrentHeaterCoolerState.COOLING : HAP.Characteristic.CurrentHeaterCoolerState.INACTIVE);
                } else if (deviceData.htemp < deviceData.dt7) {
                    // current temperature is less than target temperature, so we're currently heating
                    this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, deviceData.pow == Power.ON ? HAP.Characteristic.CurrentHeaterCoolerState.HEATING : HAP.Characteristic.CurrentHeaterCoolerState.INACTIVE);
                } else {
                    // otherwise, we're not heating or cooling, so we're idling
                    this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, deviceData.pow == Power.ON ? HAP.Characteristic.CurrentHeaterCoolerState.IDLE : HAP.Characteristic.CurrentHeaterCoolerState.INACTIVE);
                }
                historyEntry.target = {low: deviceData.dt7, high: deviceData.dt7};    // target temperature range
            }
            if (deviceData.mode == Mode.COOL) {
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, deviceData.dt3);   // cooling temp
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.TargetHeaterCoolerState, HAP.Characteristic.TargetHeaterCoolerState.COOL);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, deviceData.pow == Power.ON ? HAP.Characteristic.CurrentHeaterCoolerState.COOLING : HAP.Characteristic.CurrentHeaterCoolerState.INACTIVE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.Active, deviceData.pow == Power.ON ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.SwingMode, deviceData.dfd3 == FanDirection.STOP ? HAP.Characteristic.SwingMode.SWING_DISABLED : HAP.Characteristic.SwingMode.SWING_ENABLED);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.RotationSpeed, this.#DaikinFanSpeedToHomeKit(deviceData.dfr3));
                historyEntry.target = {low: deviceData.dt3, high: 0};    // single target temperature for cooling limit
                historyEntry.status = 3;    // cooling
            }
            if (deviceData.mode == Mode.HEAT) {
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, deviceData.dt4);   // heating temp
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.TargetHeaterCoolerState, HAP.Characteristic.TargetHeaterCoolerState.HEAT);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, deviceData.pow == Power.ON ? HAP.Characteristic.CurrentHeaterCoolerState.HEATING : HAP.Characteristic.CurrentHeaterCoolerState.INACTIVE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.Active, deviceData.pow == Power.ON ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.SwingMode, deviceData.dfd4 == FanDirection.STOP ? HAP.Characteristic.SwingMode.SWING_DISABLED : HAP.Characteristic.SwingMode.SWING_ENABLED);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.RotationSpeed, this.#DaikinFanSpeedToHomeKit(deviceData.dfr4));
                historyEntry.target = {low: 0, high: deviceData.dt4};    // single target temperature for heating limit
                historyEntry.status = 2;    // heating
            }
            if (deviceData.mode == Mode.DEHUMIDIFIER) {
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, HAP.Characteristic.CurrentHeaterCoolerState.IDLE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.INACTIVE);
                // We'll update the dehumidifer service details below seperately
                historyEntry.status = 4;    // dehumidifying
            }
            if (deviceData.mode == Mode.FAN) {
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.CurrentHeaterCoolerState, HAP.Characteristic.CurrentHeaterCoolerState.IDLE);
                this.HeaterCoolerService.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.INACTIVE);
                // We'll update the fan service details below seperately
                historyEntry.status = 1;    // fan
            }
        }
        if (this.DehumidService != null) {
            this.DehumidService.updateCharacteristic(HAP.Characteristic.Active, (deviceData.pow == Power.ON && deviceData.mode == Mode.DEHUMIDIFIER) ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE);
            this.DehumidService.updateCharacteristic(HAP.Characteristic.CurrentHumidifierDehumidifierState, (deviceData.pow == Power.ON && deviceData.mode == Mode.DEHUMIDIFIER) ? HAP.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING : HAP.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE);
            this.DehumidService.updateCharacteristic(HAP.Characteristic.TargetHumidifierDehumidifierState, HAP.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);
            this.DehumidService.updateCharacteristic(HAP.Characteristic.SwingMode, deviceData.dfd2 == FanDirection.STOP ? HAP.Characteristic.SwingMode.SWING_DISABLED : HAP.Characteristic.SwingMode.SWING_ENABLED);
            this.DehumidService.updateCharacteristic(HAP.Characteristic.RelativeHumidityDehumidifierThreshold, deviceData.dh2);
            this.DehumidService.updateCharacteristic(HAP.Characteristic.CurrentRelativeHumidity, (typeof deviceData.hhum == "number" ? deviceData.hhum : 0));
        }
        if (this.FanService != null) {
            this.FanService.updateCharacteristic(HAP.Characteristic.Active, (deviceData.pow == Power.ON && deviceData.mode == Mode.FAN) ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE);
            this.FanService.updateCharacteristic(HAP.Characteristic.SwingMode, deviceData.dfd6 == FanDirection.STOP ? HAP.Characteristic.SwingMode.SWING_DISABLED : HAP.Characteristic.SwingMode.SWING_ENABLED);
            this.FanService.updateCharacteristic(HAP.Characteristic.RotationSpeed, this.#DaikinFanSpeedToHomeKit(deviceData.dfr6));
        }

        if (deviceData.pow == Power.OFF) {
            historyEntry.status = 0;   // System is off
            historyEntry.target = {low: 0, high: 0};
        }

        // Log heater/cooler metrics to history only if changed to previous recordings
        if (this.HomeKitHistory != null) {
            var tempEntry = this.HomeKitHistory.lastHistory(this.HeaterCoolerService);
            if (tempEntry == null || (typeof tempEntry == "object" && tempEntry.status != historyEntry.status || tempEntry.temperature != deviceData.htemp || JSON.stringify(tempEntry.target) != JSON.stringify(historyEntry.target))) {
                this.HomeKitHistory.addHistory(this.HeaterCoolerService, {time: Math.floor(Date.now() / 1000), status: historyEntry.status, temperature: deviceData.htemp, target: historyEntry.target, humidity: (typeof deviceData.hhum == "number" ? deviceData.hhum : 0)});
            }
        }
    }

    #DaikinFanSpeedToHomeKit(rate) {
        // Convert a Daikin fan speed value into a HomeKit fan speed value
        var steps = (100 / Object.keys(FanRate).length);
        if (rate.toUpperCase() == FanRate.AUTO) var speed = (steps * 1); // auto
        if (rate.toUpperCase() == FanRate.QUIET) var speed = (steps * 2); // quiet
        if (Number(rate) == FanRate.LEVEL1) var speed = (steps * 3); // lvl1
        if (Number(rate) == FanRate.LEVEL2) var speed = (steps * 4); // lvl2
        if (Number(rate) == FanRate.LEVEL3) var speed = (steps * 5); // lvl3
        if (Number(rate) == FanRate.LEVEL4) var speed = (steps * 6); // lvl4
        if (Number(rate) == FanRate.LEVEL5) var speed = 100; // lvl5
        return speed;
    }
    
    #HomeKitToDaikinFanSpeed(speed) {
        // Convert a HomeKit fan speed value into a Daikin fan speed value
        var steps = (100 / Object.keys(FanRate).length);
        if (speed >= 0 && speed <= (steps * 1)) var rate = FanRate.AUTO;
        if (speed > (steps * 1) && speed <= (steps * 2)) var rate = FanRate.QUIET;
        if (speed > (steps * 2) && speed <= (steps * 3)) var rate = FanRate.LEVEL1;
        if (speed > (steps * 3) && speed <= (steps * 4)) var rate = FanRate.LEVEL2;
        if (speed > (steps * 4) && speed <= (steps * 5)) var rate = FanRate.LEVEL3;
        if (speed > (steps * 5) && speed <= (steps * 6)) var rate = FanRate.LEVEL4;
        if (speed > (steps * 6) && speed <= 100) var rate = FanRate.LEVEL5;
        return rate;
    }
}


// Daikin airconditioner class
const UPDTIMEOUT = 5000;
const UDPDISCOVERYDONE = "UDPDISCOVERYDONE";
const NETWORKDISCOVERY = 30000; // Perform UDP discovery every 30seconds
const SYSTEMREFRESH = 2000; // Get system details for each discovered system every 2 seconds

const Power = {
    ON : 1,
    OFF : 0
};

const Mode = {
    AUTO : 7,
    DEHUMIDIFIER : 2,
    COOL : 3,
    HEAT : 4,
    FAN : 6
};

const FanRate = {
    AUTO : "A",
    QUIET : "B",
    LEVEL1 : "3",
    LEVEL2 : "4",
    LEVEL3 : "5",
    LEVEL4 : "6",
    LEVEL5 : "7"
};

const FanDirection = {
	STOP : 0,
	VERTICAL : 1,
	HORIZONTAL : 2,
	SWING : 3
};

const SystemEvent = {
    ADD : "addDevice",
    REMOVE : "removeDevice"
}

class Daikin {
	constructor(globalEventEmitter) {
        this.rawData = {};                                  // Full copy of Daikin data
        this.abortController = new AbortController();       // Abort controller object
        this.eventEmitter = globalEventEmitter;             // Global event emitter
        this.subscribePollingTimers = [];                   // Array of polling timers for subscribe requests
        this.systems = [];                                  // Array of systems we've discovered and managing(JSON object)

        // Setup event processing for set/get properties
        this.eventEmitter.addListener(HomeKitDevice.SET, this.#set.bind(this));
        this.eventEmitter.addListener(HomeKitDevice.GET, this.#get.bind(this));
    }

    // Class functions
    async discover() 
    {
        // Find systems on local network
        var foundSystems = [];
        var udpSocket = dgram.createSocket({type: "udp4", reuseAddr: true});
        
        udpSocket.bind(30000, "0.0.0.0", () => {
            udpSocket.addMembership("224.0.0.1");
            udpSocket.setBroadcast(true);
        });
        
        udpSocket.on("message", async (chunk, info) => {        
            // Callback triggered when we've received a UDP response
            if (foundSystems.some(ip => ip.IPAddress === info.address) == false) {
                // Have not found this device before, so add to array of discovered systems
                await axios.get("http://" + info.address + "/common/basic_info", {transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] })
                .then(response => {
                    if (response.status == 200) {
                        response.data.mac = response.data.mac.toUpperCase();    // Ensure its all in upper case
                        var tempMACAddress = response.data.mac.substr(0,2) + ":" + response.data.mac.substr(2,2) + ":" + response.data.mac.substr(4,2) + ":" + response.data.mac.substr(6,2) + ":" + response.data.mac.substr(8,2) + ":" + response.data.mac.substr(10,2);
                        if (foundSystems.findIndex( ({ IPAddress, MAC }) => (MAC == tempMACAddress)) == -1) {
                            foundSystems.push({MAC: tempMACAddress, IPAddress: info.address, URL : ""});
                        }
                    }
                })
                .catch((error) => {
                });
            }
        });
    
        udpSocket.on("listening", () => {
            // UDP socket opened to listen, so send the queries
            var updQuery = "DAIKIN_UDP/common/basic_info";
            udpSocket.send(updQuery, 0, updQuery.length, 30050, "255.255.255.255");
    
            // Sent the discovery messages, so wait for replies 
            setTimeout(() => {
                udpSocket.close();
                this.eventEmitter.emit(UDPDISCOVERYDONE);
            }, UPDTIMEOUT);
        });

        // Wait until we get notified that discovery has completed/reached timeout
        await EventEmitter.once(this.eventEmitter, UDPDISCOVERYDONE);
        return foundSystems;
    }

    async getData(systems) {
        await Promise.all(systems.map(async (system) => {
            await axios.all([
                axios.get("http://" + system.IPAddress + "/common/basic_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] }),
                axios.get("http://" + system.IPAddress + "/aircon/get_control_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] }),
                axios.get("http://" + system.IPAddress + "/aircon/get_sensor_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] })
            ])
            .then(axios.spread((BasicInfo, ACInfo, SensorInfo) => {
                this.rawData[system.MAC] = {};
                if (BasicInfo.status == 200) {
                    this.rawData[system.MAC].BasicInfo = BasicInfo.data;
                }
                if (ACInfo.status == 200) {
                    this.rawData[system.MAC].ACInfo = ACInfo.data;
                }
                if (SensorInfo.status == 200) {
                    this.rawData[system.MAC].SensorInfo = SensorInfo.data;
                }
                this.rawData[system.MAC].online = true; // We've processed data, so we're online
                this.systems.push({MAC: system.MAC, IPAddress: system.IPAddress});  // Add this device to systems we're managing
            }))
            .catch(error => {
            });
        }));
    }

    processData() {
        var devices = {};

        Object.entries(this.rawData).forEach(([MAC, device]) => {
            // process raw device data
            var tempDevice = {};
            tempDevice.excluded = false;
            tempDevice.serial_number = device.BasicInfo.mac;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.description = this.#validateHomeKitName(this.#hex2ascii(device.BasicInfo.name)); // Decode name string
            tempDevice.model = this.#hex2ascii(device.BasicInfo.name);
            tempDevice.location = "";    // no location of the device name
            tempDevice.mac_address = MAC;   // Our created MAC address
            tempDevice.uuid = MAC;
            tempDevice.software_version = device.BasicInfo.ver.replace(/_/g, ".");

            tempDevice.pow = (Number(device.ACInfo.pow) == 1 ? Power.ON : Power.OFF);
            tempDevice.mode = Mode.AUTO;   // Auto mode by default;
            if (Number(device.ACInfo.mode) == 2) tempDevice.mode = Mode.DEHUMIDIFIER;
            if (Number(device.ACInfo.mode) == 3) tempDevice.mode = Mode.COOL;
            if (Number(device.ACInfo.mode) == 4) tempDevice.mode = Mode.HEAT;
            if (Number(device.ACInfo.mode) == 6) tempDevice.mode = Mode.FAN;

            tempDevice.htemp = Number(device.SensorInfo.htemp);     // Current temperature at headunit
            tempDevice.hhum = (typeof device.SensorInfo.hhum == "number" ? Number(device.SensorInfo.hhum) : "--");  // Humidity level at headunit. "--" if unavailable
            tempDevice.otemp = Number(device.SensorInfo.otemp);     // Outside temperature at compressor
            tempDevice.dt7 = Number(device.ACInfo.dt7);             // auto-mode target temperature 
            tempDevice.dt3 = Number(device.ACInfo.dt3);             // cooling temperature minium level
            tempDevice.dt4 = Number(device.ACInfo.dt4);             // heating temperature maximum level
            tempDevice.dh2 = (typeof device.ACInfo.dh2 == "number" ? Number(device.ACInfo.dh2) : 50);             // dehumidifier target
            tempDevice.dfr7 = device.ACInfo.dfr7;                   // Fan mode for auto mode
            tempDevice.dfd7 = Number(device.ACInfo.dfd7);           // Fan direction for auto mode
            tempDevice.dfr2 = device.ACInfo.dfr2;                   // Fan mode for dehumidifier
            tempDevice.dfd2 = Number(device.ACInfo.dfd2);           // Fan direction for dehumidifier
            tempDevice.dfr3 = device.ACInfo.dfr3;                   // Fan mode for cooling
            tempDevice.dfd3 = Number(device.ACInfo.dfd3);           // Fan direction for cooling
            tempDevice.dfr4 = device.ACInfo.dfr4;                   // Fan mode for heating
            tempDevice.dfd4 = Number(device.ACInfo.dfd4);           // Fan direction for heating
            tempDevice.dfr6 = device.ACInfo.dfr6;                   // Fan mode for fan only
            tempDevice.dfd6 = Number(device.ACInfo.dfd6);           // Fan direction for fan only

            tempDevice.EveApp = true;                               // Link to Eve Home app
            tempDevice.online = device.online;                      // Device is online

            devices[MAC] = tempDevice;  // Store processed device 
        });

        return devices; // Return our processed data
    }

    async subscribe() {
        this.systems.forEach((system) => {
            // Setup a timer interval for each system we have discovered previously
            var index = this.subscribePollingTimers.findIndex( ({ MAC }) => (MAC === system.MAC));
            if (index == -1 || (index != -1 && this.subscribePollingTimers[index].timer == null)) {
                var tempTimer = setInterval(async () => {
                    await axios.all([
                        axios.get("http://" + system.IPAddress + "/common/basic_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] }),
                        axios.get("http://" + system.IPAddress + "/aircon/get_control_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] }),
                        axios.get("http://" + system.IPAddress + "/aircon/get_sensor_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] })
                    ])
                    .then(axios.spread((BasicInfo, ACInfo, SensorInfo) => {
                        if (BasicInfo.status == 200) {
                            this.rawData[system.MAC].BasicInfo = BasicInfo.data;
                        }
                        if (ACInfo.status == 200) {
                            this.rawData[system.MAC].ACInfo = ACInfo.data;
                        }
                        if (SensorInfo.status == 200) {
                            this.rawData[system.MAC].SensorInfo = SensorInfo.data;
                        }
                        this.rawData[system.MAC].online = true; // We've processed data, so we're online

                        // Process any device updates here
                        Object.entries(this.processData()).forEach(([deviceID, deviceData]) => {
                            // Send current data to the HomeKit accessory for processing
                            // The accessory will determine if data has changed compared to what it has stored
                            this.eventEmitter.emit(deviceData.uuid, HomeKitDevice.UPDATE, deviceData);
                        });
                    }))
                    .catch(error => {
                    });
                }, SYSTEMREFRESH);   // Every 2 seconds
            }
            this.subscribePollingTimers.push({MAC: system.MAC, timer: tempTimer});
        });


        // Need a special timer loop to perform network discovery for adding/removing/ip changes devices
        // NOTE: Only checking for device additions/ip changes as UDP discovery can be unsuccessfull at times so a previous device may drop off then reappear     
        var tempTimer = setInterval(() => {
            this.discover()
            .then((discoveredSystems) => {
                var addRemoveDevices = [];
                for (var index in this.systems) {
                    if (discoveredSystems.findIndex( ({ IPAddress, MAC }) => (MAC == this.systems[index].MAC)) == -1) {
                        addRemoveDevices.push({"MAC" : this.systems[index].MAC, "IPAddress": this.systems[index].IPAddress, "action" : "remove"});    // Removed device
                    }
                }
                for (index in discoveredSystems) {
                    var index2 = this.systems.findIndex( ({ IPAddress, MAC }) => (MAC == discoveredSystems[index].MAC));
                    if (index2 == -1) {
                        addRemoveDevices.push({ "MAC" : discoveredSystems[index].MAC, "IPAddress": discoveredSystems[index].IPAddress, "action" : "add"});    // Added device
                    } else if (index2 != -1 && discoveredSystems[index].IPAddress != this.systems[index2].IPAddress) {
                        addRemoveDevices.push({"MAC" : discoveredSystems[index].MAC, "IPAddress": discoveredSystems[index].IPAddress, "action" : "ipchange"});    // IP change
                    }
                }

                addRemoveDevices = addRemoveDevices.sort((a, b) => a - b);  // filter out duplicates

                // Process changes for discovered devices now
                addRemoveDevices.forEach(async (system) => {
                    if (system.action == "add") {
                        await this.getData([{"IPAddress" : system.IPAddress, "MAC" : system.MAC}]);   // Get data for the new system and add to managed devices
                        var deviceData = this.processData()[system.MAC];   // Process all our current data
                        this.eventEmitter.emit(SystemEvent.ADD, deviceData);    // new device, so process addition to HomeKit

                        // Restart subscription loop gracefully
                        this.subscribePollingTimers.forEach((pollingTimer) => {
                            clearInterval(pollingTimer.timer);
                            pollingTimer.timer = null;
                        });
                        this.subscribe();   // Restart subsription loops
                    }
                    if (system.action == "remove") {
                        // What todo???
                    }
                    if (system.action == "ipchange") {
                        // Systems IP address has changed, so update our internal managed system details for it
                        var index = this.systems.findIndex( ({ IPAddress, MAC }) => (MAC === system.MAC));
                        if (index != -1) {
                            outputLogging(ACCESSORYNAME, true, "Daikin system '%s' has had IP Address change from '%s' to '%s'", system.MAC, this.systems[index].IPAddress, system.IPAddress);
                            this.systems[index].IPAddress = system.IPAddress;
                        }
                    }
                });
            });
        }, NETWORKDISCOVERY);      // Every 30 seconds?
        this.subscribePollingTimers.push({MAC: "", timer: tempTimer});
    }

    async #set(deviceUUID, keyValues) {
        // Mandatory parmeters are required to set daikin control options. These are below. If missing from keyValues object, we'll use existing settings
        // on the device to build our correct option string
        //
        // pow
        // mode
        // stemp
        // shum
        // f_rate
        // f_dir
        if (typeof deviceUUID != "string" || typeof keyValues != "object") {
            return;
        }

        var index = this.systems.findIndex( ({ IPAddress, MAC }) => (MAC === deviceUUID));
        if (index != -1) {
            await axios.get("http://" + this.systems[index].IPAddress + "/aircon/get_control_info", {timeout: 10000, retry: 3, retryDelay: 1000, transformResponse: [(data) => {if (typeof data === "string") {data = data.trim(); if (data !== "") { data = JSON.parse("{\"" + data.replace(new RegExp("\=", "g"), "\":\"").replace(new RegExp("\,", "g"), "\",\"") + "\"}"); } return data; } }] })
            .then(async (response) => {
                if (typeof response.status != "number" || response.status != 200) {
                    throw new Error("Daikin API HTTP get failed with error");
                }

                var controlString = (keyValues.hasOwnProperty("pow") ? "pow=" + keyValues.pow : "pow=" + response.data.pow)
                                + (keyValues.hasOwnProperty("mode") ? "&mode=" + keyValues.mode : "&mode=" + response.data.mode)
                                + (keyValues.hasOwnProperty("stemp") ? "&stemp=" + keyValues.stemp : "&stemp=" + response.data.stemp)
                                + (keyValues.hasOwnProperty("shum") ? "&shum=" + keyValues.shum : "&shum=" + response.data.shum)
                                + (keyValues.hasOwnProperty("f_rate") ? "&f_rate=" + keyValues.f_rate : "&f_rate=" + response.data.f_rate)
                                + (keyValues.hasOwnProperty("f_dir") ? "&f_dir=" + keyValues.f_dir : "&f_dir=" + response.data.f_dir);

                Object.entries(keyValues).map(async ([key, value]) => {             
                    if (key.toLowerCase() != "pow" && key.toLowerCase() != "mode" && key.toLowerCase() != "stemp" && key.toLowerCase()  != "shum" && key.toLowerCase() != "f_rate" && key.toLowerCase()  != "f_dir") {
                        controlString = controlString + "&" + key + "=" + value;
                    }
                });

                await axios.get("http://" + this.systems[index].IPAddress + "/aircon/set_control_info?" + controlString)
                .then((response) => {
                    if (typeof response.status != "number" || response.status != 200) {
                        throw new Error("Daikin API HTTP get failed with error");
                    }
                })
                .catch(error => {
                });
            })
            .catch(error => {
            });
        }
    }

    async #get(deviceUUID) {
    }

    #hex2ascii(hex) {
        var str = "";
        hex = hex.replace(/\s/g, "");   // remove spaces
        hex = hex.replace(/%/g, "");    // remove '%' from hex code
        for (var index = 0; index < hex.length; index += 2) {
            var value = parseInt(hex.substr(index, 2), 16);
            if (value) str += String.fromCharCode(value);
        }
        return str;
    }

    #validateHomeKitName(nameToMakeValid) {
        // Strip invalid characters to meet HomeKit naming requirements
        // Ensure only letters or numbers are at the beginning AND/OR end of string
        return nameToMakeValid.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
    }
}


// General functions

// Below taken from https://lifesaver.codes/answer/adding-retry-parameter
axios.interceptors.response.use(undefined, function axiosRetryInterceptor(err) {
    var config = err.config;
    // If config does not exist or the retry option is not set, reject
    if (!config || !config.retry) return Promise.reject(err);
    
    // Set the variable for keeping track of the retry count
    config.__retryCount = config.__retryCount || 0;
    
    // Check if we've maxed out the total number of retries
    if (config.__retryCount >= config.retry) {
        // Reject with the error
        return Promise.reject(err);
    }
    
    // Increase the retry count
    config.__retryCount += 1;
    
    // Create new promise to handle exponential backoff
    var backoff = new Promise(function(resolve) {
        setTimeout(function() {
            resolve();
        }, config.retryDelay || 1);
    });
    
    // Return the promise in which re-calls axios to retry the request
    return backoff.then(function() {
        return axios(config);
    });
});

function outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
    var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
    if (useConsoleDebug == false) {
        console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
    if (useConsoleDebug == true) {
        console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
}

function processDeviceforHomeKit(deviceData) {
    if (typeof deviceData != "object" || deviceData.excluded == true) {
        return;
    }
    //deviceData.description.toUpperCase().split("DAIKIN")[1]
    var tempDevice = new AirconditionerClass(deviceData, eventEmitter);
    tempDevice.add("Daikin Air-conditioner", HAP.Accessory.Categories.AIR_CONDITIONER, true);
}


// Startup code
outputLogging(ACCESSORYNAME, false, "Starting " +  __filename + " using HAP-NodeJS library v" + HAP.HAPLibraryVersion());
outputLogging(ACCESSORYNAME, false, "Devices will be advertised to HomeKit using '%s' mDNS provider", MDNSPROVIDER);

// Need a global event emitter. Will be used for message between our classes we create
var eventEmitter = new EventEmitter();
var daikin = new Daikin(eventEmitter);

outputLogging(ACCESSORYNAME, false, "Discovering active airconditioners on local network");

daikin.discover()
.then((discoveredSystems) => {
    daikin.getData(discoveredSystems)
    .then(() => {
        // Process any discovered daikin devices into HomeKit
        Object.entries(daikin.processData()).forEach(([deviceID, deviceData]) => {
            processDeviceforHomeKit(deviceData);
        });

        daikin.eventEmitter.addListener(SystemEvent.ADD, processDeviceforHomeKit); // Notifications for any device additions on the local network
        daikin.subscribe();  // Start subscription
    });
});