"""Non-blocking controller-to-keyboard/mouse mapping engine."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .windows_input import State


MOUSE_MAX_DT = 0.05
MOUSE_FRAME_RATE = 60.0


@dataclass(frozen=True, slots=True)
class _MacroStep:
    key: str
    hold_ms: float
    after_ms: float


@dataclass(slots=True)
class _MacroRun:
    source: str
    steps: tuple[_MacroStep, ...]
    index: int = 0
    phase: str = "hold"
    deadline: float = 0.0
    held_token: str | None = None


class MappingEngine:
    """Turn semantic controller inputs into output keys and timed macros.

    Output keys are reference counted by semantic identity. Mapping sources and
    macro runs both own references, so a shared key is released only after every
    owner has let it go.
    """

    def __init__(self, output) -> None:
        self.output = output
        self.last_error = ""
        self._enabled = False
        self._armed = False
        self._mappings: dict[str, str] = {}
        self._macros: dict[str, tuple[_MacroStep, ...]] = {}
        self._mouse_enabled = False
        self._mouse_speed = 12.0
        self._mouse_deadzone = 8000

        self._previous_active: set[str] = set()
        self._state_index: int | None = None
        self._last_tick: float | None = None
        self._key_refcounts: dict[str, int] = {}
        self._key_names: dict[str, str] = {}
        self._mapping_refs: dict[str, str] = {}
        self._macro_runs: dict[str, _MacroRun] = {}

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        value = bool(value)
        if value:
            if not self._enabled:
                self._armed = False
                self._last_tick = None
                self._state_index = None
            self._enabled = True
            return

        self._enabled = False
        self._disarm_and_release()

    def configure(
        self,
        mappings: dict[str, str],
        macros: dict[str, list[dict]],
        mouse_enabled: bool = False,
        mouse_speed: float = 12,
        mouse_deadzone: int = 8000,
    ) -> None:
        """Replace configuration and require a neutral frame before output."""

        self.last_error = ""
        self._release_all()

        self._mappings = {
            str(source): str(target) for source, target in (mappings or {}).items()
        }
        parsed_macros: dict[str, tuple[_MacroStep, ...]] = {}
        for source, raw_steps in (macros or {}).items():
            steps: list[_MacroStep] = []
            if isinstance(raw_steps, Sequence) and not isinstance(
                raw_steps, (str, bytes, bytearray)
            ):
                for raw in raw_steps:
                    if not isinstance(raw, Mapping) or not raw.get("key"):
                        continue
                    steps.append(
                        _MacroStep(
                            key=str(raw["key"]),
                            hold_ms=self._nonnegative_number(raw.get("hold_ms", 0)),
                            after_ms=self._nonnegative_number(raw.get("after_ms", 0)),
                        )
                    )
            parsed_macros[str(source)] = tuple(steps)
        self._macros = parsed_macros

        self._mouse_enabled = bool(mouse_enabled)
        try:
            parsed_mouse_speed = float(mouse_speed)
        except (TypeError, ValueError, OverflowError):
            parsed_mouse_speed = 0.0
        if not math.isfinite(parsed_mouse_speed):
            parsed_mouse_speed = 0.0
        self._mouse_speed = max(0.0, parsed_mouse_speed)
        self._mouse_deadzone = max(0, min(32767, int(mouse_deadzone)))
        self._previous_active.clear()
        self._state_index = None
        self._last_tick = None
        self._armed = False

    def tick(self, state: State | None, now: float) -> None:
        """Advance one non-blocking engine frame."""

        now = float(now)
        if not math.isfinite(now):
            raise ValueError("now must be finite")

        if not self._enabled:
            self._release_all()
            self._armed = False
            return

        if self._panic_pressed():
            self.stop()
            return

        if state is None:
            self._disarm_and_release()
            return

        try:
            active = set(state.active_inputs())
            state_index = int(state.index)
        except Exception as exc:
            self._fail(exc)
            return

        if self._state_index is not None and self._state_index != state_index:
            self._disarm_and_release()
        self._state_index = state_index

        if not self._armed:
            self._release_all()
            self._previous_active.clear()
            self._last_tick = now
            if not active:
                self._armed = True
            return

        # Release mapped inputs first. Since release only lowers reference
        # counts, keys still owned by another input or macro remain down.
        for source in tuple(self._mapping_refs):
            if source not in active:
                if not self._release_mapping(source):
                    return

        for source, target in self._mappings.items():
            if source in active and source not in self._mapping_refs:
                if not self._acquire_mapping(source, target):
                    return

        for source in self._macros:
            if (
                source in active
                and source not in self._previous_active
                and source not in self._macro_runs
            ):
                if not self._start_macro(source, now):
                    return

        if self._mouse_enabled:
            self._move_from_right_stick(state, now)
            if not self._enabled:
                return

        self._previous_active = active
        self._advance_macros(now)

    def stop(self) -> None:
        """Release every owned key and disable the engine."""

        self._enabled = False
        self._disarm_and_release()

    def _acquire_mapping(self, source: str, key: str) -> bool:
        token = self._token(key)
        if not self._acquire_token(token, key):
            return False
        self._mapping_refs[source] = token
        return True

    def _release_mapping(self, source: str) -> bool:
        token = self._mapping_refs.pop(source, None)
        if token is None:
            return True
        return self._release_token(token)

    def _start_macro(self, source: str, now: float) -> bool:
        steps = self._macros[source]
        if not steps:
            return True
        run = _MacroRun(source=source, steps=steps)
        if not self._acquire_macro_key(run):
            return False
        run.deadline = now + steps[0].hold_ms / 1000.0
        self._macro_runs[source] = run
        return True

    def _advance_macros(self, now: float) -> None:
        for source in tuple(self._macro_runs):
            run = self._macro_runs.get(source)
            while run is not None and run.deadline <= now + 1e-9:
                if run.phase == "hold":
                    if not self._release_macro_key(run):
                        return
                    deadline = run.deadline
                    run.phase = "after"
                    run.deadline = deadline + run.steps[run.index].after_ms / 1000.0
                    continue

                next_index = run.index + 1
                if next_index >= len(run.steps):
                    self._macro_runs.pop(source, None)
                    break

                deadline = run.deadline
                run.index = next_index
                run.phase = "hold"
                if not self._acquire_macro_key(run):
                    return
                run.deadline = deadline + run.steps[next_index].hold_ms / 1000.0

    def _acquire_macro_key(self, run: _MacroRun) -> bool:
        step = run.steps[run.index]
        token = self._token(step.key)
        if not self._acquire_token(token, step.key):
            return False
        run.held_token = token
        return True

    def _release_macro_key(self, run: _MacroRun) -> bool:
        token = run.held_token
        run.held_token = None
        if token is None:
            return True
        return self._release_token(token)

    def _acquire_token(self, token: str, key: str) -> bool:
        if self._key_refcounts.get(token, 0) == 0:
            try:
                result = self.output.key(key, True)
            except Exception as exc:
                self._fail(exc)
                return False
            if result is False:
                self._fail(OSError(f"output refused key down for {key!r}"))
                return False
            self._key_refcounts[token] = 1
            self._key_names[token] = key
        else:
            self._key_refcounts[token] += 1
        return True

    def _release_token(self, token: str) -> bool:
        count = self._key_refcounts.get(token, 0)
        if count <= 0:
            return True
        if count > 1:
            self._key_refcounts[token] = count - 1
            return True

        key = self._key_names.get(token, token)
        try:
            result = self.output.key(key, False)
        except Exception as exc:
            self._fail(exc)
            return False
        if result is False:
            self._fail(OSError(f"output refused key up for {key!r}"))
            return False
        self._key_refcounts.pop(token, None)
        self._key_names.pop(token, None)
        return True

    def _move_from_right_stick(
        self,
        state: State,
        now: float,
    ) -> None:
        previous = self._last_tick
        self._last_tick = now
        if previous is None or now <= previous:
            return

        dt = min(MOUSE_MAX_DT, now - previous)
        rx = max(-32768, min(32767, int(state.rx)))
        ry = max(-32768, min(32767, int(state.ry)))
        magnitude = math.hypot(rx, ry)
        deadzone = self._mouse_deadzone
        if magnitude <= deadzone:
            return

        span = max(1.0, 32767.0 - deadzone)
        strength = min(1.0, (magnitude - deadzone) / span)
        scale = self._mouse_speed * MOUSE_FRAME_RATE * dt * strength / magnitude
        dx = int(round(rx * scale))
        # XInput's Y axis grows upward, while relative mouse movement grows down.
        dy = int(round(-ry * scale))
        if dx == 0 and dy == 0:
            return
        try:
            result = self.output.move_mouse(dx, dy)
        except Exception as exc:
            self._fail(exc)
            return
        if result is False:
            self._fail(OSError("output refused mouse movement"))

    def _panic_pressed(self) -> bool:
        method = getattr(self.output, "panic_pressed", None)
        if not callable(method):
            return False
        try:
            result = method()
        except Exception as exc:
            self._fail(exc)
            return True
        # WindowsOutput promises a bool. Requiring that type also prevents an
        # auto-created Mock attribute from looking like a permanently held F8.
        return result is True

    def _release_all(self) -> None:
        self._macro_runs.clear()

        for source in tuple(self._mapping_refs):
            token = self._mapping_refs.pop(source, None)
            if token is not None:
                self._release_token_unchecked(token)

        # Runs were cleared above, so drain all remaining references and send one
        # key-up only after every mapping owner has also been released.
        for token in tuple(self._key_refcounts):
            while self._key_refcounts.get(token, 0) > 1:
                self._key_refcounts[token] -= 1
            if self._key_refcounts.get(token, 0) == 1:
                self._release_token_unchecked(token)

        self._mapping_refs.clear()
        self._key_refcounts.clear()
        self._key_names.clear()

    def _release_token_unchecked(self, token: str) -> bool:
        count = self._key_refcounts.get(token, 0)
        if count <= 0:
            return True
        if count > 1:
            self._key_refcounts[token] = count - 1
            return True

        key = self._key_names.get(token, token)
        self._key_refcounts.pop(token, None)
        self._key_names.pop(token, None)
        try:
            result = self.output.key(key, False)
        except Exception as exc:
            self._record_error(exc)
            return False
        if result is False:
            self._record_error(OSError(f"output refused key up for {key!r}"))
            return False
        return True

    def _disarm_and_release(self) -> None:
        self._release_all()
        self._previous_active.clear()
        self._state_index = None
        self._last_tick = None
        self._armed = False

    def _fail(self, exc: Exception) -> None:
        self._record_error(exc)
        self._enabled = False
        self._disarm_and_release()

    def _record_error(self, exc: Exception) -> None:
        message = str(exc) or type(exc).__name__
        if not self.last_error:
            self.last_error = message

    @staticmethod
    def _nonnegative_number(value) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return 0.0
        if not math.isfinite(number):
            return 0.0
        return max(0.0, number)

    @staticmethod
    def _token(key: str) -> str:
        return str(key).casefold()


__all__ = ["MappingEngine"]
