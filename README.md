<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# Daikin Accfactory

![npm](https://img.shields.io/npm/v/homebridge-daikin-accfactory/latest?label=npm%40latest&color=%234CAF50)

</span>

A dynamic Homebridge platform for Daikin air conditioners that provide the local `DAIKIN_UDP` discovery protocol and `/aircon/*` HTTP endpoints.

## Features

- Power and auto, cool, heat, fan, and dehumidifier mode controls
- Target temperature, target humidity, fan speed, and swing controls
- Optional local network discovery, plus manual host configuration
- Repeating discovery, retries for unavailable manual units, and status polling with a refresh after HomeKit commands
- Optional separate HomeKit sensor for the outdoor compressor temperature
- Bridged air-conditioner accessories backed by the shared `HomeKitDevice` module
- Optional Eve history for air-conditioner and outdoor-temperature readings

## Daikin setup

Connect each air conditioner to the same local network as Homebridge and ensure its local HTTP interface is reachable. A fixed DHCP reservation is recommended when using a manual host address or an exclusion entry.

Install the plugin through the Homebridge UI and add the `DaikinAccfactory` platform. Automatic discovery is enabled by default. Discovered and manually configured air conditioners appear through the existing Homebridge bridge.

## Configuration

```json
{
  "platform": "DaikinAccfactory",
  "name": "Daikin Air Conditioners",
  "options": {
    "autoDiscover": true,
    "httpPort": 80,
    "discoveryInterval": 60,
    "pollInterval": 15,
    "externalSensor": false,
    "eveHistory": true
  },
  "devices": [
    {
      "system": "192.168.1.50",
      "name": "Living Room",
      "httpPort": 8080,
      "eveHistory": true
    }
  ]
}
```

Manual entries are useful when UDP discovery is unavailable. They can also provide a name or exclusion setting for a system found automatically.

### Platform options

| Option | Default | Description |
| --- | --- | --- |
| `autoDiscover` | `true` | Search the local network for Daikin systems using UDP discovery. |
| `httpPort` | `80` | HTTP port used for Daikin API requests. Valid values are 1–65535. |
| `discoveryInterval` | `60` | Seconds between discovery scans. Valid values are 30–3600 seconds. |
| `pollInterval` | `15` | Seconds between state polls. Valid values are 5–300 seconds. |
| `externalSensor` | `false` | Default outdoor sensor setting; can be overridden per device. Publish `otemp`, the outdoor compressor temperature, as a separate HomeKit sensor. Daikin's `hhum` is indoor humidity; this sensor does not expose outdoor humidity or air pressure. |
| `eveHistory` | `true` | Record air-conditioner and outdoor-temperature history for the Eve app. |

### Air-conditioner entries

| Field | Required | Description |
| --- | --- | --- |
| `system` | Yes | Air-conditioner host name or IP address. |
| `name` | No | Override the name displayed in HomeKit. |
| `httpPort` | No | Override the platform HTTP port for this air conditioner. Valid values are 1–65535. |
| `exclude` | No | Prevent this air conditioner from being published. Defaults to `false`. |
| `eveHistory` | No | Override the platform Eve history setting for this air conditioner. |
| `externalSensor` | No | Override the platform outdoor temperature sensor setting for this air conditioner. |

To use only manual addresses, set `autoDiscover` to `false` and add at least one system under `devices`.

The plugin uses target-temperature limits of **18–32°C for cooling**, **10–30°C for heating**, and **18–30°C for auto**, following [Daikin's residential split-system operation manual](https://www.daikin.eu/content/dam/document-library/operation-manuals/ac/split/atxp-m/ATXP-M_3P520336-7B_2018_12_Operation%20manual.pdf). Both HomeKit thresholds use the auto range while auto mode is selected. Model-specific or controller restrictions may differ. Override the limits for an individual unit using these optional fields under `devices`:

| Field | Default | Description |
| --- | --- | --- |
| `coolingMin` | `18` | Minimum cooling setpoint in °C. |
| `coolingMax` | `32` | Maximum cooling setpoint in °C. |
| `heatingMin` | `10` | Minimum heating setpoint in °C. |
| `heatingMax` | `30` | Maximum heating setpoint in °C. |
| `autoMin` | `18` | Minimum auto setpoint in °C. |
| `autoMax` | `30` | Maximum auto setpoint in °C. |

Leave fields blank to keep their defaults. Override values must be whole numbers from 0–100°C, with the effective minimum below the maximum for each mode. Invalid fields use their defaults; an inverted or equal pair resets both bounds for that mode and logs a warning. Use limits supported by the unit and controller. Overrides apply to HomeKit limits and temperature commands; when switching modes, remembered targets are constrained to the configured range.

## Daikin communication

The plugin broadcasts a discovery request to UDP port 30050 and listens for replies on port 30000. It identifies each system by its MAC address, then loads control and sensor state through the local HTTP API on the configured `httpPort`. Configured units that cannot be identified or polled at startup are retried every `discoveryInterval` seconds, including when automatic discovery is disabled. Once published, the platform polls each client independently every `pollInterval` seconds and feeds state updates to the air conditioner and optional outdoor sensor. Two consecutive failed or incomplete polls mark an existing accessory offline; the first failure retains its last known state. A successful poll resets the failure count and returns it online immediately. HTTP requests have bounded timeouts so an unresponsive system cannot hold up Homebridge startup indefinitely.

When a unit does not supply `hhum`, humidity characteristics retain their last valid reading, or return `0` when none has been available, so missing humidity does not prevent control of the accessory.

HomeKit commands use the latest control snapshot and send the six fields required by `/aircon/set_control_info`: power, mode, target temperature, target humidity, fan rate, and fan direction. The control format follows the Daikin module in `homebridge-nest-accfactory`. Commands and polls run in order for each physical unit so overlapping HomeKit changes preserve earlier accepted settings. After a command, the plugin polls the system again to show its reported state in HomeKit. Read requests can retry transient failures; control writes are attempted once so a lost response cannot trigger an automatic replay. Failed commands are reported to HomeKit.

The optional outdoor sensor is published when the compressor supplies a valid outdoor temperature. If that reading later becomes unavailable, the sensor retains its last temperature and reports a fault until a valid reading returns. Offline readings are not recorded as new Eve history. The outdoor accessory links Eve history to its temperature service and does not publish an unsupported pressure service.

## Development

The shared `HomeKitDevice`, `HomeKitHistory`, and `fetchWrapper` modules are Git submodules. Clone with submodules, or initialise them after cloning:

```sh
git submodule update --init --recursive
npm install
npm run check
```

Tests include the shared HTTP wrapper and exercise the built distribution with a real HAP service implementation and mocked HTTP responses and Node networking/timer APIs.

Requires Node.js 22, 24, or 26 and either Homebridge 1.11.4 or newer in the 1.x series, or Homebridge 2.4.0 or newer in the 2.x series.
