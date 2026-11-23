//! Text into rows of a given display width: at spaces where it can, mid-word where a word is wider than the row.
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// The rows `text` takes at `width` columns. Every `\n` starts a row; an empty text is one empty row.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.width() <= width {
            rows.push(line.to_string());
            continue;
        }
        let mut row = String::new();
        let mut used = 0;
        for word in split_keep_spaces(line) {
            let w = word.width();
            if used + w <= width {
                row.push_str(word);
                used += w;
                continue;
            }
            if word.trim().is_empty() {
                // A space at the end of a row is dropped, never carried to the next.
                rows.push(std::mem::take(&mut row));
                used = 0;
                continue;
            }
            if used > 0 && w <= width {
                rows.push(std::mem::take(&mut row).trim_end().to_string());
                row.push_str(word);
                used = w;
                continue;
            }
            for ch in word.chars() {
                let cw = ch.width().unwrap_or(0);
                if used + cw > width {
                    rows.push(std::mem::take(&mut row));
                    used = 0;
                }
                row.push(ch);
                used += cw;
            }
        }
        rows.push(row);
    }
    rows
}

/// Words and the runs of spaces between them, in order.
fn split_keep_spaces(line: &str) -> impl Iterator<Item = &str> {
    let mut rest = line;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let space = rest.starts_with(' ');
        let end = rest.find(|c: char| (c == ' ') != space).unwrap_or(rest.len());
        let (head, tail) = rest.split_at(end);
        rest = tail;
        Some(head)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_at_spaces_and_breaks_long_words() {
        assert_eq!(wrap("hello world", 5), vec!["hello", "world"]);
        assert_eq!(wrap("abcdefgh", 3), vec!["abc", "def", "gh"]);
        assert_eq!(wrap("a\n\nb", 10), vec!["a", "", "b"]);
        assert_eq!(wrap("", 10), vec![""]);
    }

    #[test]
    fn counts_wide_characters_as_two() {
        assert_eq!(wrap("漢字漢字", 4), vec!["漢字", "漢字"]);
    }
}
