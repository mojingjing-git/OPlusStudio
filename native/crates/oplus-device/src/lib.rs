//! Windows device transport and native keymap runner for ZD O+ controllers.
mod ble;
mod input;
mod lease;
mod macro_runner;

pub use ble::{Candidate, Session, scan};
pub use input::{IDENTIFY_MARKERS, Input, identify, inputs, read_pad_slot};
pub use lease::{KeymapLease, Lease, ensure_no_legacy};
#[cfg(windows)]
pub use macro_runner::encode_win32_event;
pub use macro_runner::{BlePauseGuard, MacroRunner, RunnerSnapshot};
