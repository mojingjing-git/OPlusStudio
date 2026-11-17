"""Optional BLE identification. No setting writes or OTA operations."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from . import protocol as p


def _backend():
    try:
        from bleak import BleakClient, BleakScanner
        return BleakClient, BleakScanner
    except ImportError as exc:
        raise RuntimeError("尚未安装 BLE 依赖。运行：python -m pip install -r requirements.txt") from exc


async def scan(timeout: float = 8.0) -> list[dict]:
    _, scanner = _backend()
    from bleak.exc import BleakBluetoothNotAvailableError
    try:
        devices = await scanner.discover(timeout=timeout, return_adv=True)
    except BleakBluetoothNotAvailableError as exc:
        raise RuntimeError("Windows 当前没有可用的蓝牙适配器。请先检查蓝牙设备是否正常识别并加载驱动。") from exc
    candidates = []
    for device, adv in devices.values():
        services = [str(u).lower() for u in adv.service_uuids]
        name = adv.local_name or device.name or ""
        likely = (p.CONFIG_SERVICE in services
                  or device.address.upper().startswith(("98:B6:E9", "98:B6:EC", "98:B6:ED"))
                  or any(hint in name.casefold() for hint in ("keylink", "xpert", "zd-", "zd ", "o+", "o plus")))
        # O+ advertisement names and MAC prefixes are unverified. Do not silently
        # hide an O+ that uses a different name or omits the service in its advert.
        candidates.append({"name": name or "未命名设备", "address": device.address,
                           "rssi": adv.rssi, "services": services, "likely": likely,
                           "confirmed_service": p.CONFIG_SERVICE in services})
    return sorted(candidates, key=lambda item: (item["confirmed_service"], item["likely"], item["rssi"]), reverse=True)


class Identifier:
    def __init__(self, client):
        self.client = client
        self.serial = 0
        self.waiters: dict[int, asyncio.Future] = {}
        self.trace: list[dict] = []

    def notified(self, _sender, raw: bytearray):
        record = {"direction": "rx", "wire": bytes(raw).hex(" ")}
        try:
            packet = p.parse(bytes(raw))
            record.update(opcode=packet.opcode, serial=packet.serial,
                          payload=packet.payload.hex(" "))
            # Only response frames may satisfy an outstanding identification query.
            waiter = self.waiters.get(packet.serial)
            if packet.opcode == 0x19 and waiter is not None and not waiter.done():
                waiter.set_result(packet)
        except ValueError as exc:
            record["error"] = str(exc)
        self.trace.append(record)

    async def query(self, opcode: int, payload: bytes) -> p.Packet:
        self.serial += 1
        serial = (self.serial % 128) + (128 if self.serial % 2 == 0 else 0)
        # Validate immediately before writing; callers cannot supply raw packets.
        wire = self.build_query(opcode, payload, serial)
        waiter = asyncio.get_running_loop().create_future()
        self.waiters[serial] = waiter
        self.trace.append({"direction": "tx", "opcode": opcode,
                           "serial": serial, "payload": payload.hex(" "), "wire": wire.hex(" ")})
        try:
            characteristic = self.client.services.get_characteristic(p.CONFIG_WRITE)
            response = "write" in characteristic.properties
            await self.client.write_gatt_char(characteristic, wire, response=response)
            return await asyncio.wait_for(waiter, timeout=3.0)
        finally:
            self.waiters.pop(serial, None)
            if not waiter.done():
                waiter.cancel()

    def build_query(self, opcode: int, payload: bytes, serial: int) -> bytes:
        return p.identification_query(opcode, payload, serial)

    async def record(self, opcode: int, payload: bytes) -> dict:
        packet = await self.query(opcode, payload)
        if not packet.payload:
            raise ValueError("设备响应缺少记录长度")
        declared = packet.payload[0]
        data = packet.payload[1:]
        for index in range(1, 32):
            if len(data) >= declared:
                break
            more = await self.query(opcode, bytes([index]) + payload[1:])
            if not more.payload:
                raise ValueError("设备返回空的分段响应")
            data += more.payload
        if len(data) != declared:
            raise ValueError(f"记录长度不匹配：应为 {declared}，收到 {len(data)}")
        return {"declared": declared, "hex": data.hex(" "),
                "text": data.decode("utf-8", "replace") if opcode == 0x90 else None}


async def identify(address: str) -> dict:
    client_type, _ = _backend()
    result = {"timestamp": datetime.now(timezone.utc).isoformat(), "address": address,
              "model_verified": False, "writes_supported": False, "records": {}, "errors": []}
    async with client_type(address, timeout=12.0) as client:
        services = {service.uuid.lower() for service in client.services}
        result["services"] = sorted(services)
        if p.CONFIG_SERVICE not in services:
            raise RuntimeError("该设备没有已知的 KeyLinker 配置服务。没有发送任何协议命令。")
        if (not client.services.get_characteristic(p.CONFIG_WRITE)
                or not client.services.get_characteristic(p.CONFIG_NOTIFY)):
            raise RuntimeError("KeyLinker 配置特征不完整。没有发送任何协议命令。")
        identifier = Identifier(client)
        await client.start_notify(p.CONFIG_NOTIFY, identifier.notified)
        try:
            try:
                packet = await identifier.query(0x91, b"")
                result["identity"] = p.identity(packet.payload)
                from .board import matched, WRITE_OPS
                result["model_verified"] = matched(result["identity"])
                result["writes_supported"] = result["model_verified"]
                result["verified_record_writes"] = list(WRITE_OPS) if result["model_verified"] else []
            except (TimeoutError, ValueError) as exc:
                result["errors"].append(f"身份查询失败：{exc or '响应超时'}")
                # Do not assume the protocol dialect if identity is unreadable.
                return result
            for label, opcode, payload in [
                ("name", 0x90, b"\x00"),
                ("capabilities", 0xB0, b"\x00\x01"),
                ("all_keys", 0xB0, b"\x00\x02"),
                ("remap_keys", 0xB0, b"\x00\x03"),
                ("macro_keys", 0xB0, b"\x00\x05"),
            ]:
                try:
                    result["records"][label] = await identifier.record(opcode, payload)
                except (TimeoutError, ValueError) as exc:
                    result["errors"].append(f"{label}：{exc or '响应超时'}")
        finally:
            result["trace"] = identifier.trace
            await client.stop_notify(p.CONFIG_NOTIFY)
    return result
