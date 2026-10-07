// Plugin Entry Point
// Part of homebridge-daikin-accfactory
//
// Registers the DaikinAccfactory dynamic platform and initialises the shared
// HomeKitDevice metadata used for accessory identity and lifecycle management.
//
// reference for details:
// https://github.com/ael-code/daikin-control
// https://github.com/Apollon77/daikin-controller
//
// Responsibilities:
// - Validate the Homebridge API object
// - Configure shared plugin and platform identifiers
// - Register the platform implementation from system.js
//
// Code version 2026.09.15
// Mark Hulskamp
'use strict';

// Import our modules
import DaikinAccfactory from './system.js';
import HomeKitDevice from './HomeKitDevice.js';
import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-daikin-accfactory';
HomeKitDevice.PLATFORM_NAME = 'DaikinAccfactory';
HomeKitDevice.EVEHOME = HomeKitHistory;
// HomeKitDevice.LOGGER will be set by the system class constructor

export default (api) => {
  // Validate Homebridge API object
  if (typeof api?.registerPlatform !== 'function') {
    throw new Error('DaikinAccfactory: Invalid Homebridge API object - registerPlatform method not found');
  }

  // Register our platform with Homebridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, DaikinAccfactory);
};
