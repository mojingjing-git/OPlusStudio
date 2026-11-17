"""Bounded, reversible physical rear-key identification using unique markers."""
from __future__ import annotations

import asyncio
import copy
import threading
import time

from . import board, rear
from .windows_input import BUTTONS, XInput


async def identify_slots(address, *, cancel=None, on_status=lambda _text: None, input_slot=0,
                         seconds=60, pad=None):
    if type(input_slot) is not int or input_slot not in range(4) or not 0 < seconds <= 60:
        raise ValueError("识别时长或 XInput 槽位无效")
    cancel = cancel if cancel is not None else threading.Event()
    callback = on_status
    def on_status(message):
        try:
            callback(message)
        except Exception:
            pass  # UI feedback must never prevent restoring the records.
    pad = pad if pad is not None else XInput()
    if pad.read(input_slot) is None:
        raise RuntimeError("识别需要手柄处于 XInput 模式并连接电脑；请先检查实时测试页")
    if any(pad.read(i) is not None for i in range(4) if i != input_slot):
        raise RuntimeError("识别时请只保留这一只 XInput 手柄，避免把其他设备的按键记为背键")
    async with board.BoardSession(address) as session:
        original = await session.snapshot()
        rear.layout(original)
        remappings = original.get("decoded", {}).get("remapping", {})
        if any(value not in (0, int(key)) for key, value in remappings.items()):
            raise RuntimeError("标准键存在自定义改键，可能影响识别标记；请先使用手动名称，或备份并还原标准改键后识别")
        originals = {slot: bytes.fromhex(rear.payload_hex(original, slot)) for slot in range(6)}
        if any(value == b"\x00" for value in originals.values()):
            raise RuntimeError("存在空宏槽，尚未验证其恢复方式；请先手动记住名称")
        backup_path = board.backup(original)
        marker_codes = [1, 2, 3, 4, 5, 6]
        marker_names = ["A", "B", "X", "Y", "LB", "RB"]
        markers = {BUTTONS[name]: i for i, name in enumerate(marker_names)}
        labels, attempted, error, restore_errors = {}, [], None, []
        try:
            for slot, code in enumerate(marker_codes):
                if cancel.is_set():
                    break
                on_status(f"正在设置临时标记 {slot+1}/6，请先松开所有按键…")
                payload = rear.encode_change(original, {"kind": "hold", "keys": [code]})
                attempted.append(slot)
                await session.write_record("macro", payload, slot)
                if await rear._read_back(session, slot) != payload:
                    raise RuntimeError(f"槽 {slot+1} 临时标记读回不一致")
            if len(attempted) == 6 and not cancel.is_set():
                deadline = time.monotonic()+seconds
                neutral = False
                held = None
                pressed_at = 0
                stage = 0
                on_status("请松开所有按键，然后只按一下实体 M1 并松开。")
                while time.monotonic() < deadline and not cancel.is_set() and stage < 6:
                    state = pad.read(input_slot)
                    if state is None:
                        raise RuntimeError("手柄游戏连接中断，正在恢复原配置")
                    buttons = state.buttons
                    if not buttons and state.left_trigger < 30 and state.right_trigger < 30:
                        if held is not None and time.monotonic()-pressed_at >= .04:
                            slot = held
                            if slot not in labels:
                                labels[slot] = rear.PHYSICAL_NAMES[stage]
                                stage += 1
                                if stage < 6:
                                    on_status(f"已识别 {stage}/6；现在只按一下实体 {rear.PHYSICAL_NAMES[stage]} 并松开。")
                            else:
                                on_status(f"这个键已识别，请改按实体 {rear.PHYSICAL_NAMES[stage]}。")
                        held = None
                        neutral = True
                    elif neutral and held is None and buttons in markers:
                        held = markers[buttons]
                        pressed_at = time.monotonic()
                        neutral = False
                    elif buttons not in markers:
                        held = None
                        neutral = False
                    await asyncio.sleep(.01)
        except BaseException as exc:
            error = exc
        finally:
            on_status("正在恢复原背键配置，请等待恢复完成后再关闭…")
            for slot in reversed(attempted):
                try:
                    await session.write_record("macro", originals[slot], slot)
                    if await rear._read_back(session, slot) != originals[slot]:
                        raise RuntimeError("恢复读回不一致")
                except BaseException as exc:
                    restore_errors.append(f"槽 {slot+1}：{exc}")
        if restore_errors:
            raise RuntimeError(f"识别结束，但部分原配置恢复未确认：{'；'.join(restore_errors)}。备份：{backup_path}") from error
        if error is not None:
            raise RuntimeError(f"识别未完成，原配置已恢复：{error}。备份：{backup_path}") from error
        result = copy.deepcopy(original)
        result["backup_path"] = backup_path
        result["identified_labels"] = labels if len(labels) == 6 else {}
        result["identification"] = {"completed": len(labels) == 6, "cancelled": cancel.is_set(),
                                     "partial_count": len(labels), "originals_restored": True}
        return result
