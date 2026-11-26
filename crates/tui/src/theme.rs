//! The colours. Lykos's shipped palettes (`lykos/tui/theme/palettes.ts`, hex values checked there against
//! rose-pine/neovim and catppuccin/palette; gruvbox from morhetz/gruvbox), reduced to the roles this TUI draws with. One is current at a
//! time: OpenCode's `theme.switch` picks it, `theme.switch_mode` moves to its light or dark pair. `tui.colors` in a
//! config layer sets any role over every palette (#58 item 9); the palette in effect is resolved once, when either
//! changes, so a frame reads a pointer and never a lookup.
use std::cell::{Cell, RefCell};

use lykos_term::{Buffer, Color, Style};

const fn hex(v: u32) -> Color {
    Color::Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

#[derive(Clone, Copy, Debug)]
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
    /// Selected text's background: the accent part way into the surface, so it stands apart from both.
    pub selection: Color,
    /// A key binding beside its action's name (#58 item 12).
    pub keybind: Color,
}

/// The roles `tui.colors` sets, by the name it uses.
pub const ROLES: [&str; 12] = ["background", "surface", "overlay", "muted", "subtle", "text", "error", "warning", "success", "accent", "selection", "keybind"];

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
        // Filled in by `resolve`: they follow the accent.
        selection: Color::Reset,
        keybind: Color::Reset,
    }
}

/// Sorted by name, as OpenCode's `dialog-theme-list.tsx` lists them.
pub const PALETTES: [Palette; 8] = [
    // Catppuccin: mantle, surface0, overlay0, subtext0, text, red, yellow, blue, mauve.
    rose("catppuccin-latte", "catppuccin-mocha", Some(hex(0xeff1f5)), [0xe6e9ef, 0xccd0da, 0x9ca0b0, 0x6c6f85, 0x4c4f69, 0xd20f39, 0xdf8e1d, 0x1e66f5, 0x8839ef]),
    rose("catppuccin-mocha", "catppuccin-latte", None, [0x181825, 0x313244, 0x6c7086, 0xa6adc8, 0xcdd6f4, 0xf38ba8, 0xf9e2af, 0x89b4fa, 0xcba6f7]),
    // Gruvbox: bg0_h, bg1, gray, fg4, fg1, red, yellow, blue, orange; light: bg0_s, bg2 and the faded colours.
    rose("gruvbox-dark", "gruvbox-light", None, [0x1d2021, 0x3c3836, 0x928374, 0xa89984, 0xebdbb2, 0xfb4934, 0xfabd2f, 0x83a598, 0xfe8019]),
    rose("gruvbox-light", "gruvbox-dark", Some(hex(0xfbf1c7)), [0xf2e5bc, 0xd5c4a1, 0x928374, 0x7c6f64, 0x3c3836, 0x9d0006, 0xb57614, 0x076678, 0xaf3a03]),
    rose("rose-pine", "rose-pine-dawn", None, [0x1f1d2e, 0x26233a, 0x6e6a86, 0x908caa, 0xe0def4, 0xeb6f92, 0xf6c177, 0x31748f, 0xc4a7e7]),
    rose("rose-pine-dawn", "rose-pine-moon", Some(hex(0xfaf4ed)), [0xfffaf3, 0xf2e9e1, 0x9893a5, 0x797593, 0x464261, 0xb4637a, 0xea9d34, 0x286983, 0x907aa9]),
    rose("rose-pine-moon", "rose-pine-dawn", None, [0x2a273f, 0x393552, 0x6e6a86, 0x908caa, 0xe0def4, 0xeb6f92, 0xf6c177, 0x3e8fb0, 0xc4a7e7]),
    rose("sky", "rose-pine-dawn", None, [0x2a273f, 0x393552, 0x6e6a86, 0x908caa, 0xe0def4, 0xeb6f92, 0xf6c177, 0x3e8fb0, 0x9ccfd8]),
];

thread_local! {
    /// Per thread, so tests that switch it run side by side; the TUI draws on one thread.
    static CURRENT: Cell<usize> = const { Cell::new(7) };
    static OVERRIDES: RefCell<Vec<(usize, Color)>> = const { RefCell::new(Vec::new()) };
    /// Leaked once per theme or colour change (a few a session), so `c()` hands out a reference and copies nothing.
    static RESOLVED: Cell<Option<&'static Palette>> = const { Cell::new(None) };
    static VERSION: Cell<u32> = const { Cell::new(0) };
}

pub fn index(name: &str) -> Option<usize> {
    PALETTES.iter().position(|p| p.name == name)
}

/// The palette in effect: the current one with `tui.colors` over it.
pub fn c() -> &'static Palette {
    if let Some(p) = RESOLVED.with(Cell::get) {
        return p;
    }
    let p: &'static Palette = Box::leak(Box::new(resolve()));
    RESOLVED.with(|r| r.set(Some(p)));
    p
}

fn resolve() -> Palette {
    let mut p = PALETTES[CURRENT.with(Cell::get).min(PALETTES.len() - 1)];
    p.selection = mix(p.surface, p.accent, 0.45);
    p.keybind = p.gold;
    OVERRIDES.with(|o| {
        for (role, color) in o.borrow().iter() {
            let c = *color;
            match *role {
                0 => p.base = Some(c),
                1 => p.surface = c,
                2 => p.overlay = c,
                3 => p.muted = c,
                4 => p.subtle = c,
                5 => p.text = c,
                6 => p.love = c,
                7 => p.gold = c,
                8 => p.pine = c,
                9 => p.accent = c,
                10 => p.selection = c,
                _ => p.keybind = c,
            }
        }
    });
    p
}

fn changed() {
    RESOLVED.with(|r| r.set(None));
    VERSION.with(|v| v.set(v.get().wrapping_add(1)));
}

/// Changes with every theme switch or colour change: what a cache of drawn rows keys on.
pub fn version() -> u32 {
    VERSION.with(Cell::get)
}

/// Makes `name` current; false when there is no such palette.
pub fn set(name: &str) -> bool {
    match index(name) {
        Some(i) => {
            CURRENT.with(|c| c.set(i));
            changed();
            true
        }
        None => false,
    }
}

/// `#rrggbb` (or `rrggbb`, `#rgb`) as a colour.
pub fn parse(text: &str) -> Option<Color> {
    let h = text.trim().trim_start_matches('#');
    let v = u32::from_str_radix(h, 16).ok()?;
    match h.len() {
        6 => Some(hex(v)),
        3 => Some(Color::Rgb(((v >> 8) & 0xf) as u8 * 17, ((v >> 4) & 0xf) as u8 * 17, (v & 0xf) as u8 * 17)),
        _ => None,
    }
}

/// `tui.colors`: each role a config layer sets, over every palette. Returns what could not be read.
pub fn set_colors(colors: &serde_json::Value) -> Vec<String> {
    let mut set = Vec::new();
    let mut problems = Vec::new();
    if let Some(map) = colors.as_object() {
        for (name, v) in map {
            // `config.keybinds` answers each as `{ value, source }`; a bare string is accepted too.
            let value = v.get("value").unwrap_or(v).as_str().unwrap_or_default();
            match (ROLES.iter().position(|r| r == name), parse(value)) {
                (Some(role), Some(color)) => set.push((role, color)),
                (None, _) => problems.push(format!("tui.colors.{name}: not a colour role ({})", ROLES.join(", "))),
                (_, None) => problems.push(format!("tui.colors.{name}: {value:?} is not #rrggbb")),
            }
        }
    }
    OVERRIDES.with(|o| *o.borrow_mut() = set);
    changed();
    problems
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

/// The screen behind an overlay, darker (OpenCode's `RGBA.fromInts(0, 0, 0, 70)` backdrop): what a dialog and the
/// sidebar drawn over the session sit on.
pub fn dim(buf: &mut Buffer) {
    let darker = |col: Color| match col {
        Color::Rgb(..) => mix(col, Color::Rgb(0, 0, 0), 0.45),
        other => other,
    };
    for cell in buf.cells.iter_mut() {
        cell.style = Style { fg: darker(cell.style.fg), bg: darker(cell.style.bg), attr: cell.style.attr.with(lykos_term::Attr::DIM) };
    }
}

/// `a` moved toward `b` by `t` (0 to 1); a colour that is not RGB gives `b`.
pub fn mix(a: Color, b: Color, t: f32) -> Color {
    match (a, b) {
        (Color::Rgb(r0, g0, b0), Color::Rgb(r1, g1, b1)) => {
            let m = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round() as u8;
            Color::Rgb(m(r0, r1), m(g0, g1), m(b0, b1))
        }
        _ => b,
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

    #[test]
    fn a_configured_colour_sets_its_role_over_every_palette_and_a_bad_one_is_named() {
        let before = version();
        let problems = set_colors(&serde_json::json!({ "accent": { "value": "#ff0000", "source": "global" }, "keybind": "0f0", "nope": "#000000", "text": "red" }));
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert_eq!(c().accent, Color::Rgb(255, 0, 0));
        assert_eq!(c().keybind, Color::Rgb(0, 255, 0));
        assert_ne!(version(), before, "drawn rows are drawn again");
        set("rose-pine");
        assert_eq!(c().accent, Color::Rgb(255, 0, 0), "a theme switch keeps it");
        set_colors(&serde_json::Value::Null);
        set("sky");
        assert_eq!(c().accent, hex(0x9ccfd8));
    }
}
