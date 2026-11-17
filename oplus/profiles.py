"""Validated, atomic local profiles; no executable actions in profiles."""
from __future__ import annotations

import json
import os
from pathlib import Path

from .windows_input import BUTTONS, available_keys

INPUTS = list(BUTTONS) + ["LT", "RT", "LX-", "LX+", "LY-", "LY+", "RX-", "RX+", "RY-", "RY+"]
DEFAULT = {"version": 1, "name": "默认配置", "mappings": {}, "macros": {},
           "mouse_enabled": False, "mouse_speed": 12, "mouse_deadzone": 8000}


def profile_path() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "OPlusStudio" / "profile.json"


def macro_from_text(text: str) -> list[dict]:
    result = []
    for entry in text.split(","):
        key, colon, timing = entry.strip().partition(":")
        if key not in available_keys() or key == "F8":
            raise ValueError(f"未知按键或被保留的 F8：{key}")
        hold, gap = 100, 60
        if colon:
            raw_hold, slash, raw_gap = timing.partition("/")
            try:
                hold = int(raw_hold)
                if slash:
                    gap = int(raw_gap)
            except ValueError:
                raise ValueError("宏格式示例：Q:100/60, E:80/60") from None
        if not 10 <= hold <= 10000 or not 0 <= gap <= 10000:
            raise ValueError("每步按住时间为 10–10000 ms，间隔为 0–10000 ms")
        result.append({"key": key, "hold_ms": hold, "after_ms": gap})
    if not 1 <= len(result) <= 128:
        raise ValueError("宏需要 1–128 步")
    return result


def macro_to_text(steps: list[dict]) -> str:
    return ", ".join(f"{step['key']}:{step['hold_ms']}/{step['after_ms']}" for step in steps)


def validate(profile: dict) -> dict:
    if not isinstance(profile, dict) or profile.get("version") != 1:
        raise ValueError("不支持的配置格式")
    mappings, macros = profile.get("mappings"), profile.get("macros")
    if not isinstance(mappings, dict) or not isinstance(macros, dict):
        raise ValueError("配置缺少 mappings 或 macros")
    if set(mappings) & set(macros):
        raise ValueError("同一输入不能同时分配按键和宏")
    for trigger, key in mappings.items():
        if trigger not in INPUTS or key not in available_keys() or key == "F8":
            raise ValueError(f"无效映射：{trigger} → {key}")
    for trigger, steps in macros.items():
        if trigger not in INPUTS or not isinstance(steps, list):
            raise ValueError("宏触发按键或步骤类型无效")
        if not steps or len(steps) > 128:
            raise ValueError("宏需要 1–128 步")
        for step in steps:
            if not isinstance(step, dict) or set(step) != {"key", "hold_ms", "after_ms"}:
                raise ValueError("宏步骤字段无效")
            if (not isinstance(step["key"], str) or step["key"] not in available_keys()
                    or step["key"] == "F8" or type(step["hold_ms"]) is not int
                    or type(step["after_ms"]) is not int
                    or not 10 <= step["hold_ms"] <= 10000
                    or not 0 <= step["after_ms"] <= 10000):
                raise ValueError("宏按键或时间无效")
    speed, deadzone = profile.get("mouse_speed", 12), profile.get("mouse_deadzone", 8000)
    if type(speed) not in (int, float) or not 1 <= speed <= 40:
        raise ValueError("鼠标速度范围是 1–40")
    if type(deadzone) is not int or not 1000 <= deadzone <= 30000:
        raise ValueError("摇杆死区范围是 1000–30000")
    if type(profile.get("mouse_enabled", False)) is not bool:
        raise ValueError("mouse_enabled 必须是布尔值")
    name = profile.get("name", "我的配置")
    if not isinstance(name, str) or len(name) > 100:
        raise ValueError("配置名称无效")
    return {"version": 1, "name": name, "mappings": dict(mappings),
            "macros": {key: [dict(step) for step in steps] for key, steps in macros.items()},
            "mouse_enabled": profile.get("mouse_enabled", False),
            "mouse_speed": speed, "mouse_deadzone": deadzone}


def load(path: Path) -> dict:
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("配置文件过大")
    return validate(json.loads(path.read_text(encoding="utf-8-sig")))


def save(path: Path, profile: dict) -> None:
    clean = validate(profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
