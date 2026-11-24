//! `lykos-tui --mini` (P5 #44), as OpenCode's `opencode mini` (`mini/runtime.lifecycle.ts`, `mini/scrollback.writer.tsx`):
//! no alternate screen. The transcript goes into the terminal's own scrollback a row at a time, once the row is done
//! changing, and a footer under it holds what still changes and the prompt.
use lykos_client::Item;

use crate::app::App;
use crate::transcript::{self, Row};

/// What is already in the scrollback: the items printed whole, and the rows printed of the next one.
#[derive(Debug, Default)]
pub struct Mini {
    session: Option<String>,
    items: usize,
    partial: usize,
}

impl Mini {
    /// The rows to print now, and the rows still changing, for the footer.
    pub fn take(&mut self, app: &App, width: usize) -> (Vec<Row>, Vec<Row>) {
        let Some(s) = app.current() else { return (Vec::new(), Vec::new()) };
        // Another session, or one rebuilt shorter (an undo): print from where it now stands.
        if self.session.as_deref() != Some(s.summary.id.as_str()) {
            self.session = Some(s.summary.id.clone());
            (self.items, self.partial) = (0, 0);
        }
        if s.items.len() < self.items {
            (self.items, self.partial) = (s.items.len(), 0);
        }
        let lay = transcript::layout(&app.layout_cache, s, app.look(), width, app.tick, None);
        let (mut print, mut live) = (Vec::new(), Vec::new());
        let mut printing = true;
        for (_, b) in lay.blocks() {
            if b.last < self.items {
                continue;
            }
            let from = self.partial.min(b.rows.len());
            // A prompt is done once sent.
            let done = b.done || (b.leaf && matches!(s.items.get(b.first), Some(Item::User(_) | Item::Followup(_) | Item::System(_))));
            if printing && done {
                print.extend_from_slice(&b.rows[from..]);
                (self.items, self.partial) = (b.last + 1, 0);
                continue;
            }
            // An answer streaming in: every row before its last line of text is done.
            if printing && b.leaf {
                let hold = b.rows.iter().rposition(|r| !r.text.trim().is_empty()).unwrap_or(0).max(from);
                print.extend_from_slice(&b.rows[from..hold]);
                self.partial = hold;
                live.extend_from_slice(&b.rows[hold..]);
            } else {
                live.extend_from_slice(&b.rows[if printing { from } else { 0 }..]);
            }
            printing = false;
        }
        (print, live)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lykos_client::{Event, EventData, SessionStatus, SessionSummary};

    fn status(status: SessionStatus) -> EventData {
        let session = SessionSummary {
            id: "s1".into(),
            cwd: "/w".into(),
            status,
            model: "m".into(),
            title: None,
            started_at: String::new(),
            origin: "tui".into(),
            ledger_session_id: None,
        };
        EventData::SessionStatus { session }
    }

    fn texts(rows: &[Row]) -> Vec<String> {
        rows.iter().map(|r| r.text.clone()).filter(|t| !t.trim().is_empty()).collect()
    }

    #[test]
    fn rows_print_once_when_done_and_the_streaming_one_waits_in_the_footer() {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        let mut seq = 1;
        let mut ev = |app: &mut App, data| {
            app.on_event(&Event { event: String::new(), session: "s1".into(), seq, data });
            seq += 1;
        };
        let mut m = Mini::default();
        ev(&mut app, status(SessionStatus::Running));
        ev(&mut app, EventData::MessageUser { text: "go".into() });
        ev(&mut app, EventData::MessageDelta { text: "line one\n\nline".into() });
        let (print, live) = m.take(&app, 40);
        assert_eq!(texts(&print), ["go", "line one"]);
        assert_eq!(texts(&live), ["line"]);
        ev(&mut app, EventData::MessageDelta { text: " two".into() });
        let (print, live) = m.take(&app, 40);
        assert_eq!(texts(&print), Vec::<String>::new(), "nothing twice");
        assert_eq!(texts(&live), ["line two"]);
        ev(&mut app, EventData::ToolStart { tool_id: "t".into(), name: "bash".into(), summary: "ls".into(), args: serde_json::Value::Null });
        let (print, live) = m.take(&app, 40);
        assert_eq!(texts(&print), ["line two"], "an item after it: the answer is done");
        assert_eq!(texts(&live), ["⠋ Running command…"], "the running group stays in the footer");
        ev(&mut app, EventData::ToolEnd { tool_id: "t".into(), name: "bash".into(), ok: true, preview: None, diff: None });
        ev(&mut app, status(SessionStatus::Idle));
        let (print, live) = m.take(&app, 40);
        assert_eq!((texts(&print), texts(&live), app.current().unwrap().summary.status), (vec!["+ 1 command".to_string()], vec![], SessionStatus::Idle), "the turn ended: everything is printed");
        assert_eq!(m.take(&app, 40).0.len(), 0);
    }
}
