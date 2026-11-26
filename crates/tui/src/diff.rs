//! A unified patch parsed into hunks, and laid out as rows: OpenCode's `component/patch-diff.tsx` at `4332e24`
//! (opentui's diff renderable). Each hunk starts on its header in the hunk colour, then each line has a line-number
//! gutter, a sign and the text on a background for its kind. Split puts the old side left and the new side right,
//! a run of deletions beside the additions that replace it. The approval prompt and the diff viewer share it.
use lykos_term::{Buffer, Cell, Style};
use unicode_width::UnicodeWidthChar;

use crate::theme::{c, mix};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Ctx,
    Add,
    Del,
}

/// One line of a hunk, with its number in the old file and in the new (0 where it has none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub kind: Kind,
    pub old: u32,
    pub new: u32,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<Line>,
}

/// The hunks of one file's patch. What comes before the first `@@` (the `diff`, `index`, `---` and `+++` lines) and
/// `\ No newline at end of file` are skipped.
pub fn parse(patch: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let (mut old, mut new) = (0u32, 0u32);
    for raw in patch.strip_suffix('\n').unwrap_or(patch).split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix("@@ ") {
            let mut nums = rest.split(' ').take(2).map(|r| r[1..].split(',').next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(1));
            old = nums.next().unwrap_or(1);
            new = nums.next().unwrap_or(1);
            hunks.push(Hunk { header: line.to_string(), lines: Vec::new() });
            continue;
        }
        let Some(h) = hunks.last_mut() else { continue };
        let (kind, text) = match line.as_bytes().first() {
            Some(b'+') => (Kind::Add, &line[1..]),
            Some(b'-') => (Kind::Del, &line[1..]),
            Some(b' ') => (Kind::Ctx, &line[1..]),
            Some(b'\\') => continue,
            // A blank line inside a hunk is a context line whose space was trimmed.
            None => (Kind::Ctx, ""),
            Some(_) => continue,
        };
        let (o, n) = match kind {
            Kind::Ctx => (old, new),
            Kind::Add => (0, new),
            Kind::Del => (old, 0),
        };
        h.lines.push(Line { kind, old: o, new: n, text: text.replace('\t', "    ") });
        old += u32::from(kind != Kind::Add);
        new += u32::from(kind != Kind::Del);
    }
    hunks
}

/// One side of a row: its kind, its line number (0 on a wrapped line's continuation) and the text shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Half {
    pub kind: Kind,
    pub no: u32,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    /// A hunk's header.
    Header(String),
    Unified(Half),
    /// The old side and the new; `None` where the other side has more lines.
    Split(Option<Half>, Option<Half>),
}

/// The laid-out rows of a patch, the first row of each hunk, and the gutter's digits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Layout {
    pub rows: Vec<Row>,
    pub hunks: Vec<usize>,
    pub digits: usize,
}

/// The gutter: a column of padding, the number, a space; then the sign and a space.
fn gutter(digits: usize) -> usize {
    digits + 4
}

/// Splits `text` into pieces at most `width` columns wide, or keeps only the first when not wrapping.
fn pieces(text: &str, width: usize, wrap: bool) -> Vec<String> {
    let width = width.max(1);
    let mut out = vec![String::new()];
    let mut w = 0;
    for ch in text.chars() {
        let cw = ch.width().unwrap_or(0);
        if w + cw > width {
            if !wrap {
                break;
            }
            out.push(String::new());
            w = 0;
        }
        out.last_mut().map(|s| s.push(ch));
        w += cw;
    }
    out
}

fn halves(line: &Line, width: usize, wrap: bool) -> Vec<Half> {
    let no = if line.kind == Kind::Del { line.old } else { line.new };
    pieces(&line.text, width, wrap).into_iter().enumerate().map(|(i, text)| Half { kind: line.kind, no: if i == 0 { no } else { 0 }, text }).collect()
}

/// Lays out `hunks` `width` columns wide, unified or split, wrapping long lines or cutting them.
pub fn layout(hunks: &[Hunk], width: usize, split: bool, wrap: bool) -> Layout {
    let max = hunks.iter().flat_map(|h| &h.lines).map(|l| l.old.max(l.new)).max().unwrap_or(1);
    let digits = max.max(1).to_string().len();
    let mut out = Layout { digits, ..Layout::default() };
    for h in hunks {
        out.hunks.push(out.rows.len());
        out.rows.push(Row::Header(h.header.clone()));
        if !split {
            let text_w = width.saturating_sub(gutter(digits));
            for l in &h.lines {
                out.rows.extend(halves(l, text_w, wrap).into_iter().map(Row::Unified));
            }
            continue;
        }
        let side_w = width.saturating_sub(1) / 2;
        let text_w = side_w.saturating_sub(gutter(digits));
        let mut i = 0;
        while i < h.lines.len() {
            if h.lines[i].kind == Kind::Ctx {
                let l = &h.lines[i];
                let old = halves(&Line { kind: Kind::Ctx, new: l.old, ..l.clone() }, text_w, wrap);
                let new = halves(l, text_w, wrap);
                out.rows.extend(old.into_iter().zip(new).map(|(a, b)| Row::Split(Some(a), Some(b))));
                i += 1;
                continue;
            }
            // A change: the deletions, then the additions that follow them, side by side.
            let dels: Vec<Half> = h.lines[i..].iter().take_while(|l| l.kind == Kind::Del).flat_map(|l| halves(l, text_w, wrap)).collect();
            let nd = h.lines[i..].iter().take_while(|l| l.kind == Kind::Del).count();
            let adds: Vec<Half> = h.lines[i + nd..].iter().take_while(|l| l.kind == Kind::Add).flat_map(|l| halves(l, text_w, wrap)).collect();
            let na = h.lines[i + nd..].iter().take_while(|l| l.kind == Kind::Add).count();
            let n = dels.len().max(adds.len());
            let (mut d, mut a) = (dels.into_iter(), adds.into_iter());
            for _ in 0..n {
                out.rows.push(Row::Split(d.next(), a.next()));
            }
            i += nd + na;
        }
    }
    out
}

/// The background of a line of `kind`, and of its gutter.
pub fn background(kind: Kind) -> (Style, Style) {
    let p = c();
    match kind {
        Kind::Ctx => (Style::default().on(p.surface), Style::fg(p.muted).on(p.surface)),
        Kind::Add => (Style::default().on(mix(p.surface, p.pine, 0.22)), Style::fg(p.subtle).on(mix(p.surface, p.pine, 0.38))),
        Kind::Del => (Style::default().on(mix(p.surface, p.love, 0.22)), Style::fg(p.subtle).on(mix(p.surface, p.love, 0.38))),
    }
}

fn paint_half(buf: &mut Buffer, x: u16, y: u16, width: u16, digits: usize, half: Option<&Half>) {
    let kind = half.map_or(Kind::Ctx, |h| h.kind);
    let (bg, gutter_bg) = background(kind);
    let g = (gutter(digits) as u16).min(width);
    // Each cell once: the gutter, then the text's background (a frame paints every row it shows).
    buf.fill(x, y, g, 1, gutter_bg);
    buf.fill(x + g, y, width - g, 1, bg);
    let Some(h) = half else { return };
    if h.no > 0 {
        // The number right-aligned in `digits` columns, without a string.
        let (mut n, mut col) = (h.no, x + digits as u16);
        while n > 0 && col > x {
            buf.set(col, y, Cell { ch: char::from(b'0' + (n % 10) as u8), style: gutter_bg });
            n /= 10;
            col -= 1;
        }
    }
    let (sign, fg) = match kind {
        Kind::Add => ('+', c().pine),
        Kind::Del => ('-', c().love),
        Kind::Ctx => (' ', c().muted),
    };
    if h.no > 0 && g + 1 < width {
        buf.set(x + g - 2, y, Cell { ch: sign, style: Style::fg(fg).on(gutter_bg.bg) });
    }
    if g < width {
        buf.text(x + g, y, width - g, &h.text, Style::fg(c().text).on(bg.bg));
    }
}

/// Draws one row `width` columns wide at `x`, `y`.
pub fn paint(buf: &mut Buffer, x: u16, y: u16, width: u16, digits: usize, row: &Row) {
    match row {
        Row::Header(h) => {
            buf.fill(x, y, width, 1, Style::default().on(c().surface));
            buf.text(x + 1, y, width.saturating_sub(1), h, Style::fg(c().accent).on(c().surface));
        }
        Row::Unified(h) => paint_half(buf, x, y, width, digits, Some(h)),
        Row::Split(a, b) => {
            let side = width.saturating_sub(1) / 2;
            paint_half(buf, x, y, side, digits, a.as_ref());
            buf.fill(x + side, y, width - 2 * side, 1, Style::default().on(c().surface));
            paint_half(buf, x + width - side, y, side, digits, b.as_ref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -10,2 +10,3 @@ fn f\n ten\n+new\n eleven\n\\ No newline at end of file\n";

    #[test]
    fn a_patch_parses_into_numbered_hunks() {
        let h = parse(PATCH);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].lines.iter().map(|l| (l.kind, l.old, l.new)).collect::<Vec<_>>(), [(Kind::Ctx, 1, 1), (Kind::Del, 2, 0), (Kind::Add, 0, 2), (Kind::Ctx, 3, 3)]);
        assert_eq!(h[1].header, "@@ -10,2 +10,3 @@ fn f");
        assert_eq!(h[1].lines.iter().map(|l| l.new).collect::<Vec<_>>(), [10, 11, 12]);
    }

    #[test]
    fn unified_wraps_or_cuts_and_split_pairs_a_change() {
        let h = parse("@@ -1,1 +1,1 @@\n-abcdefghij\n+ABCDEFGHIJ\n");
        let lay = layout(&h, 10, false, true);
        assert_eq!(lay.rows.len(), 1 + 2 + 2, "the header, then each 10-column line in two 5-column pieces");
        assert_eq!(lay.rows[2], Row::Unified(Half { kind: Kind::Del, no: 0, text: "fghij".into() }));
        assert_eq!(layout(&h, 10, false, false).rows.len(), 3, "cut, not wrapped");
        let split = layout(&parse(PATCH), 40, true, true);
        assert_eq!(split.hunks, [0, 4]);
        assert_eq!(split.rows[2], Row::Split(Some(Half { kind: Kind::Del, no: 2, text: "two".into() }), Some(Half { kind: Kind::Add, no: 2, text: "TWO".into() })));
        assert_eq!(split.rows[6], Row::Split(None, Some(Half { kind: Kind::Add, no: 11, text: "new".into() })));
    }
}
