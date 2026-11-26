//! The client of Lykos's local engine server (P5 #35, ADR-0064 decisions 1 and 10), shared by the TUI and the
//! desktop app. The protocol is `docs/reference/engine-server.md`.
pub mod address;
pub mod client;
pub mod conn;
pub mod protocol;
pub mod store;

pub use client::{connect_or_start, try_connect_only, Client, Events, Options, Update};
pub use conn::{Conn, Error, Result};
pub use protocol::*;
pub use store::{Item, Session, Store, ToolState};
