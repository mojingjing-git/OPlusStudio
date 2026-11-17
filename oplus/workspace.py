"""UI-independent drafts for the desktop workspace."""
import copy
from . import rear, board
from .vendor import keylinker as codec


class RearWorkspace:
    def __init__(self):
        self.snapshot = None
        self.pending, self.expected, self.forms, self.errors = {}, {}, {}, {}
        self.labels, self.label_source = {}, ""

    def clear(self):
        self.pending.clear()
        self.expected.clear()
        self.forms.clear()
        self.errors.clear()

    def load(self, snapshot):
        rear.layout(snapshot)
        for slot in range(6):
            rear.validate_record(snapshot, bytes.fromhex(rear.payload_hex(snapshot, slot)))
        if self.snapshot and self.snapshot['address'] != snapshot['address']:
            self.clear()
        self.snapshot = copy.deepcopy(snapshot)
        self.labels, self.label_source = rear.resolve_labels(snapshot)

    def form(self, slot):
        if slot in self.forms and self.forms[slot]['kind'] != 'record':
            return self.forms[slot]
        raw = bytes.fromhex(self.forms[slot]['payload'] if slot in self.forms else rear.payload_hex(self.snapshot, slot))
        if raw == b'\x00':
            return {'kind':'hold', 'keys':[]}
        program = codec.parse_macro_payload(raw)
        spec = rear.layout(self.snapshot)
        if len(program.steps) == 1 and program.steps[0].duration_ms == 0 and not program.loop_interval_ms:
            keys = [int(key) for key, bit in spec.digital.items() if program.steps[0].mask & (1 << bit)]
            return {'kind':'hold', 'keys':keys}
        info = board.macro_sequence({'declared':raw[0], 'hex':raw[1:].hex()}, spec)
        return {'kind':'macro', **info}

    def edit(self, slot, change):
        self.forms[slot] = change
        try:
            payload = rear.encode_change(self.snapshot, change).hex(' ')
        except (ValueError, KeyError, TypeError) as exc:
            self.errors[slot] = str(exc)
            return False
        self.errors.pop(slot, None)
        if payload == rear.payload_hex(self.snapshot, slot):
            self.pending.pop(slot, None)
            self.expected.pop(slot, None)
        else:
            self.expected.setdefault(slot, rear.payload_hex(self.snapshot, slot))
            self.pending[slot] = change
        return True

    def conflicts(self):
        return [slot for slot in self.pending if self.expected[slot] != rear.payload_hex(self.snapshot, slot)]
