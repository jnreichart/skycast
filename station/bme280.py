"""BME280 temperature / humidity / pressure driver (I2C), plus a mock for development.

Self-contained: the only dependency is smbus2 (or the older smbus), and only when
talking to real hardware. Compensation formulas are the floating-point versions
from the Bosch BME280 datasheet, section 4.2.3.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

# Registers
REG_CHIP_ID = 0xD0
REG_RESET = 0xE0
REG_CTRL_HUM = 0xF2
REG_STATUS = 0xF3
REG_CTRL_MEAS = 0xF4
REG_CONFIG = 0xF5
REG_DATA = 0xF7

CHIP_BME280 = 0x60  # BMP280 reports 0x58 and has no humidity sensor


@dataclass
class Reading:
    """One sensor sample. Temperature °C, humidity %RH, pressure Pa (station pressure)."""
    temperature_c: float
    humidity: float | None
    pressure_pa: float | None
    timestamp: float

    @property
    def dewpoint_c(self) -> float | None:
        """Magnus-Tetens dew point, accurate to ~0.4 °C over -45..60 °C."""
        if self.humidity is None or self.humidity <= 0:
            return None
        a, b = 17.62, 243.12
        gamma = (a * self.temperature_c) / (b + self.temperature_c) + math.log(self.humidity / 100.0)
        return (b * gamma) / (a - gamma)

    def sea_level_pressure_pa(self, altitude_m: float) -> float | None:
        """Station pressure corrected to sea level, so it is comparable with NWS reports."""
        if self.pressure_pa is None:
            return None
        t = self.temperature_c
        return self.pressure_pa * (1.0 - (0.0065 * altitude_m) / (t + 0.0065 * altitude_m + 273.15)) ** -5.257


def _s16(v: int) -> int:
    return v - 65536 if v > 32767 else v


def _s8(v: int) -> int:
    return v - 256 if v > 127 else v


class BME280:
    """Forced-mode BME280. One measurement per read(), so the chip idles between samples."""

    def __init__(self, bus: int = 1, address: int = 0x76):
        try:
            from smbus2 import SMBus  # type: ignore
        except ImportError:  # pragma: no cover - fallback for older Raspberry Pi OS
            try:
                from smbus import SMBus  # type: ignore
            except ImportError as exc:
                raise RuntimeError(
                    "No I2C library found. Install it with:  pip install smbus2\n"
                    "(or run the station with --mock to develop without hardware)"
                ) from exc
        self._bus = SMBus(bus)
        self.address = address

        chip = self._bus.read_byte_data(address, REG_CHIP_ID)
        self.has_humidity = chip == CHIP_BME280
        if chip not in (CHIP_BME280, 0x58):
            raise RuntimeError(
                f"No BME280 at I2C address 0x{address:02x} (chip id 0x{chip:02x}). "
                "Check wiring, and try address 0x77 — many breakout boards use it."
            )
        self._load_calibration()
        self._configure()

    def _load_calibration(self) -> None:
        b = self._bus.read_i2c_block_data(self.address, 0x88, 26)
        self.dig_T1 = b[0] | (b[1] << 8)
        self.dig_T2 = _s16(b[2] | (b[3] << 8))
        self.dig_T3 = _s16(b[4] | (b[5] << 8))
        self.dig_P1 = b[6] | (b[7] << 8)
        self.dig_P2 = _s16(b[8] | (b[9] << 8))
        self.dig_P3 = _s16(b[10] | (b[11] << 8))
        self.dig_P4 = _s16(b[12] | (b[13] << 8))
        self.dig_P5 = _s16(b[14] | (b[15] << 8))
        self.dig_P6 = _s16(b[16] | (b[17] << 8))
        self.dig_P7 = _s16(b[18] | (b[19] << 8))
        self.dig_P8 = _s16(b[20] | (b[21] << 8))
        self.dig_P9 = _s16(b[22] | (b[23] << 8))
        self.dig_H1 = b[25]

        h = self._bus.read_i2c_block_data(self.address, 0xE1, 7)
        self.dig_H2 = _s16(h[0] | (h[1] << 8))
        self.dig_H3 = h[2]
        self.dig_H4 = _s16((h[3] << 4) | (h[4] & 0x0F))
        self.dig_H5 = _s16((h[5] << 4) | (h[4] >> 4))
        self.dig_H6 = _s8(h[6])

    def _configure(self) -> None:
        # Oversampling x1 for all three; IIR filter off (we sample slowly anyway).
        self._bus.write_byte_data(self.address, REG_CTRL_HUM, 0x01)
        self._bus.write_byte_data(self.address, REG_CONFIG, 0x00)

    def read(self) -> Reading:
        # Trigger one forced measurement, then wait for the chip to finish.
        self._bus.write_byte_data(self.address, REG_CTRL_MEAS, (0x01 << 5) | (0x01 << 2) | 0x01)
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            if not self._bus.read_byte_data(self.address, REG_STATUS) & 0x08:
                break
            time.sleep(0.005)

        d = self._bus.read_i2c_block_data(self.address, REG_DATA, 8)
        adc_p = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
        adc_t = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4)
        adc_h = (d[6] << 8) | d[7]

        temperature, t_fine = self._compensate_temperature(adc_t)
        return Reading(
            temperature_c=round(temperature, 2),
            humidity=self._compensate_humidity(adc_h, t_fine) if self.has_humidity else None,
            pressure_pa=self._compensate_pressure(adc_p, t_fine),
            timestamp=time.time(),
        )

    def _compensate_temperature(self, adc_t: int) -> tuple[float, float]:
        var1 = (adc_t / 16384.0 - self.dig_T1 / 1024.0) * self.dig_T2
        var2 = ((adc_t / 131072.0 - self.dig_T1 / 8192.0) ** 2) * self.dig_T3
        t_fine = var1 + var2
        return t_fine / 5120.0, t_fine

    def _compensate_pressure(self, adc_p: int, t_fine: float) -> float | None:
        var1 = t_fine / 2.0 - 64000.0
        var2 = var1 * var1 * self.dig_P6 / 32768.0
        var2 = var2 + var1 * self.dig_P5 * 2.0
        var2 = var2 / 4.0 + self.dig_P4 * 65536.0
        var1 = (self.dig_P3 * var1 * var1 / 524288.0 + self.dig_P2 * var1) / 524288.0
        var1 = (1.0 + var1 / 32768.0) * self.dig_P1
        if var1 == 0:
            return None  # avoid division by zero on a bad sample
        p = 1048576.0 - adc_p
        p = (p - var2 / 4096.0) * 6250.0 / var1
        var1 = self.dig_P9 * p * p / 2147483648.0
        var2 = p * self.dig_P8 / 32768.0
        return round(p + (var1 + var2 + self.dig_P7) / 16.0, 1)

    def _compensate_humidity(self, adc_h: int, t_fine: float) -> float:
        h = t_fine - 76800.0
        h = (adc_h - (self.dig_H4 * 64.0 + self.dig_H5 / 16384.0 * h)) * (
            self.dig_H2 / 65536.0 * (1.0 + self.dig_H6 / 67108864.0 * h * (1.0 + self.dig_H3 / 67108864.0 * h))
        )
        h = h * (1.0 - self.dig_H1 * h / 524288.0)
        return round(min(100.0, max(0.0, h)), 2)

    def close(self) -> None:
        try:
            self._bus.close()
        except Exception:
            pass


class MockBME280:
    """Plausible fake readings so the service can be developed and tested without a Pi.

    Follows a daily temperature cycle with a slow random walk, so charts look real.
    """

    has_humidity = True

    def __init__(self, base_c: float = 11.0, swing_c: float = 7.0, altitude_m: float = 0.0):
        self.base_c = base_c
        self.swing_c = swing_c
        self.altitude_m = altitude_m
        self._drift = 0.0

    def read(self, at: float | None = None) -> Reading:
        """`at` overrides the clock, so past readings can be generated for seeding."""
        now = time.time() if at is None else at
        hour = time.localtime(now).tm_hour + time.localtime(now).tm_min / 60.0
        # Coldest around 05:00, warmest around 15:00.
        cycle = -math.cos((hour - 5.0) / 24.0 * 2 * math.pi)
        self._drift = max(-2.0, min(2.0, self._drift + random.uniform(-0.08, 0.08)))
        temp = self.base_c + self.swing_c * cycle + self._drift

        humidity = max(12.0, min(99.0, 68.0 - 18.0 * cycle + random.uniform(-2, 2)))
        # Pick a plausible sea-level pressure, then work back to what a sensor at
        # this altitude would actually read, so the round trip lands where it started.
        sea_level = 101_325 + 400 * math.sin(now / 36_000) + random.uniform(-40, 40)
        h = self.altitude_m
        pressure = sea_level * (1.0 - (0.0065 * h) / (temp + 0.0065 * h + 273.15)) ** 5.257
        return Reading(
            temperature_c=round(temp, 2),
            humidity=round(humidity, 2),
            pressure_pa=round(pressure, 1),
            timestamp=now,
        )

    def close(self) -> None:
        pass


def open_sensor(mock: bool = False, bus: int = 1, address: int = 0x76, altitude_m: float = 0.0):
    """Return a sensor object, falling back to the mock only when explicitly asked."""
    return MockBME280(altitude_m=altitude_m) if mock else BME280(bus=bus, address=address)
