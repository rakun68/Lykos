//! `lykos-tui`: Lykos's terminal interface (P5 #37). It draws at once, connects to the engine server on a
//! thread (starting one when none runs), and from then on waits on one channel for keys, server events and
//! request replies. It sleeps while nothing on screen moves and draws only after a change.
mod app;
mod theme;
mod view;
mod wrap;

use std::collections::BTreeMap;
use std::io;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{Event as TermEvent, MouseEventKind};
use lykos_client::{Client, Event, EventData, Options, SessionStatus, SessionSummary, Update};
use lykos_term::{Terminal, TerminalGuard};
use serde_json::{json, Value};

use app::{Action, App, Link};

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
}

struct Args {
    cwd: String,
    model: Option<String>,
    trust: bool,
}

const HELP: &str = "lykos-tui [--cwd DIR] [--model PROVIDER/MODEL] [--trust-workspace]\n\
  --cwd DIR            the workspace (default: the current directory)\n\
  --model M            the model for new sessions (default: the config's)\n\
  --trust-workspace    start sessions in a workspace not yet trusted\n";

fn args() -> Result<Args, String> {
    let mut out = Args { cwd: String::new(), model: None, trust: false };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--cwd" => out.cwd = it.next().ok_or("--cwd needs a directory")?,
            "--model" => out.model = Some(it.next().ok_or("--model needs a model")?),
            "--trust-workspace" => out.trust = true,
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
    let guard = TerminalGuard::enter()?;
    let mut term = Terminal::new(io::stdout(), w, h);
    let mut app = App::new(args.cwd.clone());
    if std::env::var_os("BENCH_STREAM").is_some() {
        bench(&mut app, &mut term);
        drop(guard);
        return Ok(());
    }
    term.draw(|b| view::draw(&app, b))?;

    let (tx, rx) = mpsc::channel::<Msg>();
    let input = tx.clone();
    thread::Builder::new().name("lykos-input".into()).spawn(move || {
        while let Ok(ev) = crossterm::event::read() {
            if input.send(Msg::Input(ev)).is_err() {
                return;
            }
        }
    })?;
    let (act_tx, act_rx) = mpsc::channel::<Action>();
    let opts = Options::from_env("lykos-tui")?;
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
            actions.extend(handle(&mut app, msg, term.size().1 as usize));
        }
        if app.animating() && last_tick.elapsed() >= TICK {
            app.on_tick(Instant::now());
            last_tick = Instant::now();
        }
        for a in actions {
            if a == Action::Quit {
                quit = true;
            } else {
                let _ = act_tx.send(a);
            }
        }
        if quit {
            break;
        }
        term.draw(|b| view::draw(&app, b))?;
    }
    drop(guard);
    Ok(())
}

fn handle(app: &mut App, msg: Msg, height: usize) -> Vec<Action> {
    match msg {
        Msg::Input(TermEvent::Key(k)) => app.on_key(k, Instant::now(), (height / 2).max(1)),
        Msg::Input(TermEvent::Paste(text)) => {
            app.on_paste(&text);
            Vec::new()
        }
        Msg::Input(TermEvent::Mouse(m)) => {
            match m.kind {
                MouseEventKind::ScrollUp => app.on_scroll(true, 3),
                MouseEventKind::ScrollDown => app.on_scroll(false, 3),
                _ => {}
            }
            Vec::new()
        }
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
    }
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
            Action::Quit => return,
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
