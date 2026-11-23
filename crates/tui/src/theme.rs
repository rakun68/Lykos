//! The colours. Lykos's `sky` palette (`lykos/tui/theme/palettes.ts`: rose-pine moon, accent foam); themes are #41.
use lykos_term::{Color, Style};

const fn hex(v: u32) -> Color {
    Color::Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

pub const SURFACE: Color = hex(0x2a273f);
pub const OVERLAY: Color = hex(0x393552);
pub const MUTED: Color = hex(0x6e6a86);
pub const SUBTLE: Color = hex(0x908caa);
pub const TEXT: Color = hex(0xe0def4);
pub const LOVE: Color = hex(0xeb6f92);
pub const GOLD: Color = hex(0xf6c177);
pub const PINE: Color = hex(0x3e8fb0);
pub const ACCENT: Color = hex(0x9ccfd8);

pub fn text() -> Style {
    Style::fg(TEXT)
}

pub fn muted() -> Style {
    Style::fg(MUTED)
}

pub fn subtle() -> Style {
    Style::fg(SUBTLE)
}
