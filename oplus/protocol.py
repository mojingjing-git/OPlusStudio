"""KeyLinker identification only; framing adapted from x20ctl (GPL-3.0+).

Source: AmjadAAYD/x20ctl, fce9627ea47af1532ee37c52d087983aa89d2d39.
No configuration write, reset, calibration or firmware commands are exposed.
"""
from __future__ import annotations

from dataclasses import dataclass
import secrets

CONFIG_SERVICE = "d7f010e0-660d-46e9-96c3-19c4148bdab5"
CONFIG_WRITE = "d7f010e1-660d-46e9-96c3-19c4148bdab5"
CONFIG_NOTIFY = "d7f010e2-660d-46e9-96c3-19c4148bdab5"
SEND_KEY = (51, 99, 157, 121, 242, 219, 162, 26, 170, 33, 139, 232, 116, 211, 88)
SERIAL_KEY = (161, 82, 213, 163, 245, 137, 246, 143, 240, 157, 72, 147, 234, 52,
              49, 186, 195, 77, 198, 235, 73, 96, 216, 163, 218, 42, 83, 141,
              244, 97, 24, 191, 174, 215, 111, 81, 228, 160, 217, 146)


def crc8(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xEB) if crc & 1 else crc >> 1
    return crc


def _check_size(data: bytes) -> None:
    if not 5 <= len(data) <= 20:
        raise ValueError("KeyLinker 帧必须为 5–20 字节")


def scramble(data: bytes) -> bytes:
    _check_size(data)
    out = bytearray(len(data))
    serial, nonce = data[2:4]
    out[0] = (data[0] ^ (serial + nonce - 154)) & 255
    out[1] = (data[1] ^ (serial + nonce + 155)) & 255
    out[2] = ((serial - 173) ^ nonce) & 255
    out[3] = ((nonce + 191) ^ 219) & 255
    for i in range(4, len(data) - 1):
        out[i] = (data[i] ^ (serial + nonce - SEND_KEY[i - 4])) & 255
    out[-1] = data[-1]
    offset = (out[3] & 2) * 10
    return bytes(byte ^ SERIAL_KEY[offset + i] for i, byte in enumerate(out))


def unscramble(data: bytes) -> bytes:
    _check_size(data)
    offset = 20 if (data[3] ^ SERIAL_KEY[3]) & 2 else 0
    out = bytearray(byte ^ SERIAL_KEY[offset + i] for i, byte in enumerate(data))
    nonce = ((out[3] ^ 219) - 191) & 255
    serial = ((out[2] ^ nonce) + 173) & 255
    out[0] = (out[0] ^ (serial + nonce - 154)) & 255
    out[1] = (out[1] ^ (serial + nonce + 155)) & 255
    out[2], out[3] = serial, nonce
    for i in range(4, len(data) - 1):
        out[i] = (out[i] ^ (serial + nonce - SEND_KEY[i - 4])) & 255
    return bytes(out)


@dataclass(frozen=True)
class Packet:
    opcode: int
    serial: int
    payload: bytes


def parse(raw: bytes) -> Packet:
    plain = unscramble(raw)
    if plain[1] & 31 != len(plain):
        raise ValueError("响应帧长度不匹配")
    if crc8(plain[:-1]) != plain[-1]:
        raise ValueError("响应 CRC 校验失败")
    return Packet(plain[0], plain[2], plain[4:-1])


def identification_query(opcode: int, payload: bytes, serial: int,
                         nonce: int | None = None) -> bytes:
    """An allowlist is applied at the actual transport boundary as well."""
    allowed = ((opcode == 0x91 and not payload)
               or (opcode == 0x90 and len(payload) == 1 and payload[0] < 8)
               or (opcode == 0xB0 and len(payload) == 2
                   and payload[0] < 8 and 1 <= payload[1] <= 5))
    if not allowed:
        raise ValueError("只允许设备身份和能力查询；此版本未实现配置写入")
    return _frame(opcode, payload, serial, nonce=nonce)


def settings_query(opcode: int, payload: bytes, serial: int) -> bytes:
    """Known read shapes, used only after BoardSession verifies the O+ identity."""
    if opcode in (0x90, 0x91, 0xB0):
        return identification_query(opcode, payload, serial)
    if opcode in (0xB1, 0xB2, 0xB3, 0xB6, 0xB7):
        allowed = len(payload) == 1 and payload[0] < 32
    elif opcode == 0xB5:
        allowed = len(payload) == 2 and payload[0] < 32 and payload[1] < 6
    else:
        allowed = False
    if not allowed:
        raise ValueError("不允许的设置读取命令")
    return _frame(opcode, payload, serial)


def _frame(opcode: int, payload: bytes, serial: int, *, nonce: int | None = None,
           length_field: int | None = None) -> bytes:
    nonce = secrets.randbelow(256) if nonce is None else nonce
    length = len(payload) + 5 if length_field is None else length_field
    body = bytes([opcode, length, serial, nonce]) + payload
    return scramble(body + bytes([crc8(body)]))


def identity(payload: bytes) -> dict:
    if not payload or payload[0] < 6 or len(payload) != payload[0] + 1:
        raise ValueError("身份记录不完整或长度未知，保留原始数据")
    data = payload[1:]
    result = {"vid": data[:2].hex().upper(), "pid": data[2:4].hex().upper(),
              "version_bytes": data[4:6].hex(), "raw": data.hex(" ")}
    # The vendor formats these bytes as hexadecimal text, e.g. 01 23 -> 1.23.
    result["version_display"] = f"{data[4]:X}.{data[5]:02X}"
    if len(data) == 7:
        result.update(mode=data[6] & 15, sensor=(data[6] >> 4) & 1,
                      generation=data[6] >> 5)
    return result
