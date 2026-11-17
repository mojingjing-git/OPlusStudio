# Independent implementation review

MiniMax-M3.1-Flash reviewed the native transaction, storage, BLE, identification and IPC code. The full final response is retained in `reports/rust-implementation-review.json`.

Accepted and fixed:

- Recovery compares the full typed identity (including sensor) against both backup and current device, in addition to address and the model allowlist.
- BLE reconnection compares the full original identity before permitting rollback. Reconnection also observes the rollback's total deadline.
- Startup scans every JSON journal in the application journal directory; it no longer silently stops after 256 files. Every individual file remains bounded and backup paths and hashes are validated.

The suggestion to reject any non-target bytes during immediate rollback was not applied. A timed-out fragmented write can legitimately leave an incomplete value; refusing it would defeat restoration of the very record being changed. Immediate rollback restores all attempted records while retaining the application/device lease. Startup recovery is separate: it always reads fresh values and rejects unknown external changes. Legacy applications do not participate in the native file lock, so process checks are best effort and do not claim absolute exclusion of every third-party client.
