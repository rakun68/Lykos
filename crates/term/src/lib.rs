//! Lykos's terminal renderer (ADR-0063, rule 10).
//!
//! A frame is drawn into a [`Buffer`] of cells, diffed against the frame on screen, and the difference is
//! written in one `write` inside synchronized-output marks (DEC mode 2026), so a terminal that supports it
//! never shows half a frame. Nothing is written when nothing changed. Input and raw mode come from crossterm.
//! Inline, the frame is a footer under rows printed into the terminal's scrollback (P5 #44, mini mode).

mod buffer;
mod terminal;

pub use buffer::{Attr, Buffer, Cell, Color, Scroll, Style};
pub use terminal::{resume, suspend, Terminal, TerminalGuard};
