//! Lykos's terminal renderer (ADR-0063, rule 10).
//!
//! A frame is drawn into a [`Buffer`] of cells, diffed against the frame on screen, and the difference is
//! written in one `write` inside synchronized-output marks (DEC mode 2026), so a terminal that supports it
//! never shows half a frame. Nothing is written when nothing changed. Input and raw mode come from crossterm.

mod buffer;
mod terminal;

pub use buffer::{Attr, Buffer, Cell, Color, Style};
pub use terminal::{resume, suspend, Terminal, TerminalGuard};
