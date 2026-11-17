"""Model-scoped O+ settings reads; writes are added only after captured validation."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import asyncio
import json
import os
from pathlib import Path
import re

from . import ble, protocol as p
from .vendor import keylinker as codec

EXPECTED_ID = {"vid": "1005", "pid": "2001", "version_display": "1.37", "mode": 6, "generation": 2}
RECORD_OPS = {"sticks": 0xB1, "triggers": 0xB2, "motors": 0xB3,
              "remapping": 0xB6, "lighting": 0xB7}
KEY_LABELS = {1: "A", 2: "B", 3: "X", 4: "Y", 5: "LB", 6: "RB", 7: "LT", 8: "RT",
              11: "LS", 12: "RS", 13: "下", 14: "上", 15: "右", 16: "左",
              17: "HOME", 18: "左摇杆", 19: "右摇杆", 93: "Back", 94: "Start",
              95: "Capture", 96: "Turbo", 97: "ML", 104: "M2"}
WRITE_OPS = {"motors": 0x33, "remapping": 0x36, "lighting": 0x37, "macro": 0x35}


def data_dir():
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "OPlusStudio"


def saved_address():
    try:
        return json.loads((data_dir()/"device.json").read_text(encoding="utf-8"))["address"]
    except (OSError, ValueError, KeyError):
        return ""


def remember_address(address):
    data_dir().mkdir(parents=True, exist_ok=True)
    (data_dir()/"device.json").write_text(json.dumps({"address": address}), encoding="utf-8")


def backup(snapshot):
    destination = data_dir()/"backups"
    destination.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = destination/f"oplus-1.37-{stamp}.json"
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def macro_sequence(raw, layout):
    data = bytes([raw["declared"]])+bytes.fromhex(raw["hex"])
    if raw["declared"] == 0:
        return {"sequence": "", "loop_ms": 0, "trigger": 0}
    program = codec.parse_macro_payload(data)
    groups = []
    for step in program.steps:
        names = codec.describe_mask(step.mask, layout)
        if not names:
            if groups:
                groups[-1][2] += step.duration_ms
        else:
            groups.append(["+".join(names), step.duration_ms, 0])
    return {"sequence": ", ".join(f"{keys}:{hold}/{gap}" for keys, hold, gap in groups),
            "loop_ms": program.loop_interval_ms, "trigger": program.trigger}


def encode_macro(sequence, key_list, loop_ms=0, trigger=0):
    layout = codec.layout_from_key_list(key_list)
    if trigger not in (0, 1) or type(loop_ms) is not int or not 0 <= loop_ms <= 20000:
        raise ValueError("宏触发模式或循环间隔无效")
    if not sequence.strip():
        raise ValueError("请输入板载宏或使用背键单键映射")
    steps = []
    for group in sequence.split(","):
        keys, _, timing = group.strip().partition(":")
        hold_text, slash, gap_text = timing.partition("/")
        try:
            hold, gap = int(hold_text or "100"), int(gap_text if slash else "60")
        except ValueError:
            raise ValueError("板载宏示例：A:100/60, B:80/0") from None
        if not 5 <= hold <= 10000 or not 0 <= gap <= 10000 or hold % 5 or gap % 5:
            raise ValueError("板载宏时间须为 5 ms 的倍数，按住 5–10000 ms，间隔 0–10000 ms")
        mask = codec.mask_for([codec.parse_token(token.strip()) for token in keys.split("+")], layout)
        steps.append(codec.MacroStep(mask, hold))
        if gap:
            steps.append(codec.MacroStep(layout.neutral, gap))
    # Old O+ advertises the legacy engine; keep the documented 42-entry cap.
    if len(steps) > 42:
        raise ValueError("此版本最多保存 42 条按下 / 松开记录")
    return codec.build_macro_payload(steps, loop_interval_ms=loop_ms, trigger=trigger)


def matched(info: dict) -> bool:
    return all(info.get(key) == value for key, value in EXPECTED_ID.items())


class BoardSession(ble.Identifier):
    def __init__(self, address):
        super().__init__(None)
        self.address = address
        self.verified = False
        self.info = None
        self.write_counter = 0
        self.host_counter = 8

    async def __aenter__(self):
        client_type, _ = ble._backend()
        self.client = client_type(self.address, timeout=12)
        try:
            await self.client.connect()
            if not self.client.services.get_service(p.CONFIG_SERVICE):
                raise RuntimeError("设备没有 KeyLinker 配置服务")
            await self.client.start_notify(p.CONFIG_NOTIFY, self.notified)
            response = await self.query(0x91, b"")
            self.info = p.identity(response.payload)
            if not matched(self.info):
                raise RuntimeError(f"型号 / 固件不匹配，停止读取设置：{self.info}")
            self.verified = True
            return self
        except BaseException:
            await self.client.disconnect()
            raise

    async def __aexit__(self, *_args):
        self.verified = False
        try:
            await self.client.stop_notify(p.CONFIG_NOTIFY)
        finally:
            await self.client.disconnect()

    def build_query(self, opcode, payload, serial):
        if opcode in (0x90, 0x91, 0xB0):
            return p.identification_query(opcode, payload, serial)
        if not self.verified:
            raise RuntimeError("读取设置前必须验证 O+ 身份和固件")
        return p.settings_query(opcode, payload, serial)

    async def snapshot(self) -> dict:
        result = {"timestamp": datetime.now(timezone.utc).isoformat(), "address": self.address,
                  "identity": self.info, "raw": {}, "decoded": {}, "errors": []}
        menu = await self.record(0xB0, b"\x00\x01")
        result["capabilities"] = menu
        capabilities = codec.parse_capabilities(codec.Body(menu["declared"], bytes.fromhex(menu["hex"])))
        result["decoded"]["capabilities"] = asdict(capabilities)
        for label, kind in [("all_keys", 2), ("remap_keys", 3), ("macro_keys", 5)]:
            raw = await self.record(0xB0, bytes([0, kind]))
            result["raw"][label] = raw
            result["decoded"][label] = codec.decode_key_list(bytes.fromhex(raw["hex"]))
        for label, opcode in RECORD_OPS.items():
            try:
                raw = await self.record(opcode, b"\x00")
                result["raw"][label] = raw
                body = codec.Body(raw["declared"], bytes.fromhex(raw["hex"]))
                if label in ("sticks", "triggers"):
                    scale = 100 if label == "sticks" else 200
                    result["decoded"][label] = [asdict(curve) for curve in codec.parse_curves(body, scale)]
                elif label == "lighting":
                    result["decoded"][label] = [asdict(entry) for entry in codec.parse_lighting(body)]
                elif label == "remapping":
                    result["decoded"][label] = codec.parse_changekey(result["decoded"]["remap_keys"], body.data) if body.declared else {}
                elif label == "motors":
                    result["decoded"][label] = list(body.data)
            except (TimeoutError, ValueError) as exc:
                result["errors"].append(f"{label}: {exc or '响应超时'}")
        for slot in range(6):
            try:
                result["raw"][f"macro_{slot}"] = await self.record(0xB5, bytes([0, slot]))
            except (TimeoutError, ValueError) as exc:
                result["errors"].append(f"macro_{slot}: {exc or '响应超时'}")
        layout = codec.layout_from_key_list(result["decoded"]["macro_keys"])
        result["decoded"]["macros"] = []
        for slot in range(6):
            raw = result["raw"].get(f"macro_{slot}")
            if raw is not None:
                try:
                    result["decoded"]["macros"].append({"slot": slot, **macro_sequence(raw, layout)})
                except ValueError as exc:
                    result["errors"].append(f"macro_{slot} decode: {exc}")
        result["trace"] = list(self.trace)
        return result

    async def write_record(self, feature, payload, slot=0):
        """A narrow settings-only I/O boundary. No arbitrary control/OTA API."""
        if not self.verified or feature not in WRITE_OPS:
            raise ValueError("型号未验证或写入功能不在允许列表中")
        if not payload or len(payload) > 240 or payload[0] != len(payload)-1:
            raise ValueError("待写入记录长度无效")
        if feature == "motors" and len(payload) != 9:
            raise ValueError("O+ 1.37 马达记录应为 8 字节")
        if feature == "remapping" and len(payload) != 17:
            raise ValueError("O+ 1.37 改键记录应为 16 个目标")
        if feature == "lighting" and len(payload) != 25:
            raise ValueError("O+ 1.37 灯光记录应为 24 字节")
        if feature == "macro" and (not 0 <= slot < 6 or payload[0] < 2 or (payload[0]-2) % 5):
            raise ValueError("宏槽位或记录结构无效")
        for chunk, offset in enumerate(range(0, len(payload), 15)):
            piece = payload[offset:offset+15]
            self.write_counter += 1
            if feature == "macro":
                wire = codec.build_macro_write(piece, slot=slot, chunk=chunk, counter=self.write_counter)
            else:
                self.host_counter = (self.host_counter-1) % 8
                wire = codec.build(WRITE_OPS[feature], piece,
                                   serial=codec.save_button_serial(chunk, self.write_counter),
                                   length_field=codec.host_length(len(piece), self.host_counter))
            packet = p.parse(wire)
            if packet.opcode != WRITE_OPS[feature] or packet.payload != piece:
                raise ValueError("编码后的命令与预期不符")
            waiter = asyncio.get_running_loop().create_future()
            self.waiters[packet.serial] = waiter
            self.trace.append({"direction": "tx", "opcode": packet.opcode, "serial": packet.serial,
                               "payload": piece.hex(" "), "wire": wire.hex(" ")})
            try:
                characteristic = self.client.services.get_characteristic(p.CONFIG_WRITE)
                await self.client.write_gatt_char(characteristic, wire, response="write" in characteristic.properties)
                await asyncio.wait_for(waiter, 3)
            finally:
                self.waiters.pop(packet.serial, None)
            await asyncio.sleep(.12)


def current_payload(snapshot, feature, slot=0):
    if feature == "macro":
        raw = snapshot["raw"][f"macro_{slot}"]
    else:
        raw = snapshot["raw"][feature]
    if feature == "remapping" and raw["declared"] == 0:
        return bytes([16])+bytes(16)
    return bytes([raw["declared"]])+bytes.fromhex(raw["hex"])


def desired_payload(snapshot, feature, change):
    """Change only specified bytes, preserving the freshly read remainder."""
    slot = int(change.get("slot", 0))
    if feature == "back_mapping":
        code = int(change["target"])
        if code not in snapshot["decoded"]["remap_keys"]:
            raise ValueError("该按键不在手柄支持的目标列表中")
        layout = codec.layout_from_key_list(snapshot["decoded"]["macro_keys"])
        mask = codec.mask_for([codec.Key(code)], layout)
        return "macro", codec.build_macro_payload([codec.MacroStep(mask, 0)]), slot
    if feature == "macro":
        return feature, encode_macro(change["sequence"], snapshot["decoded"]["macro_keys"],
                                     change.get("loop_ms", 0), change.get("trigger", 0)), slot
    if feature not in ("motors", "remapping", "lighting"):
        raise ValueError("此功能尚未开放写入")
    payload = bytearray(current_payload(snapshot, feature))
    if feature == "motors":
        levels = change["levels"]
        if len(levels) != 4 or any(type(x) is not int or not 0 <= x <= 100 for x in levels):
            raise ValueError("需要四个 0–100 的马达强度")
        payload[1:5] = bytes(round(x*255/100) for x in levels)
    elif feature == "lighting":
        zone, rgb = int(change["zone"]), change["rgb"]
        supported = snapshot["decoded"]["capabilities"]["lighting"]
        if not 0 <= zone < 4 or not supported & (1 << zone):
            raise ValueError("所选灯区未被手柄声明支持")
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", rgb):
            raise ValueError("颜色格式为 #RRGGBB")
        offset = 1+zone*6
        payload[offset:offset+3] = bytes.fromhex(rgb[1:])
    elif feature == "remapping":
        source, target = int(change["source"]), int(change["target"])
        sources = snapshot["decoded"]["remap_keys"]
        if source not in sources or target not in sources:
            raise ValueError("所选按键不在手柄支持的改键列表中")
        payload[1+sources.index(source)] = 0 if target == source else target
    return feature, bytes(payload), slot


async def read_settings(address):
    result = await snapshot(address)
    result["backup_path"] = backup(result)
    remember_address(address)
    return result


async def discover_settings():
    """Discover a single likely O+; exact identity is checked before settings."""
    devices = await ble.scan(timeout=5)
    named = [item for item in devices if any(token in item.get("name", "").casefold()
             for token in ("o+", "o plus", "致动"))]
    candidates = named or [item for item in devices if item.get("confirmed_service") or item.get("likely")]
    unique = {item["address"]: item for item in candidates}
    if not unique:
        raise RuntimeError("没有发现 O+ 配置广播。请开机、开启电脑蓝牙，并退出手机 KeyLinker 后重试。")
    if len(unique) > 1:
        raise RuntimeError("发现多个候选手柄，请在“设备与协议”页扫描、选中目标并读取身份，再返回此页。")
    return await read_settings(next(iter(unique)))


async def apply_settings(address, feature, change):
    async with BoardSession(address) as session:
        before = await session.snapshot()
        backup_path = backup(before)
        write_feature, payload, slot = desired_payload(before, feature, change)
        original = current_payload(before, write_feature, slot)
        if not original or (write_feature == "macro" and original == b"\x00"):
            raise ValueError("该槽为空，尚未验证空槽回滚；暂不写入")
        try:
            await session.write_record(write_feature, payload, slot)
            opcode = 0xB5 if write_feature == "macro" else RECORD_OPS[write_feature]
            query_payload = bytes([0, slot]) if write_feature == "macro" else b"\x00"
            observed = await session.record(opcode, query_payload)
            actual = bytes([observed["declared"]])+bytes.fromhex(observed["hex"])
            # An all-zero remap table may be normalized by the firmware to empty.
            if write_feature == "remapping" and actual == b"\x00" and payload[1:] == bytes(16):
                actual = bytes([16])+bytes(16)
            if actual != payload:
                raise RuntimeError(f"手柄读回与预期不一致，尝试恢复原记录：{actual.hex(' ')}")
        except BaseException as error:
            try:
                await session.write_record(write_feature, original, slot)
                check = await session.record(0xB5 if write_feature == "macro" else RECORD_OPS[write_feature],
                                             bytes([0, slot]) if write_feature == "macro" else b"\x00")
                restored = bytes([check["declared"]])+bytes.fromhex(check["hex"])
                if write_feature == "remapping" and restored == b"\x00" and original[1:] == bytes(16):
                    restored = bytes([16])+bytes(16)
                if restored != original:
                    raise RuntimeError("恢复读回不一致")
            except BaseException as rollback_error:
                raise RuntimeError(f"写入失败且恢复未确认：{error}；恢复错误：{rollback_error}。备份：{backup_path}") from error
            raise RuntimeError(f"写入失败，已恢复原记录：{error}。备份：{backup_path}") from error
        result = await session.snapshot()
        result["backup_path"] = backup_path
        result["write_result"] = {"feature": feature, "readback_verified": True,
                                  "physical_effect_verified": False}
        remember_address(address)
        return result


async def snapshot(address):
    async with BoardSession(address) as session:
        return await session.snapshot()
