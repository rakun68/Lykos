//! The colours. Lykos's shipped palettes (`lykos/tui/theme/palettes.ts`, hex values checked there against
//! rose-pine/neovim and catppuccin/palette), reduced to the nine roles this TUI draws with. One is current at a
//! time: OpenCode's `theme.switch` picks it, `theme.switch_mode` moves to its light or dark pair.
use std::cell::Cell;

use lykos_term::{Buffer, Color, Style};

const fn hex(v: u32) -> Color {
    Color::Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

pub struct Palette {
    pub name: &'static str,
    /// A light palette paints the terminal's own background too, so its dark text stays readable.
    pub base: Option<Color>,
    /// The palette `theme.switch_mode` moves to.
    pub pair: &'static str,
    pub surface: Color,
    pub overlay: Color,
    pub muted: Color,
    pub subtle: Color,
    pub text: Color,
    pub love: Color,
    pub gold: Color,
    pub pine: Color,
    pub accent: Color,
}

impl Palette {
    pub fn light(&self) -> bool {
        self.base.is_some()
    }
}

/// Rose pine's roles: surface, overlay, muted, subtle, text, love, gold, pine; the accent is iris, or foam for sky.
const fn rose(name: &'static str, pair: &'static str, base: Option<Color>, r: [u32; 9]) -> Palette {
    Palette {
        name,
        base,
        pair,
        surface: hex(r[0]),
        overlay: hex(r[1]),
        muted: hex(r[2]),
        subtle: hex(r[3]),
        text: hex(r[4]),
        love: hex(r[5]),
        gold: hex(r[6]),
        pine: hex(r[7]),
        accent: hex(r[8]),
    }
}

/// Sorted by name, as OpenCode's `dialog-theme-list.tsx` lists them.
pub const PALETTES: [Palette; 6] = [
    // Catppuccin: mantle, surface0, overlay0, subtext0, text, red, yellow, blue, mauve.
    rose("catppuccin-latte", "catppuccin-mocha", Some(hex(0xeff1f5)), [0xe6e9ef, 0xccd0da, 0x9ca0b0, 0x6c6f85, 0x4c4f69, 0xd20f39, 0xdf8e1d, 0x1e66f5, 0x8839ef]),
    rose("catppuccin-mocha", "catppuccin-latte", None, [0x181825, 0x313244, 0x6c7086, 0xa6adc8, 0xcdd6f4, 0xf38ba8, 0xf9e2af, 0x89b4fa, 0xcba6f7]),
    rose("rose-pine", "rose-pine-dawn", None, [0x1f1d2e, 0x26233a, 0x6e6a86, 0x908caa, 0xe0def4, 0xeb6f92, 0xf6c177, 0x31748f, 0xc4a7e7]),
    rose("rose-pine-dawn", "rose-pine-moon", Some(hex(0xfaf4ed)), [0xfffaf3, 0xf2e9e1, 0x9893a5, 0x797593, 0x464261, 0xb4637a, 0xea9d34, 0x286983, 0x907aa9]),
    rose("rose-pine-moon", "rose-pine-dawn", None, [0x2a273f, 0x393552, 0x6e6a86, 0x908caa, 0xe0def4, 0xeb6f92, 0xf6c177, 0x3e8fb0, 0xc4a7e7]),
    rose("sky", "rose-pine-dawn", None, [0x2a273f, 0x393552, 0x6e6a86, 0x908caa, 0xe0def4, 0xeb6f92, 0xf6c177, 0x3e8fb0, 0x9ccfd8]),
];

thread_local! {
    /// Per thread, so tests that switch it run side by side; the TUI draws on one thread.
    static CURRENT: Cell<usize> = const { Cell::new(5) };
}

pub fn index(name: &str) -> Option<usize> {
    PALETTES.iter().position(|p| p.name == name)
}

/// The current palette.
pub fn c() -> &'static Palette {
    &PALETTES[CURRENT.with(Cell::get).min(PALETTES.len() - 1)]
}

/// Makes `name` current; false when there is no such palette.
pub fn set(name: &str) -> bool {
    match index(name) {
        Some(i) => {
            CURRENT.with(|c| c.set(i));
            true
        }
        None => false,
    }
}

/// A light palette's background under every cell drawn on the terminal's own.
pub fn paint_base(buf: &mut Buffer) {
    let p = c();
    let Some(base) = p.base else { return };
    for cell in &mut buf.cells {
        if cell.style.bg == Color::Reset {
            cell.style.bg = base;
        }
        if cell.style.fg == Color::Reset {
            cell.style.fg = p.text;
        }
    }
}

pub fn text() -> Style {
    Style::fg(c().text)
}

pub fn muted() -> Style {
    Style::fg(c().muted)
}

pub fn subtle() -> Style {
    Style::fg(c().subtle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pair_names_a_palette_of_the_other_mode() {
        for p in &PALETTES {
            let pair = &PALETTES[index(p.pair).expect(p.pair)];
            assert_ne!(p.light(), pair.light(), "{} pairs with {}", p.name, pair.name);
        }
        assert_eq!(c().name, "sky", "the default");
    }
}
