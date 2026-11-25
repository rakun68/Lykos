//! An answer's markdown drawn in the terminal, as OpenCode draws it: headings, emphasis, strikes, highlights, inline
//! code, links (a click opens them), lists, quotes, rules, tables, code blocks with their syntax coloured, the inline
//! HTML a model writes, and LaTeX: a formula keeps its background and loses its `$`, and what has a character of its
//! own (`\pi`, `\leq`, `x^2`) is drawn as that character.
use lykos_term::{Attr, Color, Style};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::theme::{c, mix};

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Span {
    pub text: String,
    pub style: Style,
    /// Where a click on it goes.
    pub link: Option<String>,
}

impl Span {
    fn new(text: impl Into<String>, style: Style) -> Span {
        Span { text: text.into(), style, link: None }
    }
}

/// The styles of one frame's palette.
struct Look {
    text: Style,
    bold: Style,
    code: Style,
    code_bg: Color,
    mark: Style,
    link: Style,
    math: Style,
    quote: Style,
    rule: Style,
    bullet: Style,
}

fn rgb(a: Color, b: Color) -> bool {
    matches!((a, b), (Color::Rgb(..), Color::Rgb(..)))
}

fn look() -> Look {
    let p = c();
    let text = Style::fg(p.text);
    let mark = if rgb(p.surface, p.gold) { Style::fg(p.text).on(mix(p.surface, p.gold, 0.32)) } else { Style::fg(p.surface).on(p.gold) };
    let math_bg = if rgb(p.surface, p.accent) { mix(p.surface, p.accent, 0.16) } else { p.surface };
    let math_fg = if rgb(p.text, p.accent) { mix(p.text, p.accent, 0.45) } else { p.accent };
    Look {
        text,
        bold: Style::fg(if rgb(p.text, p.gold) { mix(p.text, p.gold, 0.4) } else { p.text }).bold(),
        code: Style::fg(p.pine).on(p.surface),
        code_bg: p.surface,
        mark,
        link: Style { fg: p.accent, bg: Color::Reset, attr: Attr::UNDERLINE },
        math: Style::fg(math_fg).on(math_bg),
        quote: Style { fg: p.subtle, bg: Color::Reset, attr: Attr::ITALIC },
        rule: Style::fg(p.overlay),
        bullet: Style::fg(p.accent),
    }
}

fn heading(level: usize) -> Style {
    let p = c();
    let fg = match level {
        1 => p.accent,
        2 => p.pine,
        3 => p.gold,
        4 => p.love,
        _ => p.subtle,
    };
    let s = Style::fg(fg).bold();
    if level == 1 {
        Style { attr: s.attr.with(Attr::UNDERLINE), ..s }
    } else {
        s
    }
}

fn with(s: Style, attr: Attr) -> Style {
    Style { attr: s.attr.with(attr), ..s }
}

/// `text`'s rows at `width` columns.
pub fn render(text: &str, width: usize) -> Vec<Vec<Span>> {
    let width = width.max(8);
    let l = look();
    let text = text.replace("\r\n", "\n").replace('\t', "    ");
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<Vec<Span>> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim_start();
        let lead = line.len() - t.len();
        // A fenced code block, to its closing fence or the end (a block still streaming).
        if let Some((fence, lang)) = fence_open(t) {
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() {
                let u = lines[i].trim();
                if u.starts_with(&fence) && u.chars().all(|ch| fence.starts_with(ch)) {
                    i += 1;
                    break;
                }
                body.push(strip_lead(lines[i], lead));
                i += 1;
            }
            code_block(&body, &lang, width, &l, &mut out);
            continue;
        }
        // Display math: `$$ … $$` or `\[ … \]`, on one line or several.
        if let Some(close) = if t.starts_with("$$") { Some("$$") } else if t.starts_with("\\[") { Some("\\]") } else { None } {
            let after = &t[2..];
            let mut body = String::new();
            if let Some(end) = after.find(close) {
                body.push_str(&after[..end]);
                i += 1;
            } else {
                body.push_str(after);
                i += 1;
                while i < lines.len() {
                    if let Some(end) = lines[i].find(close) {
                        body.push('\n');
                        body.push_str(&lines[i][..end]);
                        i += 1;
                        break;
                    }
                    body.push('\n');
                    body.push_str(lines[i]);
                    i += 1;
                }
            }
            math_block(&body, width, &l, &mut out);
            continue;
        }
        // A table: a row of cells, then a row of dashes.
        if t.contains('|') && lines.get(i + 1).is_some_and(|n| is_table_rule(n)) {
            let mut rows = vec![cells(t)];
            let aligns: Vec<Align> = cells(lines[i + 1].trim()).iter().map(|c| align_of(c)).collect();
            i += 2;
            while i < lines.len() && lines[i].contains('|') && !lines[i].trim().is_empty() {
                rows.push(cells(lines[i].trim()));
                i += 1;
            }
            table(&rows, &aligns, width, &l, &mut out);
            continue;
        }
        i += 1;
        if t.is_empty() {
            out.push(Vec::new());
            continue;
        }
        block_line(line, width, &l, &mut out);
    }
    out
}

/// One line that is not part of a code block, a formula or a table.
fn block_line(line: &str, width: usize, l: &Look, out: &mut Vec<Vec<Span>>) {
    let t = line.trim_start();
    let lead = line.len() - t.len();
    if let Some((level, rest)) = atx_heading(t) {
        let mut spans = Vec::new();
        inline(rest, heading(level), &mut spans);
        wrap_into(out, Vec::new(), Vec::new(), spans, width);
        return;
    }
    if is_rule(t) {
        out.push(vec![Span::new("─".repeat(width), l.rule)]);
        return;
    }
    // Lines that are only an HTML block's tags (`<p>`, `</div>`, `<details>`): nothing to draw.
    if is_block_tag(t) {
        return;
    }
    if let Some(level) = html_heading(t) {
        let mut spans = Vec::new();
        inline(t, heading(level), &mut spans);
        wrap_into(out, Vec::new(), Vec::new(), spans, width);
        return;
    }
    if let Some(rest) = t.strip_prefix('>') {
        // A quote, `>` a level: a bar a level, its text in italics. GitHub's `[!NOTE]` is a label.
        let mut depth = 1;
        let mut rest = rest.trim_start();
        while let Some(r) = rest.strip_prefix('>') {
            depth += 1;
            rest = r.trim_start();
        }
        let bar = || (0..depth).map(|_| Span::new("▎ ", Style::fg(c().overlay))).collect::<Vec<_>>();
        let mut spans = Vec::new();
        if let Some((label, color)) = alert(rest) {
            spans.push(Span::new(label, Style::fg(color).bold()));
        } else if let Some((level, h)) = atx_heading(rest) {
            inline(h, heading(level), &mut spans);
        } else {
            inline(rest, l.quote, &mut spans);
        }
        wrap_into(out, bar(), bar(), spans, width);
        return;
    }
    if let Some((marker, rest)) = list_item(t) {
        let depth = lead / 2;
        let mut head = vec![Span::new(" ".repeat(lead), l.text)];
        let mut body = rest;
        let mut text_style = l.text;
        if marker.ends_with('.') || marker.ends_with(')') {
            head.push(Span::new(format!("{marker} "), l.bullet));
        } else {
            head.push(Span::new(format!("{} ", ["•", "◦", "▪"][depth % 3]), l.bullet));
        }
        if let Some(r) = rest.strip_prefix("[ ] ") {
            head.push(Span::new("☐ ", Style::fg(c().muted)));
            body = r;
        } else if let Some(r) = rest.strip_prefix("[x] ").or_else(|| rest.strip_prefix("[X] ")) {
            head.push(Span::new("☑ ", Style::fg(c().pine)));
            body = r;
            text_style = with(Style::fg(c().muted), Attr::STRIKE);
        }
        let w = head.iter().map(|s| s.text.width()).sum();
        let mut spans = Vec::new();
        inline(body, text_style, &mut spans);
        wrap_into(out, head, vec![Span::new(" ".repeat(w), l.text)], spans, width);
        return;
    }
    if let Some(rest) = strip_tag(t, "li") {
        let mut spans = Vec::new();
        inline(rest, l.text, &mut spans);
        wrap_into(out, vec![Span::new("• ", l.bullet)], vec![Span::new("  ", l.text)], spans, width);
        return;
    }
    if let Some(rest) = strip_tag(t, "summary") {
        let mut spans = Vec::new();
        inline(rest, l.text.bold(), &mut spans);
        wrap_into(out, vec![Span::new("▸ ", l.bullet)], vec![Span::new("  ", l.text)], spans, width);
        return;
    }
    // A paragraph's line; `<br>` breaks it.
    for (k, part) in split_br(line).into_iter().enumerate() {
        if k > 0 && part.trim().is_empty() {
            continue;
        }
        let mut spans = Vec::new();
        inline(part, l.text, &mut spans);
        wrap_into(out, Vec::new(), Vec::new(), spans, width);
    }
}

fn fence_open(t: &str) -> Option<(String, String)> {
    let ch = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = t.chars().take_while(|c| *c == ch).count();
    if n < 3 {
        return None;
    }
    let rest = &t[n..];
    if ch == '`' && rest.contains('`') {
        return None;
    }
    let lang = rest.split_whitespace().next().unwrap_or("").trim_start_matches('{').trim_start_matches('.').to_ascii_lowercase();
    Some((ch.to_string().repeat(n), lang))
}

fn strip_lead(line: &str, lead: usize) -> &str {
    let spaces = line.len() - line.trim_start_matches(' ').len();
    &line[spaces.min(lead)..]
}

fn atx_heading(t: &str) -> Option<(usize, &str)> {
    let n = t.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&n) {
        return None;
    }
    let rest = &t[n..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    let rest = rest.trim();
    let rest = rest.trim_end_matches('#').trim_end();
    Some((n, rest))
}

fn is_rule(t: &str) -> bool {
    let t = t.trim_end();
    ['-', '*', '_'].iter().any(|m| t.chars().filter(|c| c == m).count() >= 3 && t.chars().all(|c| c == *m || c == ' '))
        || matches!(t.to_ascii_lowercase().as_str(), "<hr>" | "<hr/>" | "<hr />")
}

fn list_item(t: &str) -> Option<(&str, &str)> {
    for m in ["- ", "* ", "+ "] {
        if let Some(rest) = t.strip_prefix(m) {
            return Some((&t[..1], rest));
        }
    }
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if (1..=9).contains(&digits) {
        let after = &t[digits..];
        if after.starts_with(". ") || after.starts_with(") ") {
            return Some((&t[..digits + 1], &after[2..]));
        }
    }
    None
}

fn alert(rest: &str) -> Option<(&'static str, Color)> {
    let p = c();
    Some(match rest.trim().to_ascii_uppercase().as_str() {
        "[!NOTE]" => ("ⓘ Note", p.pine),
        "[!TIP]" => ("✦ Tip", p.pine),
        "[!IMPORTANT]" => ("! Important", p.accent),
        "[!WARNING]" => ("⚠ Warning", p.gold),
        "[!CAUTION]" => ("✖ Caution", p.love),
        _ => return None,
    })
}

const BLOCK_TAGS: [&str; 14] = ["p", "div", "details", "center", "section", "article", "ul", "ol", "li", "span", "header", "footer", "main", "nav"];

fn is_block_tag(t: &str) -> bool {
    let t = t.trim_end();
    if !(t.starts_with('<') && t.ends_with('>')) || t[1..t.len() - 1].contains('<') {
        return false;
    }
    let inner = t[1..t.len() - 1].trim_start_matches('/');
    let name: String = inner.chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    BLOCK_TAGS.contains(&name.as_str()) || name == "br"
}

fn html_heading(t: &str) -> Option<usize> {
    let lower = t.to_ascii_lowercase();
    let b = lower.as_bytes();
    if b.len() > 4 && b[0] == b'<' && b[1] == b'h' && (b'1'..=b'6').contains(&b[2]) && (b[3] == b'>' || b[3] == b' ') {
        return Some((b[2] - b'0') as usize);
    }
    None
}

/// `t` when it is `<tag>…</tag>`, its inside.
fn strip_tag<'a>(t: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let rest = t.trim_end();
    if rest.len() >= open.len() && rest[..open.len()].eq_ignore_ascii_case(&open) {
        let inner = &rest[open.len()..];
        let n = inner.len();
        if n >= close.len() && inner[n - close.len()..].eq_ignore_ascii_case(&close) {
            return Some(&inner[..n - close.len()]);
        }
        return Some(inner);
    }
    None
}

fn split_br(line: &str) -> Vec<&str> {
    let lower = line.to_ascii_lowercase();
    let mut parts = Vec::new();
    let mut from = 0;
    let mut at = 0;
    while let Some(p) = lower[at..].find("<br") {
        let s = at + p;
        let Some(e) = lower[s..].find('>') else { break };
        let tag = &lower[s + 3..s + e];
        if tag.trim().trim_end_matches('/').trim().is_empty() {
            parts.push(&line[from..s]);
            from = s + e + 1;
        }
        at = s + e + 1;
    }
    parts.push(&line[from..]);
    parts
}

// --- inline ---------------------------------------------------------------------------------------------------------

fn push(out: &mut Vec<Span>, text: &str, style: Style) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last.style == style && last.link.is_none() {
            last.text.push_str(text);
            return;
        }
    }
    out.push(Span::new(text, style));
}

fn prev_char(s: &str, i: usize) -> Option<char> {
    s[..i].chars().next_back()
}

/// Where the `delim` that closes the one opened at `from` is: after something, right after a non-space.
fn closing(s: &str, from: usize, delim: &str) -> Option<usize> {
    let mut at = from;
    while let Some(p) = s[at..].find(delim) {
        let p = at + p;
        let before = prev_char(s, p);
        let after = s[p + delim.len()..].chars().next();
        let word = delim.starts_with('_') && after.is_some_and(|c| c.is_alphanumeric());
        // `**` inside `***` closes at the run's end.
        let longer = delim.len() == 1 && s[p + 1..].starts_with(delim);
        if p > from && before.is_some_and(|b| !b.is_whitespace()) && !word && !longer {
            return Some(p);
        }
        at = p + delim.len();
    }
    None
}

/// `s` as spans, its markdown, HTML, links and math drawn.
pub fn inline(s: &str, style: Style, out: &mut Vec<Span>) {
    let l = look();
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let ch = rest.chars().next().unwrap_or(' ');
        let prev = prev_char(s, i);
        match ch {
            '\\' => {
                if let Some(end) = rest.strip_prefix("\\(").and_then(|r| r.find("\\)")) {
                    math_inline(&rest[2..2 + end], &l, out);
                    i += 2 + end + 2;
                    continue;
                }
                if let Some(n) = rest[1..].chars().next().filter(|n| n.is_ascii_punctuation()) {
                    push(out, &n.to_string(), style);
                    i += 1 + n.len_utf8();
                    continue;
                }
            }
            '`' => {
                let n = rest.chars().take_while(|c| *c == '`').count();
                let fence = "`".repeat(n);
                let mut at = n;
                let mut found = None;
                while let Some(p) = rest[at..].find(&fence) {
                    let p = at + p;
                    let run = rest[p..].chars().take_while(|c| *c == '`').count();
                    if run == n {
                        found = Some(p);
                        break;
                    }
                    at = p + run;
                }
                if let Some(p) = found {
                    let inner = &rest[n..p];
                    let inner = if inner.len() > 2 && inner.starts_with(' ') && inner.ends_with(' ') { &inner[1..inner.len() - 1] } else { inner };
                    out.push(Span::new(inner, Style { attr: style.attr, ..l.code }));
                    i += p + n;
                    continue;
                }
                push(out, &fence, style);
                i += n;
                continue;
            }
            '$' => {
                let double = rest.starts_with("$$");
                let d = if double { 2 } else { 1 };
                let body = &rest[d..];
                let opens = body.chars().next().is_some_and(|c| !c.is_whitespace() && (double || !c.is_ascii_digit()));
                if opens {
                    let delim = if double { "$$" } else { "$" };
                    let mut at = 0;
                    let mut end = None;
                    while let Some(p) = body[at..].find(delim) {
                        let p = at + p;
                        let ok = p > 0 && prev_char(body, p).is_some_and(|b| !b.is_whitespace() && b != '\\') && (double || !body[p + 1..].starts_with(|c: char| c.is_ascii_digit()));
                        if ok {
                            end = Some(p);
                            break;
                        }
                        at = p + delim.len();
                    }
                    if let Some(p) = end {
                        math_inline(&body[..p], &l, out);
                        i += d + p + d;
                        continue;
                    }
                }
            }
            '*' | '_' | '~' | '=' | '+' => {
                let flank = prev.is_none_or(|p| !p.is_alphanumeric()) || ch == '*';
                let mut done = false;
                for (delim, attr) in [("***", Attr(Attr::BOLD.0 | Attr::ITALIC.0)), ("___", Attr(Attr::BOLD.0 | Attr::ITALIC.0)), ("**", Attr::BOLD), ("__", Attr::BOLD), ("~~", Attr::STRIKE), ("==", Attr::NONE), ("++", Attr::UNDERLINE), ("*", Attr::ITALIC), ("_", Attr::ITALIC)] {
                    if !rest.starts_with(delim) || (delim.starts_with('_') && !flank) {
                        continue;
                    }
                    let n = delim.len();
                    if rest[n..].chars().next().is_none_or(|c| c.is_whitespace()) {
                        continue;
                    }
                    let Some(p) = closing(rest, n, delim) else { continue };
                    let inner = &rest[n..p];
                    let st = match delim {
                        "==" => Style { attr: style.attr, ..l.mark },
                        "~~" => with(Style::fg(c().muted), Attr::STRIKE.with(style.attr)),
                        _ if attr.has(Attr::BOLD) => Style { attr: l.bold.attr.with(attr).with(style.attr), ..if style == l.text { l.bold } else { Style { fg: style.fg, ..l.bold } } },
                        _ => with(style, attr),
                    };
                    inline(inner, st, out);
                    i += p + n;
                    done = true;
                    break;
                }
                if done {
                    continue;
                }
            }
            '!' if rest.starts_with("![") => {
                if let Some((alt, url, len)) = link_at(&rest[1..]) {
                    out.push(Span { text: format!("[image: {}]", if alt.is_empty() { url } else { alt }), style: l.link, link: Some(url.to_string()) });
                    i += 1 + len;
                    continue;
                }
            }
            '[' => {
                if let Some((label, url, len)) = link_at(rest) {
                    let from = out.len();
                    inline(label, Style { attr: l.link.attr.with(style.attr), ..l.link }, out);
                    for sp in &mut out[from..] {
                        sp.link = Some(url.to_string());
                    }
                    // A span after it never merges into the link.
                    i += len;
                    continue;
                }
            }
            '<' => {
                if let Some(end) = rest.strip_prefix("<!--").and_then(|r| r.find("-->")) {
                    i += 4 + end + 3;
                    continue;
                }
                if let Some(end) = rest.find('>') {
                    let inside = &rest[1..end];
                    if (inside.starts_with("http://") || inside.starts_with("https://") || inside.starts_with("mailto:")) && !inside.contains(' ') {
                        out.push(Span { text: inside.to_string(), style: l.link, link: Some(inside.to_string()) });
                        i += end + 1;
                        continue;
                    }
                    if let Some(len) = html_inline(rest, end, style, &l, out) {
                        i += len;
                        continue;
                    }
                }
            }
            '&' => {
                if let Some(end) = rest[..rest.len().min(12)].find(';') {
                    if let Some(decoded) = entity(&rest[1..end]) {
                        push(out, &decoded.to_string(), style);
                        i += end + 1;
                        continue;
                    }
                }
            }
            'h' if prev.is_none_or(|p| !p.is_alphanumeric() && p != '/') && (rest.starts_with("https://") || rest.starts_with("http://")) => {
                let url = bare_url(rest);
                if url.len() > 8 {
                    out.push(Span { text: url.to_string(), style: Style { attr: l.link.attr.with(style.attr), ..l.link }, link: Some(url.to_string()) });
                    i += url.len();
                    continue;
                }
            }
            _ => {}
        }
        push(out, &rest[..ch.len_utf8()], style);
        i += ch.len_utf8();
    }
}

/// `[label](url)` at the start of `s`: the label, the url, and how long it is.
fn link_at(s: &str) -> Option<(&str, &str, usize)> {
    let mut depth = 0;
    let mut close = None;
    for (k, ch) in s.char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(k);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let after = &s[close + 1..];
    if !after.starts_with('(') {
        return None;
    }
    let mut depth = 0;
    let mut end = None;
    for (k, ch) in after.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(k);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end?;
    let target = after[1..end].trim();
    let url = target.split_whitespace().next().unwrap_or("").trim_start_matches('<').trim_end_matches('>');
    Some((&s[1..close], url, close + 1 + end + 1))
}

fn bare_url(s: &str) -> &str {
    let end = s.find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '`')).unwrap_or(s.len());
    let mut url = &s[..end];
    loop {
        let before = url.len();
        url = url.trim_end_matches(['.', ',', ';', ':', '!', '?', '\'', '*', '_']);
        if url.ends_with(')') && url.matches(')').count() > url.matches('(').count() {
            url = &url[..url.len() - 1];
        }
        if url.len() == before {
            return url;
        }
    }
}

fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let p = lower.find(&format!("{name}="))?;
    let v = &tag[p + name.len() + 1..];
    let q = v.chars().next()?;
    if q == '"' || q == '\'' {
        let e = v[1..].find(q)?;
        Some(&v[1..1 + e])
    } else {
        Some(v.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or(""))
    }
}

/// An inline HTML element at the start of `rest` (its open tag ends at `end`): how long it is, once drawn.
fn html_inline(rest: &str, end: usize, style: Style, l: &Look, out: &mut Vec<Span>) -> Option<usize> {
    let inside = &rest[1..end];
    let closing_tag = inside.starts_with('/');
    let name: String = inside.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    let st = match name.as_str() {
        "b" | "strong" => Some(Style { attr: l.bold.attr.with(style.attr), ..l.bold }),
        "i" | "em" | "cite" | "var" | "dfn" => Some(with(style, Attr::ITALIC)),
        "u" | "ins" => Some(with(style, Attr::UNDERLINE)),
        "s" | "del" | "strike" => Some(with(Style::fg(c().muted), Attr::STRIKE)),
        "mark" => Some(l.mark),
        "code" | "kbd" | "samp" | "tt" => Some(l.code),
        "small" => Some(Style { fg: c().muted, ..style }),
        "a" => Some(l.link),
        "sub" | "sup" | "span" | "font" | "abbr" | "q" | "p" | "div" | "center" | "summary" | "details" | "li" | "big" => Some(style),
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => Some(heading((name.as_bytes()[1] - b'0') as usize)),
        "br" | "hr" | "wbr" => {
            if name == "br" {
                push(out, " ", style);
            }
            return Some(end + 1);
        }
        "img" => {
            let alt = attr_value(inside, "alt").unwrap_or("");
            let src = attr_value(inside, "src").unwrap_or("");
            out.push(Span { text: format!("[image: {}]", if alt.is_empty() { src } else { alt }), style: l.link, link: (!src.is_empty()).then(|| src.to_string()) });
            return Some(end + 1);
        }
        _ => None,
    }?;
    if closing_tag || inside.ends_with('/') {
        // A stray closing tag, or one that closes itself: nothing drawn.
        return Some(end + 1);
    }
    let body = &rest[end + 1..];
    let close = format!("</{name}");
    let lower = body.to_ascii_lowercase();
    let Some(p) = lower.find(&close) else {
        return Some(end + 1);
    };
    let inner = &body[..p];
    let close_end = body[p..].find('>').map_or(body.len(), |e| p + e + 1);
    let from = out.len();
    match name.as_str() {
        "sup" => push(out, &script(&latex(inner), true), style),
        "sub" => push(out, &script(&latex(inner), false), style),
        "code" | "kbd" | "samp" | "tt" => out.push(Span::new(decode(inner), st)),
        _ => inline(inner, st, out),
    }
    if name == "a" {
        if let Some(href) = attr_value(inside, "href") {
            for sp in &mut out[from..] {
                sp.link = Some(href.to_string());
            }
        }
    }
    Some(end + 1 + close_end)
}

fn entity(name: &str) -> Option<char> {
    if let Some(num) = name.strip_prefix('#') {
        let n = match num.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => num.parse().ok()?,
        };
        return char::from_u32(n);
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "hellip" => '…',
        "mdash" => '—',
        "ndash" => '–',
        "rarr" => '→',
        "larr" => '←',
        "times" => '×',
        "middot" => '·',
        "deg" => '°',
        "bull" => '•',
        _ => return None,
    })
}

fn decode(s: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if rest.starts_with('&') {
            if let Some(end) = rest[..rest.len().min(12)].find(';') {
                if let Some(ch) = entity(&rest[1..end]) {
                    out.push(ch);
                    i += end + 1;
                    continue;
                }
            }
        }
        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

// --- math -----------------------------------------------------------------------------------------------------------

fn math_inline(tex: &str, l: &Look, out: &mut Vec<Span>) {
    out.push(Span::new(format!(" {} ", latex(tex).replace('\n', " ")), l.math));
}

fn math_block(tex: &str, width: usize, l: &Look, out: &mut Vec<Vec<Span>>) {
    let text = latex(tex);
    for line in text.lines().map(str::trim).filter(|x| !x.is_empty()) {
        for row in wrap_spans(&[Span::new(line, l.math)], width.saturating_sub(4)) {
            let w: usize = row.iter().map(|s| s.text.width()).sum();
            let left = (width.saturating_sub(w)) / 2;
            let mut spans = vec![Span::new(" ".repeat(left), l.math)];
            spans.extend(row);
            spans.push(Span::new(" ".repeat(width.saturating_sub(left + w)), l.math));
            out.push(spans);
        }
    }
}

const SYMBOLS: &[(&str, &str)] = &[
    ("alpha", "α"), ("beta", "β"), ("gamma", "γ"), ("delta", "δ"), ("epsilon", "ϵ"), ("varepsilon", "ε"), ("zeta", "ζ"), ("eta", "η"),
    ("theta", "θ"), ("vartheta", "ϑ"), ("iota", "ι"), ("kappa", "κ"), ("lambda", "λ"), ("mu", "μ"), ("nu", "ν"), ("xi", "ξ"),
    ("pi", "π"), ("varpi", "ϖ"), ("rho", "ρ"), ("varrho", "ϱ"), ("sigma", "σ"), ("varsigma", "ς"), ("tau", "τ"), ("upsilon", "υ"),
    ("phi", "ϕ"), ("varphi", "φ"), ("chi", "χ"), ("psi", "ψ"), ("omega", "ω"), ("Gamma", "Γ"), ("Delta", "Δ"), ("Theta", "Θ"),
    ("Lambda", "Λ"), ("Xi", "Ξ"), ("Pi", "Π"), ("Sigma", "Σ"), ("Upsilon", "Υ"), ("Phi", "Φ"), ("Psi", "Ψ"), ("Omega", "Ω"),
    ("times", "×"), ("div", "÷"), ("cdot", "·"), ("pm", "±"), ("mp", "∓"), ("leq", "≤"), ("le", "≤"), ("geq", "≥"), ("ge", "≥"),
    ("neq", "≠"), ("ne", "≠"), ("approx", "≈"), ("equiv", "≡"), ("sim", "∼"), ("simeq", "≃"), ("cong", "≅"), ("propto", "∝"),
    ("ll", "≪"), ("gg", "≫"), ("infty", "∞"), ("partial", "∂"), ("nabla", "∇"), ("sum", "∑"), ("prod", "∏"), ("coprod", "∐"),
    ("int", "∫"), ("iint", "∬"), ("iiint", "∭"), ("oint", "∮"), ("in", "∈"), ("notin", "∉"), ("ni", "∋"), ("subset", "⊂"),
    ("subseteq", "⊆"), ("supset", "⊃"), ("supseteq", "⊇"), ("cup", "∪"), ("cap", "∩"), ("bigcup", "⋃"), ("bigcap", "⋂"),
    ("emptyset", "∅"), ("varnothing", "∅"), ("forall", "∀"), ("exists", "∃"), ("nexists", "∄"), ("neg", "¬"), ("lnot", "¬"),
    ("land", "∧"), ("wedge", "∧"), ("lor", "∨"), ("vee", "∨"), ("to", "→"), ("rightarrow", "→"), ("leftarrow", "←"),
    ("gets", "←"), ("Rightarrow", "⇒"), ("Leftarrow", "⇐"), ("leftrightarrow", "↔"), ("Leftrightarrow", "⇔"), ("iff", "⇔"),
    ("implies", "⟹"), ("impliedby", "⟸"), ("mapsto", "↦"), ("uparrow", "↑"), ("downarrow", "↓"), ("longrightarrow", "⟶"),
    ("cdots", "⋯"), ("ldots", "…"), ("dots", "…"), ("vdots", "⋮"), ("ddots", "⋱"), ("angle", "∠"), ("perp", "⊥"),
    ("parallel", "∥"), ("circ", "∘"), ("bullet", "•"), ("star", "⋆"), ("ast", "∗"), ("oplus", "⊕"), ("otimes", "⊗"),
    ("odot", "⊙"), ("hbar", "ℏ"), ("ell", "ℓ"), ("Re", "ℜ"), ("Im", "ℑ"), ("aleph", "ℵ"), ("wp", "℘"), ("prime", "′"),
    ("degree", "°"), ("langle", "⟨"), ("rangle", "⟩"), ("lfloor", "⌊"), ("rfloor", "⌋"), ("lceil", "⌈"), ("rceil", "⌉"),
    ("vert", "|"), ("lvert", "|"), ("rvert", "|"), ("Vert", "‖"), ("lVert", "‖"), ("rVert", "‖"), ("mid", "∣"), ("setminus", "∖"),
    ("therefore", "∴"), ("because", "∵"), ("triangle", "△"), ("square", "□"), ("checkmark", "✓"), ("dagger", "†"),
    ("lbrace", "{"), ("rbrace", "}"), ("{", "{"), ("}", "}"), ("%", "%"), ("$", "$"), ("#", "#"), ("&", "&"), ("_", "_"),
    ("quad", "  "), ("qquad", "    "), (",", " "), (";", " "), (":", " "), ("!", ""), (" ", " "), ("left", ""), ("right", ""),
    ("big", ""), ("Big", ""), ("bigg", ""), ("Bigg", ""), ("displaystyle", ""), ("limits", ""), ("nolimits", ""), ("sqrt", "√"),
];

const BLACKBOARD: &[(char, char)] = &[('R', 'ℝ'), ('N', 'ℕ'), ('Z', 'ℤ'), ('Q', 'ℚ'), ('C', 'ℂ'), ('P', 'ℙ'), ('H', 'ℍ'), ('E', '𝔼')];
const SUPER: &[(char, char)] = &[
    ('0', '⁰'), ('1', '¹'), ('2', '²'), ('3', '³'), ('4', '⁴'), ('5', '⁵'), ('6', '⁶'), ('7', '⁷'), ('8', '⁸'), ('9', '⁹'), ('+', '⁺'),
    ('-', '⁻'), ('−', '⁻'), ('=', '⁼'), ('(', '⁽'), (')', '⁾'), ('n', 'ⁿ'), ('i', 'ⁱ'), ('x', 'ˣ'), ('y', 'ʸ'), ('T', 'ᵀ'), ('k', 'ᵏ'),
    ('a', 'ᵃ'), ('b', 'ᵇ'), ('c', 'ᶜ'), ('d', 'ᵈ'), ('e', 'ᵉ'), ('m', 'ᵐ'), ('o', 'ᵒ'), ('p', 'ᵖ'), ('r', 'ʳ'), ('s', 'ˢ'), ('t', 'ᵗ'),
    ('u', 'ᵘ'), ('v', 'ᵛ'), ('w', 'ʷ'), ('h', 'ʰ'), ('j', 'ʲ'), ('l', 'ˡ'), ('g', 'ᵍ'), ('*', '*'), ('′', '′'), ('\'', '′'),
];
const SUB: &[(char, char)] = &[
    ('0', '₀'), ('1', '₁'), ('2', '₂'), ('3', '₃'), ('4', '₄'), ('5', '₅'), ('6', '₆'), ('7', '₇'), ('8', '₈'), ('9', '₉'), ('+', '₊'),
    ('-', '₋'), ('−', '₋'), ('=', '₌'), ('(', '₍'), (')', '₎'), ('a', 'ₐ'), ('e', 'ₑ'), ('o', 'ₒ'), ('x', 'ₓ'), ('h', 'ₕ'), ('k', 'ₖ'),
    ('l', 'ₗ'), ('m', 'ₘ'), ('n', 'ₙ'), ('p', 'ₚ'), ('s', 'ₛ'), ('t', 'ₜ'), ('i', 'ᵢ'), ('j', 'ⱼ'), ('r', 'ᵣ'), ('u', 'ᵤ'), ('v', 'ᵥ'),
];

/// `s` raised (or lowered): each character as its small one, or `^(s)` when one has none.
fn script(s: &str, up: bool) -> String {
    let table = if up { SUPER } else { SUB };
    let small: Option<String> = s.chars().filter(|c| *c != ' ').map(|ch| table.iter().find(|(a, _)| *a == ch).map(|(_, b)| *b)).collect();
    match small {
        Some(t) if !t.is_empty() => t,
        _ if s.chars().count() == 1 => format!("{}{s}", if up { "^" } else { "_" }),
        _ => format!("{}({s})", if up { "^" } else { "_" }),
    }
}

/// The `{…}` group (or the one character) at the start of `s`: its inside and how long it is.
fn group(s: &str) -> (&str, usize) {
    let s_trim = s.trim_start();
    let skipped = s.len() - s_trim.len();
    if s_trim.starts_with('{') {
        let mut depth = 0;
        for (k, ch) in s_trim.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return (&s_trim[1..k], skipped + k + 1);
                    }
                }
                _ => {}
            }
        }
        return (&s_trim[1..], s.len());
    }
    if s_trim.starts_with('\\') {
        let n = s_trim[1..].chars().take_while(|c| c.is_ascii_alphabetic()).count().max(1);
        let n = s_trim[1..].char_indices().nth(n).map_or(s_trim.len(), |(k, _)| k + 1);
        return (&s_trim[..n], skipped + n);
    }
    match s_trim.chars().next() {
        Some(ch) => (&s_trim[..ch.len_utf8()], skipped + ch.len_utf8()),
        None => ("", s.len()),
    }
}

fn simple(s: &str) -> bool {
    s.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '′' | '√'))
}

/// LaTeX as text: what has a character is drawn as it, the rest loses its markup.
pub fn latex(tex: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < tex.len() {
        let rest = &tex[i..];
        let ch = rest.chars().next().unwrap_or(' ');
        match ch {
            '\\' => {
                if rest.starts_with("\\\\") {
                    out.push('\n');
                    i += 2;
                    continue;
                }
                let name_len = rest[1..].chars().take_while(|c| c.is_ascii_alphabetic()).count();
                let (name, len) = if name_len == 0 {
                    let n = rest[1..].chars().next().map_or(0, char::len_utf8);
                    (&rest[1..1 + n], 1 + n)
                } else {
                    (&rest[1..1 + name_len], 1 + name_len)
                };
                i += len;
                match name {
                    "frac" | "dfrac" | "tfrac" | "binom" => {
                        let (a, la) = group(&tex[i..]);
                        i += la;
                        let (b, lb) = group(&tex[i..]);
                        i += lb;
                        let (a, b) = (latex(a), latex(b));
                        let wrap = |x: &str| if simple(x) { x.to_string() } else { format!("({x})") };
                        if name == "binom" {
                            out.push_str(&format!("C({a}, {b})"));
                        } else {
                            out.push_str(&format!("{}/{}", wrap(&a), wrap(&b)));
                        }
                    }
                    "sqrt" => {
                        let mut root = String::new();
                        if tex[i..].starts_with('[') {
                            if let Some(e) = tex[i..].find(']') {
                                root = script(&latex(&tex[i + 1..i + e]), true);
                                i += e + 1;
                            }
                        }
                        let (a, la) = group(&tex[i..]);
                        i += la;
                        let a = latex(a);
                        out.push_str(&root);
                        out.push('√');
                        out.push_str(&if simple(&a) { a } else { format!("({a})") });
                    }
                    "text" | "textrm" | "textbf" | "textit" | "mathrm" | "mathbf" | "mathit" | "mathsf" | "mathtt" | "operatorname" | "boldsymbol" | "bm" | "mbox" | "hat" | "bar" | "vec" | "tilde" | "dot" | "ddot" | "overline" | "underline" | "mathcal" | "mathfrak" | "widehat" | "widetilde" => {
                        let (a, la) = group(&tex[i..]);
                        i += la;
                        let inner = if name.starts_with("text") || name == "mbox" || name == "operatorname" { a.to_string() } else { latex(a) };
                        out.push_str(&inner);
                        let mark = match name {
                            "hat" | "widehat" => "\u{302}",
                            "bar" | "overline" => "\u{305}",
                            "vec" => "\u{20d7}",
                            "tilde" | "widetilde" => "\u{303}",
                            "dot" => "\u{307}",
                            "ddot" => "\u{308}",
                            _ => "",
                        };
                        if inner.chars().count() == 1 {
                            out.push_str(mark);
                        }
                    }
                    "mathbb" => {
                        let (a, la) = group(&tex[i..]);
                        i += la;
                        for ch in a.chars() {
                            out.push(BLACKBOARD.iter().find(|(x, _)| *x == ch).map_or(ch, |(_, y)| *y));
                        }
                    }
                    "begin" | "end" => {
                        let (_, la) = group(&tex[i..]);
                        i += la;
                    }
                    _ => match SYMBOLS.iter().find(|(n, _)| *n == name) {
                        Some((_, sym)) => {
                            out.push_str(sym);
                            // `\pi r` keeps its space; `\pi{}` and `\alpha_i` do not need one.
                            if tex[i..].starts_with(' ') && sym.chars().all(|c| !c.is_whitespace()) && !sym.is_empty() {
                                out.push(' ');
                                i += 1;
                            }
                        }
                        // `\sin`, `\log`, `\max` and the rest are their names.
                        None => out.push_str(name),
                    },
                }
            }
            '^' | '_' => {
                i += 1;
                let (a, la) = group(&tex[i..]);
                i += la;
                out.push_str(&script(&latex(a), ch == '^'));
            }
            '{' | '}' => i += 1,
            '&' => {
                out.push(' ');
                i += 1;
            }
            '~' => {
                out.push(' ');
                i += 1;
            }
            '\n' => {
                out.push(' ');
                i += 1;
            }
            _ => {
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    out
}

// --- tables ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Align {
    Left,
    Center,
    Right,
}

fn is_table_rule(line: &str) -> bool {
    let t = line.trim();
    t.contains('-') && t.contains(['|', '-']) && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) && (t.contains('|') || t.starts_with('-'))
}

fn align_of(cell: &str) -> Align {
    match (cell.starts_with(':'), cell.ends_with(':')) {
        (true, true) => Align::Center,
        (false, true) => Align::Right,
        _ => Align::Left,
    }
}

fn cells(line: &str) -> Vec<String> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut code = false;
    let mut chars = t.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if chars.peek() == Some(&'|') => {
                cur.push('|');
                chars.next();
            }
            '`' => {
                code = !code;
                cur.push(ch);
            }
            '|' if !code => out.push(std::mem::take(&mut cur).trim().to_string()),
            _ => cur.push(ch),
        }
    }
    out.push(cur.trim().to_string());
    out
}

fn table(rows: &[Vec<String>], aligns: &[Align], width: usize, l: &Look, out: &mut Vec<Vec<Span>>) {
    let n = rows.iter().map(Vec::len).max().unwrap_or(0);
    if n == 0 {
        return;
    }
    let drawn: Vec<Vec<Vec<Span>>> = rows
        .iter()
        .enumerate()
        .map(|(r, row)| {
            (0..n)
                .map(|k| {
                    let mut spans = Vec::new();
                    inline(row.get(k).map_or("", String::as_str), if r == 0 { l.bold } else { l.text }, &mut spans);
                    spans
                })
                .collect()
        })
        .collect();
    let wid = |s: &Vec<Span>| s.iter().map(|x| x.text.width()).sum::<usize>();
    let mut cols: Vec<usize> = (0..n).map(|k| drawn.iter().map(|r| wid(&r[k])).max().unwrap_or(0).max(1)).collect();
    // Columns shrink, the widest first, until the table fits; a cell then wraps in its column.
    let room = width.saturating_sub(3 * n + 1);
    while cols.iter().sum::<usize>() > room {
        let (k, w) = cols.iter().enumerate().max_by_key(|(_, w)| **w).map(|(k, w)| (k, *w)).unwrap_or((0, 1));
        if w <= 3 {
            break;
        }
        cols[k] = w - 1;
    }
    let border = |left: &str, mid: &str, right: &str| {
        let mut s = left.to_string();
        for (k, w) in cols.iter().enumerate() {
            s.push_str(&"─".repeat(w + 2));
            s.push_str(if k + 1 == n { right } else { mid });
        }
        vec![Span::new(s, l.rule)]
    };
    out.push(border("┌", "┬", "┐"));
    for (r, row) in drawn.iter().enumerate() {
        let wrapped: Vec<Vec<Vec<Span>>> = row.iter().enumerate().map(|(k, s)| wrap_spans(s, cols[k])).collect();
        let height = wrapped.iter().map(Vec::len).max().unwrap_or(1);
        for line in 0..height {
            let mut spans = vec![Span::new("│", l.rule)];
            for (k, cell) in wrapped.iter().enumerate() {
                let part = cell.get(line).cloned().unwrap_or_default();
                let w = wid(&part);
                let gap = cols[k].saturating_sub(w);
                let (before, after) = match aligns.get(k).copied().unwrap_or(Align::Left) {
                    Align::Left => (0, gap),
                    Align::Right => (gap, 0),
                    Align::Center => (gap / 2, gap - gap / 2),
                };
                spans.push(Span::new(" ".repeat(before + 1), l.text));
                spans.extend(part);
                spans.push(Span::new(" ".repeat(after + 1), l.text));
                spans.push(Span::new("│", l.rule));
            }
            out.push(spans);
        }
        if r == 0 && drawn.len() > 1 {
            out.push(border("├", "┼", "┤"));
        }
    }
    out.push(border("└", "┴", "┘"));
}

// --- code -----------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Family {
    CLike,
    Hash,
    Sql,
    Html,
    Css,
    Markdown,
    Diff,
    Plain,
}

fn family(lang: &str) -> Family {
    match lang {
        "rust" | "rs" | "js" | "javascript" | "jsx" | "ts" | "typescript" | "tsx" | "mjs" | "cjs" | "java" | "c" | "h" | "cpp" | "c++" | "cc"
        | "hpp" | "cs" | "csharp" | "go" | "swift" | "kotlin" | "kt" | "php" | "dart" | "scala" | "json" | "jsonc" | "json5" | "zig"
        | "groovy" | "gradle" | "proto" | "solidity" | "sol" | "glsl" | "hlsl" | "wgsl" => Family::CLike,
        "python" | "py" | "sh" | "bash" | "zsh" | "fish" | "shell" | "console" | "powershell" | "ps1" | "pwsh" | "ruby" | "rb" | "yaml"
        | "yml" | "toml" | "ini" | "r" | "perl" | "pl" | "makefile" | "make" | "dockerfile" | "docker" | "nix" | "elixir" | "ex" | "conf" | "env"
        | "julia" | "jl" | "nim" | "cmake" => Family::Hash,
        "sql" | "psql" | "mysql" | "sqlite" | "lua" | "haskell" | "hs" => Family::Sql,
        "html" | "htm" | "xml" | "svg" | "vue" | "svelte" | "xhtml" | "jsp" | "erb" | "astro" => Family::Html,
        "css" | "scss" | "sass" | "less" | "stylus" => Family::Css,
        "md" | "markdown" | "mdx" => Family::Markdown,
        "diff" | "patch" => Family::Diff,
        _ => Family::Plain,
    }
}

const KEYWORDS: &[&str] = &[
    "fn", "let", "mut", "const", "var", "function", "return", "if", "else", "for", "while", "loop", "match", "in", "of", "class", "struct",
    "enum", "impl", "trait", "pub", "use", "import", "from", "export", "default", "async", "await", "new", "this", "self", "Self", "super",
    "true", "false", "null", "undefined", "None", "True", "False", "nil", "def", "elif", "lambda", "try", "except", "catch", "finally",
    "throw", "throws", "raise", "with", "as", "type", "interface", "extends", "implements", "static", "void", "int", "float", "double",
    "bool", "boolean", "string", "char", "package", "func", "defer", "select", "case", "switch", "break", "continue", "yield", "where",
    "mod", "crate", "dyn", "ref", "move", "unsafe", "extern", "echo", "then", "fi", "do", "done", "esac", "local", "begin", "end", "and",
    "or", "not", "is", "pass", "global", "nonlocal", "assert", "del", "typeof", "instanceof", "private", "protected", "public", "final",
    "abstract", "override", "virtual", "goto", "sizeof", "readonly", "declare", "namespace", "module", "require", "until", "unless",
    "elsif", "foreach", "function", "param", "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
    "TABLE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "AND", "OR", "NOT", "NULL",
    "AS", "DISTINCT", "PRIMARY", "KEY", "INDEX", "DROP", "ALTER", "union", "u8", "u16", "u32", "u64", "usize", "i8", "i16", "i32",
    "i64", "isize", "f32", "f64", "str", "String", "Vec", "Option", "Some", "Ok", "Err", "Result", "number", "any", "unknown", "never",
];

/// What a code block's line carries from the last: an open comment, a tag or the braces it is in.
#[derive(Default)]
struct CodeState {
    comment: bool,
    tag: bool,
    depth: usize,
}

struct Palette {
    keyword: Style,
    string: Style,
    number: Style,
    comment: Style,
    function: Style,
    kind: Style,
    key: Style,
    text: Style,
    punct: Style,
}

fn code_palette(l: &Look) -> Palette {
    let p = c();
    let on = |fg: Color| Style::fg(fg).on(l.code_bg);
    Palette {
        keyword: on(p.accent),
        string: on(p.pine),
        number: on(p.love),
        comment: Style { fg: p.muted, bg: l.code_bg, attr: Attr::ITALIC },
        function: on(if rgb(p.gold, p.accent) { mix(p.gold, p.accent, 0.35) } else { p.gold }),
        kind: on(p.gold),
        key: on(if rgb(p.pine, p.text) { mix(p.pine, p.text, 0.35) } else { p.pine }),
        text: on(p.text),
        punct: on(p.subtle),
    }
}

fn code_block(body: &[&str], lang: &str, width: usize, l: &Look, out: &mut Vec<Vec<Span>>) {
    let fam = family(lang);
    let pal = code_palette(l);
    let mut state = CodeState::default();
    let pad = Style::default().on(l.code_bg);
    if !lang.is_empty() {
        let label = format!(" {lang}");
        let w = label.width();
        out.push(vec![Span::new(label, Style { fg: c().muted, bg: l.code_bg, attr: Attr::ITALIC }), Span::new(" ".repeat(width.saturating_sub(w)), pad)]);
    }
    for line in body {
        let mut spans = highlight(line, fam, &mut state, &pal);
        // A diff's added and removed lines are tinted their whole width, as the diff viewer draws them.
        let pad = match (fam, diff_kind(line)) {
            (Family::Diff, Some(kind)) => {
                let bg = crate::diff::background(kind).0.bg;
                spans.iter_mut().for_each(|s| s.style.bg = bg);
                Style::default().on(bg)
            }
            _ => pad,
        };
        for row in wrap_spans(&spans, width.saturating_sub(2)) {
            let w: usize = row.iter().map(|s| s.text.width()).sum();
            let mut r = vec![Span::new(" ", pad)];
            r.extend(row);
            r.push(Span::new(" ".repeat(width.saturating_sub(w + 1)), pad));
            out.push(r);
        }
    }
    if body.is_empty() {
        out.push(vec![Span::new(" ".repeat(width), pad)]);
    }
}

/// A diff line's kind: added or removed; none for context, a hunk header or a file's header.
fn diff_kind(line: &str) -> Option<crate::diff::Kind> {
    if line.starts_with("+++") || line.starts_with("---") {
        return None;
    }
    match line.chars().next() {
        Some('+') => Some(crate::diff::Kind::Add),
        Some('-') => Some(crate::diff::Kind::Del),
        _ => None,
    }
}

fn highlight(line: &str, fam: Family, st: &mut CodeState, p: &Palette) -> Vec<Span> {
    let mut out = Vec::new();
    match fam {
        Family::Plain => push(&mut out, line, p.text),
        Family::Diff => {
            let s = match line.chars().next() {
                Some('+') => p.string,
                Some('-') => p.number,
                Some('@') => p.keyword,
                _ => p.text,
            };
            push(&mut out, line, s);
        }
        Family::Markdown => {
            let t = line.trim_start();
            let s = if t.starts_with('#') {
                p.keyword.bold()
            } else if t.starts_with('>') {
                p.comment
            } else if list_item(t).is_some() {
                p.key
            } else {
                p.text
            };
            push(&mut out, line, s);
        }
        Family::Html => html_code(line, st, p, &mut out),
        Family::Css => css_code(line, st, p, &mut out),
        Family::CLike | Family::Hash | Family::Sql => generic_code(line, fam, st, p, &mut out),
    }
    out
}

fn ident_len(s: &str) -> usize {
    s.char_indices().find(|(_, c)| !(c.is_alphanumeric() || *c == '_')).map_or(s.len(), |(k, _)| k)
}

fn string_len(s: &str, q: char) -> usize {
    let mut esc = false;
    for (k, ch) in s.char_indices().skip(1) {
        if esc {
            esc = false;
        } else if ch == '\\' {
            esc = true;
        } else if ch == q {
            return k + ch.len_utf8();
        }
    }
    s.len()
}

fn generic_code(line: &str, fam: Family, st: &mut CodeState, p: &Palette, out: &mut Vec<Span>) {
    let mut i = 0;
    let line_comment = match fam {
        Family::Hash => "#",
        Family::Sql => "--",
        _ => "//",
    };
    while i < line.len() {
        let rest = &line[i..];
        if st.comment {
            match rest.find("*/") {
                Some(e) => {
                    push(out, &rest[..e + 2], p.comment);
                    i += e + 2;
                    st.comment = false;
                }
                None => {
                    push(out, rest, p.comment);
                    return;
                }
            }
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        if rest.starts_with(line_comment) && !(fam == Family::Hash && rest.starts_with("#!") && i > 0) {
            push(out, rest, p.comment);
            return;
        }
        if fam != Family::Hash && rest.starts_with("/*") {
            st.comment = true;
            continue;
        }
        if ch == '"' || ch == '`' || (ch == '\'' && (fam != Family::CLike || rest[1..].chars().take(3).any(|c| c == '\''))) {
            let n = string_len(rest, ch);
            let key = rest[n..].trim_start().starts_with(':') && !rest[n..].trim_start().starts_with("::");
            push(out, &rest[..n], if key { p.key } else { p.string });
            i += n;
            continue;
        }
        if ch.is_ascii_digit() {
            let n = rest.char_indices().find(|(_, c)| !(c.is_alphanumeric() || *c == '.' || *c == '_')).map_or(rest.len(), |(k, _)| k);
            push(out, &rest[..n], p.number);
            i += n;
            continue;
        }
        if ch.is_alphabetic() || ch == '_' || ((ch == '$' || ch == '@') && rest[1..].starts_with(|c: char| c.is_alphabetic() || c == '{')) {
            let skip = usize::from(ch == '$' || ch == '@');
            let n = skip + ident_len(&rest[skip..]);
            let word = &rest[..n];
            let after = rest[n..].trim_start();
            let s = if ch == '@' {
                p.function
            } else if ch == '$' {
                p.kind
            } else if KEYWORDS.contains(&word) || (fam == Family::Sql && KEYWORDS.contains(&word.to_ascii_uppercase().as_str())) {
                p.keyword
            } else if after.starts_with('(') || after.starts_with("!(") || after.starts_with("::<") {
                p.function
            } else if (after.starts_with(':') || after.starts_with('=')) && !after.starts_with("::") && !after.starts_with("==") && fam == Family::Hash && i == line.len() - line.trim_start().len() {
                p.key
            } else if word.chars().next().is_some_and(char::is_uppercase) {
                p.kind
            } else {
                p.text
            };
            push(out, word, s);
            i += n;
            continue;
        }
        let s = if ch.is_ascii_punctuation() { p.punct } else { p.text };
        push(out, &rest[..ch.len_utf8()], s);
        i += ch.len_utf8();
    }
}

fn html_code(line: &str, st: &mut CodeState, p: &Palette, out: &mut Vec<Span>) {
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        if st.comment {
            match rest.find("-->") {
                Some(e) => {
                    push(out, &rest[..e + 3], p.comment);
                    i += e + 3;
                    st.comment = false;
                }
                None => {
                    push(out, rest, p.comment);
                    return;
                }
            }
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        if st.tag {
            if rest.starts_with("/>") || ch == '>' {
                let n = if ch == '>' { 1 } else { 2 };
                push(out, &rest[..n], p.punct);
                i += n;
                st.tag = false;
            } else if ch == '"' || ch == '\'' {
                let n = string_len(rest, ch);
                push(out, &rest[..n], p.string);
                i += n;
            } else if ch.is_alphabetic() || ch == '@' || ch == ':' {
                let n = rest.char_indices().find(|(_, c)| !(c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '@' | '.'))).map_or(rest.len(), |(k, _)| k).max(1);
                push(out, &rest[..n], p.kind);
                i += n;
            } else {
                push(out, &rest[..ch.len_utf8()], p.punct);
                i += ch.len_utf8();
            }
            continue;
        }
        if rest.starts_with("<!--") {
            st.comment = true;
            continue;
        }
        if ch == '<' && rest[1..].starts_with(|c: char| c.is_alphabetic() || c == '/' || c == '!') {
            let lead = if rest[1..].starts_with(['/', '!']) { 2 } else { 1 };
            let n = lead + rest[lead..].char_indices().find(|(_, c)| !(c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))).map_or(rest.len() - lead, |(k, _)| k);
            push(out, &rest[..lead], p.punct);
            push(out, &rest[lead..n], p.keyword);
            i += n;
            st.tag = true;
            continue;
        }
        if ch == '&' {
            if let Some(e) = rest[..rest.len().min(12)].find(';') {
                push(out, &rest[..e + 1], p.number);
                i += e + 1;
                continue;
            }
        }
        push(out, &rest[..ch.len_utf8()], p.text);
        i += ch.len_utf8();
    }
}

fn css_code(line: &str, st: &mut CodeState, p: &Palette, out: &mut Vec<Span>) {
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        if st.comment {
            match rest.find("*/") {
                Some(e) => {
                    push(out, &rest[..e + 2], p.comment);
                    i += e + 2;
                    st.comment = false;
                }
                None => {
                    push(out, rest, p.comment);
                    return;
                }
            }
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        if rest.starts_with("/*") {
            st.comment = true;
            continue;
        }
        if rest.starts_with("//") {
            push(out, rest, p.comment);
            return;
        }
        match ch {
            '{' => {
                st.depth += 1;
                push(out, "{", p.punct);
                i += 1;
            }
            '}' => {
                st.depth = st.depth.saturating_sub(1);
                push(out, "}", p.punct);
                i += 1;
            }
            '"' | '\'' => {
                let n = string_len(rest, ch);
                push(out, &rest[..n], p.string);
                i += n;
            }
            '@' => {
                let n = 1 + ident_len(&rest[1..]);
                push(out, &rest[..n], p.keyword);
                i += n;
            }
            '#' if st.depth > 0 => {
                let n = 1 + ident_len(&rest[1..]);
                push(out, &rest[..n], p.number);
                i += n;
            }
            c0 if c0.is_ascii_digit() || (c0 == '.' && rest[1..].starts_with(|c: char| c.is_ascii_digit())) => {
                let n = rest.char_indices().find(|(_, c)| !(c.is_alphanumeric() || *c == '.' || *c == '%')).map_or(rest.len(), |(k, _)| k);
                push(out, &rest[..n], p.number);
                i += n;
            }
            c0 if c0.is_alphabetic() || c0 == '-' || c0 == '_' || ((c0 == '.' || c0 == '#' || c0 == ':') && st.depth == 0) => {
                let lead = usize::from(!c0.is_alphanumeric() && c0 != '-' && c0 != '_');
                let n = lead + rest[lead..].char_indices().find(|(_, c)| !(c.is_alphanumeric() || matches!(c, '-' | '_'))).map_or(rest.len() - lead, |(k, _)| k);
                let n = n.max(1);
                let word = &rest[..n];
                let after = rest[n..].trim_start();
                let s = if st.depth == 0 {
                    if c0 == '.' || c0 == '#' || c0 == ':' { p.function } else { p.keyword }
                } else if after.starts_with(':') && !word.starts_with(':') {
                    p.key
                } else if after.starts_with('(') {
                    p.function
                } else if word == "important" {
                    p.keyword
                } else {
                    p.kind
                };
                push(out, word, s);
                i += n;
            }
            _ => {
                push(out, &rest[..ch.len_utf8()], p.punct);
                i += ch.len_utf8();
            }
        }
    }
}

// --- wrapping -------------------------------------------------------------------------------------------------------

fn wrap_into(out: &mut Vec<Vec<Span>>, first: Vec<Span>, rest: Vec<Span>, spans: Vec<Span>, width: usize) {
    let pw = first.iter().map(|s| s.text.width()).sum::<usize>().max(rest.iter().map(|s| s.text.width()).sum());
    for (k, row) in wrap_spans(&spans, width.saturating_sub(pw).max(4)).into_iter().enumerate() {
        let mut r = if k == 0 { first.clone() } else { rest.clone() };
        r.extend(row);
        out.push(r);
    }
}

/// `spans` in rows of `width` columns: at spaces where it can, mid-word where a word is wider than the row.
pub fn wrap_spans(spans: &[Span], width: usize) -> Vec<Vec<Span>> {
    let width = width.max(1);
    let chars: Vec<(char, usize)> = spans.iter().enumerate().flat_map(|(k, s)| s.text.chars().map(move |c| (c, k))).collect();
    let cw = |c: char| c.width().unwrap_or(0);
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut start = 0;
    let mut used = 0;
    let mut k = 0;
    while k < chars.len() {
        let space = chars[k].0 == ' ';
        let mut e = k;
        let mut w = 0;
        while e < chars.len() && (chars[e].0 == ' ') == space {
            w += cw(chars[e].0);
            e += 1;
        }
        if used + w <= width {
            used += w;
        } else if space {
            ranges.push((start, k));
            start = e;
            used = 0;
        } else if used > 0 && w <= width {
            let mut end = k;
            while end > start && chars[end - 1].0 == ' ' {
                end -= 1;
            }
            ranges.push((start, end));
            start = k;
            used = w;
        } else {
            for (j, &(ch, _)) in chars.iter().enumerate().take(e).skip(k) {
                if used + cw(ch) > width && used > 0 {
                    ranges.push((start, j));
                    start = j;
                    used = 0;
                }
                used += cw(ch);
            }
        }
        k = e;
    }
    ranges.push((start, chars.len()));
    ranges
        .into_iter()
        .map(|(a, b)| {
            let mut row: Vec<Span> = Vec::new();
            for &(ch, s) in &chars[a..b] {
                match row.last_mut() {
                    Some(last) if last.style == spans[s].style && last.link == spans[s].link => last.text.push(ch),
                    _ => row.push(Span { text: ch.to_string(), style: spans[s].style, link: spans[s].link.clone() }),
                }
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_tints_its_changed_lines_the_whole_width() {
        let rows = render("```diff\n--- a/x\n+++ b/x\n context\n-old\n+new\n```", 30);
        let row = |t: &str| rows.iter().find(|r| r.iter().any(|s| s.text.contains(t))).unwrap();
        let bgs = |t: &str| row(t).iter().map(|s| s.style.bg).collect::<Vec<_>>();
        let added = crate::diff::background(crate::diff::Kind::Add).0.bg;
        let removed = crate::diff::background(crate::diff::Kind::Del).0.bg;
        assert!(bgs("+new").iter().all(|b| *b == added), "{:?}", row("+new"));
        assert!(bgs("-old").iter().all(|b| *b == removed));
        assert_eq!(row("+new").iter().map(|s| s.text.width()).sum::<usize>(), 30, "to the edge");
        assert!(bgs("context").iter().all(|b| *b != added && *b != removed));
        assert!(bgs("+++ b/x").iter().all(|b| *b != added), "a file header is not a change");
    }

    fn plain(rows: &[Vec<Span>]) -> Vec<String> {
        rows.iter().map(|r| r.iter().map(|s| s.text.as_str()).collect()).collect()
    }

    fn find<'a>(rows: &'a [Vec<Span>], text: &str) -> &'a Span {
        rows.iter().flatten().find(|s| s.text.contains(text)).unwrap_or_else(|| panic!("no {text:?} in {:?}", plain(rows)))
    }

    #[test]
    fn emphasis_loses_its_marks_and_keeps_its_look() {
        let rows = render("a **bold** b *it* c ~~gone~~ d ==hi== e `code` f <u>under</u> snake_case_name", 80);
        assert_eq!(plain(&rows), vec!["a bold b it c gone d hi e code f under snake_case_name"]);
        assert!(find(&rows, "bold").style.attr.has(Attr::BOLD));
        assert!(find(&rows, "it").style.attr.has(Attr::ITALIC));
        assert!(find(&rows, "gone").style.attr.has(Attr::STRIKE));
        assert!(find(&rows, "under").style.attr.has(Attr::UNDERLINE));
        assert_ne!(find(&rows, "hi").style.bg, Color::Reset);
        assert_ne!(find(&rows, "code").style.bg, Color::Reset);
        assert_ne!(find(&rows, "bold").style.fg, find(&rows, "a ").style.fg, "bold has a colour of its own");
    }

    #[test]
    fn headings_lists_quotes_and_rules_are_drawn_without_their_marks() {
        let rows = render("# Title\n## Sub\n- one\n  - two\n1. first\n- [x] done\n> quoted\n---", 20);
        let p = plain(&rows);
        assert_eq!(&p[..6], &["Title", "Sub", "• one", "  ◦ two", "1. first", "• ☑ done"]);
        assert_eq!(p[6], "▎ quoted");
        assert_eq!(p[7], "─".repeat(20));
        assert!(find(&rows, "Title").style.attr.has(Attr::BOLD));
        assert_ne!(find(&rows, "Title").style.fg, find(&rows, "Sub").style.fg);
    }

    #[test]
    fn a_link_keeps_where_it_goes_and_a_bare_url_is_one() {
        let rows = render("see [the docs](https://example.com/a_(b)) or https://x.dev/p.", 80);
        assert_eq!(plain(&rows), vec!["see the docs or https://x.dev/p."]);
        assert_eq!(find(&rows, "the docs").link.as_deref(), Some("https://example.com/a_(b)"));
        assert_eq!(find(&rows, "https://x.dev/p").link.as_deref(), Some("https://x.dev/p"));
        assert!(find(&rows, "the docs").style.attr.has(Attr::UNDERLINE));
    }

    #[test]
    fn math_loses_its_dollars_takes_a_background_and_draws_its_symbols() {
        let rows = render("area $\\pi r^2$ costs $5 and $10\n$$\n\\frac{a}{b} \\leq \\sqrt{x_1} \\cdot \\alpha\n$$", 40);
        let p = plain(&rows);
        assert_eq!(p[0], "area  π r²  costs $5 and $10");
        assert_eq!(p[1].trim(), "a/b ≤ √x₁ · α");
        assert_ne!(find(&rows, "π r²").style.bg, Color::Reset);
        assert!(rows[1].iter().all(|s| s.style.bg != Color::Reset), "a display formula's row is its background");
        assert_eq!(latex("\\mathbb{R}^n \\to \\infty, \\sin x, \\frac{x+1}{2}"), "ℝⁿ → ∞, sin x, (x+1)/2");
    }

    #[test]
    fn inline_html_and_entities_are_drawn() {
        let rows = render("<b>bold</b> <i>it</i> <a href=\"https://a.b\">link</a> H<sub>2</sub>O x<sup>2</sup> &amp; &lt;T&gt; Vec<T>", 80);
        assert_eq!(plain(&rows), vec!["bold it link H₂O x² & <T> Vec<T>"]);
        assert_eq!(find(&rows, "link").link.as_deref(), Some("https://a.b"));
        assert!(render("<p>\n<div align=\"center\">\n</div>", 20).is_empty());
    }

    #[test]
    fn a_code_block_has_its_background_and_its_syntax_coloured() {
        let rows = render("```rust\nfn main() { let s = \"hi\"; } // done\n```\n```css\n.a { color: #fff; }\n```\n```html\n<div class=\"x\">hi</div>\n```", 50);
        let p = plain(&rows);
        assert_eq!(p[0].trim_end(), " rust");
        assert!(rows.iter().filter(|r| !r.is_empty()).all(|r| r.iter().all(|s| s.style.bg != Color::Reset)), "{p:?}");
        assert!(p.iter().all(|r| r.width() == 50), "a code row fills its width");
        assert_ne!(find(&rows, "fn").style.fg, find(&rows, "\"hi\"").style.fg);
        assert_eq!(find(&rows, "// done").style.attr, Attr::ITALIC);
        assert_ne!(find(&rows, "color").style.fg, find(&rows, "#fff").style.fg);
        assert_ne!(find(&rows, "div").style.fg, find(&rows, "class").style.fg);
    }

    #[test]
    fn a_table_is_drawn_in_a_box_and_fits_its_width() {
        let rows = render("| a | bee |\n|---|:-:|\n| **x** | y |", 30);
        let p = plain(&rows);
        assert_eq!(p, vec!["┌───┬─────┐", "│ a │ bee │", "├───┼─────┤", "│ x │  y  │", "└───┴─────┘"]);
        let wide = render("| a | b |\n|---|---|\n| one two three four five six | seven eight nine ten |", 24);
        assert!(plain(&wide).iter().all(|r| r.width() <= 24), "{:?}", plain(&wide));
    }

    #[test]
    fn a_long_line_wraps_at_spaces_and_keeps_its_styles() {
        let rows = render("aaa **bbb ccc** ddd", 9);
        assert_eq!(plain(&rows), vec!["aaa bbb", "ccc ddd"]);
        assert!(rows[1][0].style.attr.has(Attr::BOLD));
    }
}
