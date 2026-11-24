//! `lykos-tui`: Lykos's terminal interface (P5 #37). It draws at once, connects to the engine server on a
//! thread (starting one when none runs), and from then on waits on one channel for keys, server events and
//! request replies. It sleeps while nothing on screen moves and draws only after a change.
mod app;
mod diff;
mod diffview;
mod editor;
mod history;
mod keymap;
mod menu;
mod mini;
mod paste;
mod prefs;
mod request;
mod sidebar;
mod stash;
mod tabs;
mod theme;
mod transcript;
mod view;
mod wrap;

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::Event as TermEvent;
use lykos_client::{Client, Event, EventData, Options, SessionOptions, SessionStatus, SessionSummary, Update};
use lykos_term::{Buffer, Style, Terminal, TerminalGuard};
use serde_json::{json, Value};

use app::{Action, App, Link, Then};

/// One frame of the spinner.
const TICK: Duration = Duration::from_millis(80);

enum Msg {
    Input(TermEvent),
    Server(Update),
    Connected,
    ConnectFailed(String),
    Started(String),
    /// A request failed; for a prompt, its text, to put back.
    Failed(String, Option<String>),
    Files(Vec<String>),
    /// A side question and its answer.
    Aside(String, Result<String, String>),
    /// `config.keybinds`' answer.
    Keybinds(Result<Value, String>),
    /// `session.options`' answer.
    Options(Result<SessionOptions, String>),
    /// An `Action::Call`'s answer.
    Reply(Then, Result<Value, String>),
}

/// The input thread reads the terminal unless `pause` is set, and says so in `parked`: the external editor owns
/// the terminal meanwhile. It polls a fifth of a second at a time so it can see the flag.
struct Input {
    pause: AtomicBool,
    parked: AtomicBool,
}

const INPUT_POLL: Duration = Duration::from_millis(200);

struct Args {
    cwd: String,
    model: Option<String>,
    trust: bool,
    mini: bool,
    session: Option<String>,
}

const HELP: &str = "lykos-tui [--cwd DIR] [--model PROVIDER/MODEL] [--trust-workspace] [--mini] [-s ID]\n\
  --cwd DIR            the workspace (default: the current directory)\n\
  --model M            the model for new sessions (default: the config's)\n\
  --trust-workspace    start sessions in a workspace not yet trusted\n\
  --mini               no full screen: the transcript goes into the terminal's scrollback\n\
  -s, --session ID     resume the ledger session ID\n";

fn args() -> Result<Args, String> {
    let mut out = Args { cwd: String::new(), model: None, trust: false, mini: false, session: None };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--cwd" => out.cwd = it.next().ok_or("--cwd needs a directory")?,
            "--model" => out.model = Some(it.next().ok_or("--model needs a model")?),
            "--trust-workspace" => out.trust = true,
            "--mini" => out.mini = true,
            "-s" | "--session" => out.session = Some(it.next().ok_or("--session needs a session id")?),
            "-h" | "--help" => return Err(HELP.into()),
            "-V" | "--version" => return Err(format!("lykos-tui {}\n", env!("CARGO_PKG_VERSION"))),
            other => return Err(format!("unknown argument: {other}\n{HELP}")),
        }
    }
    if out.cwd.is_empty() {
        out.cwd = std::env::current_dir().map_err(|e| e.to_string())?.display().to_string();
    }
    Ok(out)
}

fn main() {
    let args = match args() {
        Ok(a) => a,
        Err(text) => {
            print!("{text}");
            std::process::exit(if text.starts_with("unknown") || text.contains("needs") { 2 } else { 0 });
        }
    };
    if let Err(e) = run(args) {
        eprintln!("lykos-tui: {e}");
        std::process::exit(1);
    }
    // The input thread is blocked reading the terminal; exit rather than wait for it.
    std::process::exit(0);
}

fn run(args: Args) -> io::Result<()> {
    let (w, h) = crossterm::terminal::size()?;
    let guard = if args.mini { TerminalGuard::enter_inline()? } else { TerminalGuard::enter()? };
    let mut term = if args.mini {
        let row = crossterm::cursor::position().map_or(h.saturating_sub(1), |(_, y)| y);
        Terminal::inline(io::stdout(), w, h, row, 6)
    } else {
        Terminal::new(io::stdout(), w, h)
    };
    let mut mini = args.mini.then(mini::Mini::default);
    let mut app = App::new(args.cwd.clone());
    app.mini = args.mini;
    app.resume = args.session.clone();
    app.history = history::History::load(Some(PathBuf::from(&args.cwd).join(".lykos").join("history.json")));
    app.stash = stash::Stash::load(state_dir().map(|d| d.join("prompt-stash.jsonl")));
    app.prefs = prefs::Prefs::load(state_dir().map(|d| d.join("state.json")));
    if let Some(name) = app.prefs.theme.clone() {
        theme::set(&name);
    }
    app.input_cols = view::input_cols(&app, w);
    if std::env::var_os("BENCH_STREAM").is_some() {
        bench(&mut app, &mut term);
        drop(guard);
        return Ok(());
    }
    if mini.is_some() {
        entry_splash(&mut term, &app.cwd);
    }
    frame(&mut term, &app, &mut mini)?;

    let (tx, rx) = mpsc::channel::<Msg>();
    let input = Arc::new(Input { pause: AtomicBool::new(false), parked: AtomicBool::new(false) });
    let reader = (tx.clone(), input.clone());
    thread::Builder::new().name("lykos-input".into()).spawn(move || {
        let (tx, flags) = reader;
        let send = |evs: Vec<TermEvent>| evs.into_iter().all(|ev| tx.send(Msg::Input(ev)).is_ok());
        loop {
            if flags.pause.load(Ordering::SeqCst) {
                flags.parked.store(true, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            flags.parked.store(false, Ordering::SeqCst);
            match crossterm::event::poll(INPUT_POLL) {
                Ok(false) => continue,
                Ok(true) if flags.pause.load(Ordering::SeqCst) => continue,
                Ok(true) => {}
                Err(_) => return,
            }
            let Ok(ev) = crossterm::event::read() else { return };
            let events = if cfg!(windows) { paste::gather(ev, paste::waiting) } else { Ok(vec![ev]) };
            let Ok(evs) = events else { return };
            if !send(evs) {
                return;
            }
        }
    })?;
    let (act_tx, act_rx) = mpsc::channel::<Action>();
    let opts = Options::from_env("lykos-tui")?;
    let side = (opts.clone(), tx.clone(), args.cwd.clone());
    thread::Builder::new().name("lykos-requests".into()).spawn(move || requests(opts, args, act_rx, tx))?;

    let mut last_tick = Instant::now();
    loop {
        let first = if app.animating() {
            match rx.recv_timeout(TICK.saturating_sub(last_tick.elapsed())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            }
        };
        let mut actions = Vec::new();
        let mut quit = false;
        for msg in first.into_iter().chain(std::iter::from_fn(|| rx.try_recv().ok())) {
            if let Msg::Input(TermEvent::Resize(w, h)) = msg {
                term.resize(w, h);
                continue;
            }
            app.input_cols = view::input_cols(&app, term.screen().0);
            actions.extend(handle(&mut app, msg, term.size().1 as usize));
        }
        if app.animating() && last_tick.elapsed() >= TICK {
            app.on_tick(Instant::now());
            last_tick = Instant::now();
        }
        for a in actions {
            match a {
                Action::Quit => quit = true,
                Action::Copy(text) => copy(&mut term, &text),
                Action::ListFiles => {
                    let (tx, cwd) = (side.1.clone(), side.2.clone());
                    let _ = thread::Builder::new().name("lykos-files".into()).spawn(move || {
                        let _ = tx.send(Msg::Files(list_files(&cwd)));
                    });
                }
                Action::Aside { session, text } => {
                    let (opts, tx) = (side.0.clone(), side.1.clone());
                    let _ = thread::Builder::new().name("lykos-aside".into()).spawn(move || {
                        let answer = Client::connect(opts)
                            .and_then(|mut c| c.request("session.aside", json!({ "session": session, "text": text })))
                            .map(|v| v["answer"].as_str().unwrap_or_default().to_string())
                            .map_err(|e| e.to_string());
                        let _ = tx.send(Msg::Aside(text, answer));
                    });
                }
                Action::Editor(text) => {
                    let (out, err) = external_editor(&input, &text);
                    app.edited_externally(out, err);
                    term.invalidate();
                }
                a => {
                    let _ = act_tx.send(a);
                }
            }
        }
        if quit {
            break;
        }
        frame(&mut term, &app, &mut mini)?;
    }
    if mini.is_some() {
        frame(&mut term, &app, &mut mini)?;
        term.leave()?;
        exit_splash(&mut term, &app);
    }
    drop(guard);
    Ok(())
}

/// A frame: the whole screen, or in mini mode the rows done changing into the scrollback and the footer under them.
fn frame(term: &mut Terminal<io::Stdout>, app: &App, mini: &mut Option<mini::Mini>) -> io::Result<()> {
    let Some(m) = mini else {
        term.draw(|b| view::draw(app, b))?;
        return Ok(());
    };
    let (w, h) = term.screen();
    let pad = view::pad(w);
    let (print, live) = m.take(app, w.saturating_sub(2 * pad) as usize);
    if !print.is_empty() {
        let mut rows = Buffer::new(w, print.len() as u16);
        for (i, row) in print.iter().enumerate() {
            view::paint_row(&mut rows, pad, i as u16, w.saturating_sub(2 * pad), row);
        }
        term.print_above(&rows);
    }
    term.set_footer(view::mini_height(app, w, h, live.len()));
    term.draw(|b| view::draw_mini(app, b, &live, h))?;
    Ok(())
}

/// `mini/splash.ts` `entrySplash`: a blank row, then the name, the version and the directory.
fn entry_splash(term: &mut Terminal<io::Stdout>, cwd: &str) {
    let w = term.screen().0;
    let mut rows = Buffer::new(w, 2);
    let col = rows.text(0, 1, w, "▪ lykos mini", Style::fg(theme::c().accent));
    rows.text(col, 1, w.saturating_sub(col), &format!(" v{} · {cwd}", env!("CARGO_PKG_VERSION")), theme::muted());
    term.print_above(&rows);
}

/// `mini/splash.ts` `buildExit`: the session's title and the command that continues it.
fn exit_splash(term: &mut Terminal<io::Stdout>, app: &App) {
    let Some(s) = app.current() else { return };
    let Some(id) = &s.summary.ledger_session_id else { return };
    let title = s.summary.title.clone().unwrap_or_else(|| "New session".into());
    let w = term.writer();
    let _ = write!(w, "\r\n  Session  \x1b[1m{title}\x1b[0m\r\n  Continue \x1b[1mlykos-tui --mini -s {id}\x1b[0m\r\n");
    let _ = w.flush();
}

fn handle(app: &mut App, msg: Msg, height: usize) -> Vec<Action> {
    match msg {
        Msg::Input(TermEvent::Key(k)) => app.on_key(k, Instant::now(), (height / 2).max(1)),
        Msg::Input(TermEvent::Paste(text)) => app.on_paste(&text),
        Msg::Input(TermEvent::Mouse(m)) => app.on_mouse(m, Instant::now()),
        Msg::Input(_) => Vec::new(),
        Msg::Server(Update::Event(e)) => app.on_event(&e),
        Msg::Server(Update::Disconnected(m)) => {
            app.link = Link::Lost(format!("lost the engine server ({m}); reconnecting"));
            Vec::new()
        }
        Msg::Server(Update::Reconnected) | Msg::Connected => app.connected(),
        Msg::ConnectFailed(m) => {
            app.link = Link::Failed(format!("cannot reach the engine server: {m}"));
            Vec::new()
        }
        Msg::Started(id) => app.started(id),
        Msg::Failed(m, text) => {
            app.failed(m, text);
            Vec::new()
        }
        Msg::Files(files) => app.on_files(files),
        Msg::Aside(question, answer) => {
            app.on_aside(question, answer);
            Vec::new()
        }
        Msg::Keybinds(result) => {
            app.on_keybinds(result);
            Vec::new()
        }
        Msg::Options(result) => {
            app.on_options(result);
            Vec::new()
        }
        Msg::Reply(then, result) => app.on_reply(then, result),
    }
}

/// Where the TUI keeps what is the user's, not the workspace's: `LYKOS_TUI_DIR`, or `~/.lykos/tui`.
fn state_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("LYKOS_TUI_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|v| !v.is_empty())?;
    Some(PathBuf::from(home).join(".lykos").join("tui"))
}

/// OSC 52: the terminal puts the text on the system clipboard, over SSH too.
fn copy(term: &mut Terminal<io::Stdout>, text: &str) {
    let w = term.writer();
    let _ = write!(w, "\x1b]52;c;{}\x07", base64(text.as_bytes()));
    let _ = w.flush();
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The files `@` completes: git's tracked and untracked-but-not-ignored files, as OpenCode lists them through
/// ripgrep's ignore rules; outside a repository, a walk that skips dot directories, capped at 20,000.
fn list_files(cwd: &str) -> Vec<String> {
    let git = std::process::Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard"])
        .current_dir(cwd)
        .stderr(std::process::Stdio::null())
        .output();
    if let Some(out) = git.ok().filter(|o| o.status.success()) {
        return String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect();
    }
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(cwd)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(cwd) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= 20_000 {
                    return out;
                }
            }
        }
    }
    out
}

/// OpenCode `prompt.editor`: the prompt goes to `$VISUAL` or `$EDITOR` in a file, and the file comes back as the
/// prompt. The TUI leaves the screen and stops reading keys while the editor runs.
fn external_editor(input: &Input, text: &str) -> (Option<String>, Option<String>) {
    let Some(cmd) = ["VISUAL", "EDITOR"].iter().find_map(|v| std::env::var(v).ok().filter(|s| !s.trim().is_empty())) else {
        return (None, Some("set $VISUAL or $EDITOR to open the prompt in an editor".into()));
    };
    let path = std::env::temp_dir().join(format!("lykos-prompt-{}.md", std::process::id()));
    if let Err(e) = std::fs::write(&path, text) {
        return (None, Some(format!("cannot write {}: {e}", path.display())));
    }
    input.pause.store(true, Ordering::SeqCst);
    let waited = Instant::now();
    while !input.parked.load(Ordering::SeqCst) && waited.elapsed() < INPUT_POLL * 3 {
        thread::sleep(Duration::from_millis(5));
    }
    lykos_term::suspend();
    let mut parts = cmd.split_whitespace();
    let status = std::process::Command::new(parts.next().unwrap_or_default()).args(parts).arg(&path).status();
    let _ = lykos_term::resume();
    input.pause.store(false, Ordering::SeqCst);
    let result = match status {
        Ok(s) if s.success() => (std::fs::read_to_string(&path).ok(), None),
        Ok(s) => (None, Some(format!("the editor exited with {s}"))),
        Err(e) => (None, Some(format!("cannot run {cmd}: {e}"))),
    };
    let _ = std::fs::remove_file(&path);
    result
}

/// The request thread: connects (starting a server when none runs), follows events, then sends each action.
fn requests(opts: Options, args: Args, actions: Receiver<Action>, tx: Sender<Msg>) {
    let mut client = match Client::connect(opts) {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Msg::ConnectFailed(e.to_string()));
            return;
        }
    };
    let events = client.subscribe(BTreeMap::new());
    let forward = tx.clone();
    let _ = thread::Builder::new().name("lykos-events-forward".into()).spawn(move || {
        for u in events.rx.iter() {
            if forward.send(Msg::Server(u)).is_err() {
                events.stop();
                return;
            }
        }
    });
    let _ = tx.send(Msg::Connected);
    let keybinds = client.request("config.keybinds", json!({ "cwd": args.cwd })).map_err(|e| e.to_string());
    let _ = tx.send(Msg::Keybinds(keybinds));
    for action in actions {
        let reply = match &action {
            Action::Start => {
                let mut p = json!({ "cwd": args.cwd, "origin": "tui" });
                if let Some(m) = &args.model {
                    p["model"] = Value::String(m.clone());
                }
                if args.trust {
                    p["trust"] = Value::Bool(true);
                }
                client.request("session.start", p).map(|v| Msg::Started(v["id"].as_str().unwrap_or_default().to_string()))
            }
            Action::Prompt { session, text } => client.request("session.prompt", json!({ "session": session, "text": text })).map(|_| Msg::Connected),
            Action::Interrupt { session } => client.request("session.interrupt", json!({ "session": session })).map(|_| Msg::Connected),
            Action::Answer { session, request_id, answer } => client.request("session.answer", json!({ "session": session, "requestId": request_id, "answer": answer })).map(|_| Msg::Connected),
            Action::Options { session } => Ok(Msg::Options(
                client.request("session.options", json!({ "session": session })).map_err(|e| e.to_string()).and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string())),
            )),
            Action::Call { method, params, then } => {
                let mut params = params.clone();
                if *method == "session.start" && args.trust {
                    params["trust"] = Value::Bool(true);
                }
                Ok(Msg::Reply(then.clone(), client.request(method, params).map_err(|e| e.to_string())))
            }
            Action::Quit => return,
            // The main loop does these itself.
            Action::Aside { .. } | Action::ListFiles | Action::Copy(_) | Action::Editor(_) => continue,
        };
        let msg = match reply {
            Ok(Msg::Connected) => continue,
            Ok(m) => m,
            Err(e) => Msg::Failed(e.to_string(), if let Action::Prompt { text, .. } = action { Some(text) } else { None }),
        };
        if tx.send(msg).is_err() {
            return;
        }
    }
}

/// `BENCH_STREAM=<frames>`: a session's reply streams in, a word per frame, and each frame's paint, diff and
/// write is timed; the times go to `BENCH_OUT` in microseconds, one per line (`scripts/tui/measure.mjs`).
fn bench(app: &mut App, term: &mut Terminal<io::Stdout>) {
    let frames: usize = std::env::var("BENCH_STREAM").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    app.connected();
    app.started("bench".into());
    let mut seq = 0;
    let mut push = |app: &mut App, data: EventData| {
        seq += 1;
        app.on_event(&Event { event: String::new(), session: "bench".into(), seq, data });
    };
    let summary = SessionSummary {
        id: "bench".into(),
        cwd: app.cwd.clone(),
        status: SessionStatus::Running,
        model: "bench/model".into(),
        title: Some("Benchmark".into()),
        started_at: String::new(),
        origin: "tui".into(),
        ledger_session_id: None,
    };
    // `BENCH_SCROLL=<messages>`: a finished transcript that long, then each frame scrolls it `BENCH_ROWS` rows (three,
    // a wheel step), up for a hundred frames and down for a hundred (P5 #44, `scripts/tui/scroll-measure.mjs`).
    if let Some(messages) = std::env::var("BENCH_SCROLL").ok().and_then(|v| v.parse::<usize>().ok()) {
        let mut summary = summary;
        summary.status = SessionStatus::Idle;
        push(app, EventData::SessionStatus { session: summary });
        for i in 0..messages / 2 {
            push(app, EventData::MessageUser { text: format!("Question {i}: where does the time go in frame {i}?") });
            push(app, EventData::MessageDelta { text: format!("Answer {i}: the frame is drawn into a buffer of cells, diffed against the last one, and written once.") });
            push(app, EventData::MessageEnd);
        }
        let mut times = Vec::with_capacity(frames);
        let rows = std::env::var("BENCH_ROWS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
        for i in 0..frames {
            app.on_scroll(i % 200 < 100, rows);
            let t = Instant::now();
            let _ = term.draw(|b| view::draw(app, b));
            times.push(t.elapsed().as_micros());
        }
        if let Ok(path) = std::env::var("BENCH_OUT") {
            let text: Vec<String> = times.iter().map(|t| t.to_string()).collect();
            let _ = std::fs::write(path, text.join("\n"));
        }
        return;
    }
    // `BENCH_DIFF=<lines>`: the diff viewer full screen on one file's patch that many lines long, a change on each
    // line; the first frame lays it out, then each frame scrolls it `BENCH_ROWS` rows, down for a hundred frames and
    // up for a hundred (P5 #46, `scripts/tui/scroll-measure.mjs --diff`).
    if let Some(lines) = std::env::var("BENCH_DIFF").ok().and_then(|v| v.parse::<usize>().ok()) {
        let mut patch = format!("diff --git a/big.rs b/big.rs
--- a/big.rs
+++ b/big.rs
@@ -1,{0} +1,{0} @@
", lines / 2);
        for i in 0..lines / 2 {
            patch.push_str(&format!("-    let value_{i} = compute(input, {i}); // the old line
+    let value_{i} = compute(input, {i} + 1); // the new line
"));
        }
        app.open_diff();
        app.on_reply(app::Then::Diff, Ok(serde_json::json!({ "base": "HEAD", "branch": "main", "files": [{ "file": "big.rs", "status": "modified", "additions": lines / 2, "deletions": lines / 2, "patch": patch }] })));
        if let Some(v) = app.diff.as_mut() {
            v.fullscreen = true;
        }
        let rows = std::env::var("BENCH_ROWS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
        let mut times = Vec::with_capacity(frames + 1);
        for i in 0..=frames {
            if i > 0 {
                if let Some(v) = app.diff.as_mut() {
                    v.scroll = if (i - 1) % 200 < 100 { v.scroll + rows } else { v.scroll.saturating_sub(rows) };
                }
            }
            let t = Instant::now();
            let _ = term.draw(|b| view::draw(app, b));
            times.push(t.elapsed().as_micros());
        }
        if let Ok(path) = std::env::var("BENCH_OUT") {
            let text: Vec<String> = times.iter().map(|t| t.to_string()).collect();
            let _ = std::fs::write(path, text.join("
"));
        }
        return;
    }
    push(app, EventData::SessionStatus { session: summary });
    push(app, EventData::MessageUser { text: "Explain the renderer and show where each frame's time goes.".into() });
    let words = ["the", "frame", "is", "drawn", "into", "a", "buffer", "of", "cells,", "diffed", "against", "the", "last,", "and", "written", "once."];
    let mut times = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut text = format!("{} ", words[i % words.len()]);
        if i % 40 == 39 {
            text.push_str("\n\n");
        }
        push(app, EventData::MessageDelta { text });
        app.on_tick(Instant::now());
        let t = Instant::now();
        let _ = term.draw(|b| view::draw(app, b));
        times.push(t.elapsed().as_micros());
        thread::sleep(Duration::from_millis(1));
    }
    if let Ok(path) = std::env::var("BENCH_OUT") {
        let text: Vec<String> = times.iter().map(|t| t.to_string()).collect();
        let _ = std::fs::write(path, text.join("\n"));
    }
}
