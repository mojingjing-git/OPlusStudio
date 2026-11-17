//! Model-scoped KeyLinker configuration and native keymap engine. GPL-3.0-or-later.
//! Framing and layout informed by x20ctl (see repository NOTICE.md).
pub mod keymap;
pub mod model;
pub mod protocol;
pub mod storage;
pub mod transaction;
pub type Result<T> = std::result::Result<T, String>;
