"""Generate portable Rust goldens from the verified Python reference."""
import json
from pathlib import Path
from oplus import rear, board

root = Path(__file__).resolve().parents[2]
snapshot = json.loads((root/'reports/desktop-0.4.0-final-restored.json').read_text('utf-8'))
snapshot['address'] = 'AA:BB:CC:DD:EE:FF'
snapshot.pop('trace', None)
(root/'native/fixtures/snapshot.json').write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), 'utf-8')
changes = [{'kind':'hold','keys':[k]} for k in snapshot['decoded']['remap_keys']]
changes += [{'kind':'hold','keys':[1,2,5]}, {'kind':'hold','keys':[93,94]}]
for sequence in ['A:100/60, B:80/0', 'LS_UP+RT:100/0, RS_DOWN_LEFT:200/100', 'DPAD_DOWN:120/0', 'LB+RB:50/50, X:50/50']:
    for trigger in [0,1]:
        for loop in [0,100,20000]:
            changes.append(dict(kind='macro',sequence=sequence,trigger=trigger,loop_ms=loop))
goldens = [dict(change=c,payload=rear.encode_change(snapshot,c).hex()) for c in changes]
(root/'native/fixtures/macros.json').write_text(json.dumps(goldens,indent=2),'utf-8')
print(f'{len(goldens)} macro goldens generated')
