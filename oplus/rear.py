"""O+ rear-slot editing, portable profiles, and verified transactions."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile

from . import board
from .vendor import keylinker as codec

SLOT_COUNT = 6
PHYSICAL_NAMES = ("M1", "M2", "LM", "RM", "LK", "RK")
# Verified on O+ 1.37 by physical presses; see phase1-physical-identification.json.
# Capability-driven discovery follows KeyLinker; shell labels remain model data.
OPLUS_MACRO_KEYS = (18, 19, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 93, 94)


def _slot(value):
    if type(value) is not int or not 0 <= value < SLOT_COUNT:
        raise ValueError("背键槽位必须是 1–6 中的一项")
    return value


def layout(snapshot):
    if not board.matched(snapshot.get("identity", {})):
        raise ValueError("配置不属于已适配的 O+ 1.37")
    keys = snapshot.get("decoded", {}).get("macro_keys", [])
    if not keys or any(type(k) is not int for k in keys) or len(set(keys)) != len(keys):
        raise ValueError("手柄的宏按键表不完整，请重新读取")
    result = codec.layout_from_key_list(keys)
    if result.width > 24:
        raise ValueError("该宏布局超出已适配范围")
    return result


def payload_hex(snapshot, slot):
    _slot(slot)
    raw = snapshot.get("raw", {}).get(f"macro_{slot}")
    if not isinstance(raw, dict) or type(raw.get("declared")) is not int:
        raise ValueError(f"背键槽 {slot+1} 未完整读取")
    data = bytes.fromhex(raw["hex"])
    if len(data) != raw["declared"] or len(data) > 239:
        raise ValueError("宏记录长度不正确")
    return (bytes([len(data)])+data).hex(" ")


def validate_record(snapshot, payload):
    spec = layout(snapshot)
    if payload == b"\x00":
        return payload
    if not 8 <= len(payload) <= 213 or payload[0] != len(payload)-1 or (len(payload)-3) % 5:
        raise ValueError("宏记录格式或长度不正确")
    if payload[2] & 0x70:
        raise ValueError("宏记录包含尚未适配的标志")
    allowed = sum(1 << bit for bit in spec.digital.values())
    for shift in spec.analog.values():
        allowed |= 15 << shift
    program = codec.parse_macro_payload(payload)
    for step in program.steps:
        if step.mask & ~allowed:
            raise ValueError("宏使用了手柄未声明支持的按键")
        if any(((step.mask >> shift) & 15) > 8 for shift in spec.analog.values()):
            raise ValueError("宏的摇杆方向编码无效")
    return payload


def encode_change(snapshot, change):
    spec = layout(snapshot)
    if not isinstance(change, dict):
        raise ValueError("背键配置必须是对象")
    kind = change.get("kind")
    if kind == "record":
        payload = bytes.fromhex(change["payload"])
    elif kind == "hold":
        keys = change.get("keys")
        if not isinstance(keys, list) or not keys or any(type(k) is not int for k in keys):
            raise ValueError("请至少选择一个手柄按键")
        if len(set(keys)) != len(keys):
            raise ValueError("组合键不能包含重复按键")
        if any(k not in snapshot["decoded"]["remap_keys"] or codec.Key(k) not in spec.digital for k in keys):
            raise ValueError("所选按键不在设备支持的背键目标中")
        # Mutually opposite directions are not a usable held D-pad mapping.
        if {13, 14} <= set(keys) or {15, 16} <= set(keys):
            raise ValueError("十字键不能同时选择相反方向")
        mask = codec.mask_for([codec.Key(k) for k in keys], spec)
        payload = codec.build_macro_payload([codec.MacroStep(mask, 0)])
    elif kind == "macro":
        payload = board.encode_macro(change.get("sequence", ""), spec.key_list,
                                     change.get("loop_ms", 0), change.get("trigger", 0))
    else:
        raise ValueError("未知的背键配置类型")
    return validate_record(snapshot, payload)


def describe(snapshot, slot, change=None):
    try:
        data = encode_change(snapshot, change) if change else bytes.fromhex(payload_hex(snapshot, slot))
        if data == b"\x00":
            return "空槽"
        spec = layout(snapshot)
        program = codec.parse_macro_payload(data)
        if len(program.steps) == 1 and program.steps[0].duration_ms == 0 and not program.loop_interval_ms:
            keys = codec.describe_mask(program.steps[0].mask, spec)
            return "保持 " + " + ".join(keys) if keys else "无按键输出"
        raw = {"declared": data[0], "hex": data[1:].hex()}
        info = board.macro_sequence(raw, spec)
        repeat = f"；循环间隔 {program.loop_interval_ms} ms" if program.loop_interval_ms else ""
        return "宏：" + (info["sequence"] or "仅等待") + repeat
    except (ValueError, KeyError, TypeError) as exc:
        return f"不可编辑：{exc}"


def _atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name+".", delete=False) as stream:
            temporary = stream.name
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def _label_path(address):
    token = hashlib.sha256(address.upper().encode()).hexdigest()[:16]
    return board.data_dir()/f"rear-labels-{token}.json"


def save_labels(address, labels):
    clean = {}
    for slot, label in labels.items():
        _slot(slot)
        if not isinstance(label, str) or len(label.strip()) > 20:
            raise ValueError("背键名称最多 20 个字符")
        if label.strip():
            clean[str(slot)] = label.strip()
    if len(set(clean.values())) != len(clean):
        raise ValueError("两个槽位不能使用同一个实体背键名称")
    _atomic_json(_label_path(address), {"address": address.upper(), "labels": clean})


def load_labels(address):
    try:
        record = json.loads(_label_path(address).read_text(encoding="utf-8"))
        if record.get("address") != address.upper():
            return {}
        return {int(k): v for k, v in record["labels"].items()
                if str(k) in map(str, range(6)) and isinstance(v, str) and len(v) <= 20}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def resolve_labels(snapshot):
    """Use a verified model preset across addresses, with local corrections first.

    This is local metadata only: no connection, configuration write or calibration.
    """
    preset = {}
    try:
        caps = bytes.fromhex(snapshot.get("capabilities", {}).get("hex", ""))
        if (board.matched(snapshot.get("identity", {}))
                and tuple(snapshot.get("decoded", {}).get("macro_keys", ())) == OPLUS_MACRO_KEYS
                and len(caps) == 10 and caps[4] == 0x3f):
            preset = dict(enumerate(PHYSICAL_NAMES))
    except (ValueError, TypeError, AttributeError):
        pass
    saved = load_labels(snapshot.get("address", ""))
    # A correction may move a name to another slot; never show duplicate names.
    labels = {slot: name for slot, name in preset.items()
              if slot not in saved and name not in saved.values()}
    labels.update(saved)
    if saved:
        source = "名称来源：本机保存的对应关系" + ("；其余采用 O+ 1.37 型号预设。" if any(i not in saved for i in labels) else "。")
    elif preset:
        source = "名称来源：已实测的 O+ 1.37 型号预设；换同款可直接使用，无需逐键识别。"
    else:
        source = "尚无匹配的型号预设；可手动填写名称或引导识别。"
    return labels, source


def save_profile(path, snapshot, labels=None):
    layout(snapshot)
    slots = [{"slot": i, "payload": payload_hex(snapshot, i), "label": (labels or {}).get(i, "")}
             for i in range(SLOT_COUNT)]
    for row in slots:
        validate_record(snapshot, bytes.fromhex(row["payload"]))
    _atomic_json(path, {"format": "oplus-rear-v1", "identity": dict(board.EXPECTED_ID),
                        "macro_keys": list(snapshot["decoded"]["macro_keys"]), "slots": slots})


def load_profile(path, snapshot):
    if Path(path).stat().st_size > 65536:
        raise ValueError("配置文件过大")
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    # Automatic full-board backups can restore just their six rear records.
    if isinstance(data, dict) and "format" not in data and isinstance(data.get("raw"), dict):
        saved_layout = layout(data)
        data = {"format": "oplus-rear-v1", "identity": data["identity"],
                "macro_keys": list(saved_layout.key_list),
                "slots": [{"slot": i, "payload": payload_hex(data, i)} for i in range(SLOT_COUNT)]}
    if not isinstance(data, dict) or data.get("format") != "oplus-rear-v1" or not board.matched(data.get("identity", {})):
        raise ValueError("请选择 O+ 1.37 的背键配置文件")
    if data.get("macro_keys") != list(layout(snapshot).key_list):
        raise ValueError("配置文件的按键布局与这只手柄不同")
    rows = data.get("slots")
    if not isinstance(rows, list) or len(rows) != SLOT_COUNT:
        raise ValueError("背键配置必须完整包含六个槽位")
    changes = {}
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("背键槽记录无效")
        slot = _slot(row.get("slot"))
        if slot in seen:
            raise ValueError("配置包含重复槽位")
        seen.add(slot)
        payload = validate_record(snapshot, bytes.fromhex(row["payload"]))
        if payload != bytes.fromhex(payload_hex(snapshot, slot)):
            if payload == b"\x00":
                raise ValueError("尚未验证清空槽位，不能导入此项")
            changes[slot] = {"kind": "record", "payload": payload.hex(" ")}
    return changes


async def _read_back(session, slot):
    raw = await session.record(0xB5, bytes([0, slot]))
    return bytes([raw["declared"]])+bytes.fromhex(raw["hex"])


async def apply_changes(address, changes, *, expected=None):
    if not isinstance(changes, dict) or not changes:
        raise ValueError("没有待写入的背键修改")
    for slot in changes:
        _slot(slot)
    async with board.BoardSession(address) as session:
        before = await session.snapshot()
        layout(before)
        originals, desired = {}, {}
        # Complete validation and conflict detection precede every write.
        for slot, change in changes.items():
            original = bytes.fromhex(payload_hex(before, slot))
            target = encode_change(before, change)
            if expected is not None and (slot not in expected or original != bytes.fromhex(expected[slot])):
                raise RuntimeError(f"槽 {slot+1} 已被其他操作修改；请重新读取后检查待写入配置")
            if target == original:
                continue
            if original == b"\x00" or target == b"\x00":
                raise ValueError(f"槽 {slot+1} 为空或要清空；空槽恢复尚未验证，暂不写入")
            originals[slot], desired[slot] = original, target
        if not desired:
            return {**before, "write_result": {"feature": "rear", "readback_verified": True,
                                               "changed_slots": []}, "undo_changes": {}, "undo_expected": {}}
        backup_path = board.backup(before)
        attempted = []
        try:
            for slot in sorted(desired):
                attempted.append(slot)  # include a partly transmitted record
                await session.write_record("macro", desired[slot], slot)
                if await _read_back(session, slot) != desired[slot]:
                    raise RuntimeError(f"槽 {slot+1} 读回与目标不一致")
        except BaseException as error:
            failures = []
            for slot in reversed(attempted):
                try:
                    await session.write_record("macro", originals[slot], slot)
                    if await _read_back(session, slot) != originals[slot]:
                        raise RuntimeError("恢复读回不一致")
                except BaseException as exc:
                    failures.append(f"槽 {slot+1}：{exc}")
            if failures:
                raise RuntimeError(f"写入失败，部分恢复未确认：{'；'.join(failures)}。备份：{backup_path}") from error
            raise RuntimeError(f"写入失败，已恢复本次尝试的所有背键：{error}。备份：{backup_path}") from error
        result = copy.deepcopy(before)
        spec = layout(before)
        for slot, target in desired.items():
            result["raw"][f"macro_{slot}"] = {"declared": target[0], "hex": target[1:].hex(" ")}
        result["decoded"]["macros"] = [
            {"slot": slot, **board.macro_sequence(result["raw"][f"macro_{slot}"], spec)}
            for slot in range(SLOT_COUNT) if result["raw"].get(f"macro_{slot}", {}).get("declared")]
        result["backup_path"] = backup_path
        result["write_result"] = {"feature": "rear", "readback_verified": True,
                                  "changed_slots": sorted(desired), "physical_effect_verified": False}
        result["undo_changes"] = {slot: {"kind": "record", "payload": value.hex(" ")}
                                   for slot, value in originals.items()}
        result["undo_expected"] = {slot: value.hex(" ") for slot, value in desired.items()}
        board.remember_address(address)
        return result
