use unicode_width::UnicodeWidthChar;

/// A colour: the terminal's default, one of the 256 indexed colours, or 24-bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Reset,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Text attributes, as bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Attr(pub u8);

impl Attr {
    pub const NONE: Attr = Attr(0);
    pub const BOLD: Attr = Attr(1);
    pub const DIM: Attr = Attr(2);
    pub const ITALIC: Attr = Attr(4);
    pub const UNDERLINE: Attr = Attr(8);
    pub const REVERSE: Attr = Attr(16);
    pub const STRIKE: Attr = Attr(32);

    pub const fn with(self, other: Attr) -> Attr {
        Attr(self.0 | other.0)
    }

    pub const fn has(self, other: Attr) -> bool {
        self.0 & other.0 == other.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub attr: Attr,
}

impl Style {
    pub const fn fg(fg: Color) -> Style {
        Style { fg, bg: Color::Reset, attr: Attr::NONE }
    }

    pub const fn bold(self) -> Style {
        Style { attr: self.attr.with(Attr::BOLD), ..self }
    }

    pub const fn dim(self) -> Style {
        Style { attr: self.attr.with(Attr::DIM), ..self }
    }

    pub const fn on(self, bg: Color) -> Style {
        Style { bg, ..self }
    }
}

/// One screen cell. `ch == '\0'` marks the right half of a wide character, which the terminal draws itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub style: Style,
}

impl Default for Cell {
    fn default() -> Self {
        Cell { ch: ' ', style: Style::default() }
    }
}

/// A frame: `width * height` cells, row by row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Buffer {
    pub width: u16,
    pub height: u16,
    pub cells: Vec<Cell>,
    /// A hint from the painter: rows `top..top + rows` show what the frame before showed `by` rows lower (up when
    /// positive). The terminal scrolls them in place and writes only what then differs.
    pub scroll: Option<Scroll>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scroll {
    pub top: u16,
    pub rows: u16,
    pub by: i32,
}

impl Buffer {
    pub fn new(width: u16, height: u16) -> Buffer {
        Buffer { width, height, cells: vec![Cell::default(); width as usize * height as usize], scroll: None }
    }

    pub fn clear(&mut self) {
        self.cells.fill(Cell::default());
        self.scroll = None;
    }

    #[inline]
    fn index(&self, x: u16, y: u16) -> usize {
        y as usize * self.width as usize + x as usize
    }

    pub fn get(&self, x: u16, y: u16) -> &Cell {
        &self.cells[self.index(x, y)]
    }

    pub fn set(&mut self, x: u16, y: u16, cell: Cell) {
        if x < self.width && y < self.height {
            let i = self.index(x, y);
            self.cells[i] = cell;
        }
    }

    /// Fill a rectangle's background with `style`.
    pub fn fill(&mut self, x: u16, y: u16, w: u16, h: u16, style: Style) {
        for row in y..y.saturating_add(h).min(self.height) {
            for col in x..x.saturating_add(w).min(self.width) {
                self.set(col, row, Cell { ch: ' ', style });
            }
        }
    }

    /// Write `text` from `(x, y)`, clipped at `x + max` columns. Returns the column after the last cell written.
    /// Control characters are skipped; a wide character that would not fit is not drawn.
    pub fn text(&mut self, x: u16, y: u16, max: u16, text: &str, style: Style) -> u16 {
        if y >= self.height {
            return x;
        }
        let end = x.saturating_add(max).min(self.width);
        let mut col = x;
        for ch in text.chars() {
            let w = match ch.width() {
                Some(w) if w > 0 => w as u16,
                _ => continue,
            };
            if col + w > end {
                break;
            }
            self.set(col, y, Cell { ch, style });
            if w == 2 {
                self.set(col + 1, y, Cell { ch: '\0', style });
            }
            col += w;
        }
        col
    }

    /// A box border with rounded corners.
    pub fn border(&mut self, x: u16, y: u16, w: u16, h: u16, style: Style) {
        if w < 2 || h < 2 {
            return;
        }
        let (r, b) = (x + w - 1, y + h - 1);
        for col in x + 1..r {
            self.set(col, y, Cell { ch: '─', style });
            self.set(col, b, Cell { ch: '─', style });
        }
        for row in y + 1..b {
            self.set(x, row, Cell { ch: '│', style });
            self.set(r, row, Cell { ch: '│', style });
        }
        self.set(x, y, Cell { ch: '╭', style });
        self.set(r, y, Cell { ch: '╮', style });
        self.set(x, b, Cell { ch: '╰', style });
        self.set(r, b, Cell { ch: '╯', style });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_characters_take_two_cells_and_are_clipped_whole() {
        let mut b = Buffer::new(5, 1);
        let end = b.text(0, 0, 5, "a漢字", Style::default());
        assert_eq!(end, 5);
        assert_eq!(b.get(1, 0).ch, '漢');
        assert_eq!(b.get(2, 0).ch, '\0');
        let mut c = Buffer::new(4, 1);
        assert_eq!(c.text(0, 0, 4, "a漢字", Style::default()), 3);
        assert_eq!(c.get(3, 0).ch, ' ');
    }
}
