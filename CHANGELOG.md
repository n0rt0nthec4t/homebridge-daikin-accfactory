# Change Log

## v0.0.2 (2026/10/16)

- Publish command status after SET completes to support the updated HomeKitDevice lifecycle; keep HTTP work independent of HomeKit publication so commands arriving during a poll cannot deadlock.

- Handle units without indoor humidity: retain the last valid sensor reading on both heater/cooler and dry-mode services, falling back to zero when none exists, without returning null or raising a communication error.

## v0.0.1 (2026/10/07)

- Manage status polling per client in the platform, following Denon, and feed snapshots to accessories through UPDATE messages; remove the air-conditioner polling timer and GET callback.

- Read per-device temperature limits directly from device data for HomeKit properties, validation, and commands instead of storing a duplicate range map.

- Keep HomeKit power writes from resending an old mode during overlapping commands; resolve complete protocol fields in the serialized client and update accessory state from reported status.

- Align configuration processing with Nest: normalize the supplied config in place, assign options explicitly, preserve extra fields, and filter placeholder device rows.

- Add a per-device outdoor temperature sensor override, inheriting the platform default when omitted and removing cached sensors when disabled for a unit.

- Place all six temperature override controls directly in each device entry so the configuration UI can render them without a nested fieldset.

- Add optional per-device cooling, heating, and auto temperature bounds in the Homebridge configuration UI, validate effective ranges, and apply them to HomeKit limits and control commands.

- Align HomeKit target-temperature limits and command validation with Daikin's cooling (18–32°C), heating (10–30°C), and auto (18–30°C) ranges; restore mode-specific limits when leaving auto.

- Align the platform and HTTP client with Sony and Denon by removing constructor test dependencies and mocking HTTP, UDP, and timers in tests.

- Retry manual units after failed startup identification or polling, including with discovery disabled.
- Serialize commands and polls per unit, retain accepted control changes after a failed refresh, and reject queued commands during shutdown.
- Validate API return statuses, complete status snapshots, and MAC identities before accepting protocol state; never automatically replay control writes.
- Link outdoor Eve history to the temperature service, remove legacy unsupported pressure services, and skip history recording while offline.
- Deduplicate UDP candidates within each scan and contain callback and late socket errors.
- Document protocol and lifecycle contracts and add recovery, concurrency, and shared HTTP regression coverage.

- Converted the older Daikin accessory factory into a Homebridge dynamic platform using the shared `HomeKitDevice` base.
- Added manual and repeating UDP discovery, bounded HTTP polling, and state refresh after control requests.
- Published each air conditioner through the Homebridge bridge with heater/cooler, fan, and dehumidifier controls; added an optional outdoor temperature sensor.
- Added optional Eve history with platform-wide and per-system settings.
- Sent complete six-field Daikin control requests using the latest polled state, based on the Daikin control protocol in `homebridge-nest-accfactory`.
- Routed Daikin HTTP requests through the shared `fetchWrapper` submodule for bounded timeouts and transient retries; removed unused Sony CRC32 and scaling helpers.
- Added a platform HTTP port setting with an optional per-system override for Daikin units that do not use port 80.
- Moved repeating UDP discovery and socket cleanup into a focused `discovery.js` module.
- Added per-system exclusion, configuration defaults, platform lifecycle tests, and checks against the built distribution layout.
- Added support for Node.js 22, 24, and 26 and Homebridge 1.11.4 or 2.4.0.
