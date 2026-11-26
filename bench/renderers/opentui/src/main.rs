//! The fixture screen on OpenTUI 0.9.7's native layer (the scene and host OpenCode's Rust client builds on),
//! driven frame by frame so each frame can be timed as the other variants are.
use std::time::{Duration, Instant};

use fixture::{Fixture, Kind};
use opentui::host::{Host, HostOptions};
use opentui::input::{Event, KeyCode};
use opentui::layout::{Edge, FlexDirection, LayoutProperty};
use opentui::native::{Node, NodeKind, Paint};
use opentui::style::{BorderStyle, Color, Sides, Span, Stylize};

const MUTED: Color = Color::rgb(128, 128, 128);
const BLUE: Color = Color::rgb(64, 96, 224);

fn span(line: &str, kind: Kind) -> Span<'_> {
    match kind {
        Kind::Text => line.into(),
        Kind::User => line.fg(Color::rgb(96, 128, 255)).bold(),
        Kind::Add => line.fg(Color::rgb(0, 160, 0)).bg(Color::rgb(16, 40, 16)),
        Kind::Del => line.fg(Color::rgb(200, 0, 0)).bg(Color::rgb(48, 16, 16)),
        Kind::Hunk => line.fg(Color::rgb(0, 160, 160)),
        Kind::Code => line.fg(MUTED),
    }
}

struct Scene {
    chat: Node,
    prompt: Node,
}

fn paint(host: &mut Host, scene: &Scene, f: &Fixture) -> opentui::Result<()> {
    let (_, h) = host.size();
    let visible = f.visible(h.saturating_sub(6) as usize);
    let mut spans = Vec::with_capacity(visible.len() * 2);
    for (i, (line, kind)) in visible.iter().enumerate() {
        if i > 0 {
            spans.push("\n".into());
        }
        spans.push(span(line, *kind));
    }
    scene.chat.set_spans(&spans)?;
    scene.prompt.set_text(&f.prompt)?;
    let draft = host.session().paint(Color::TRANSPARENT, true, 0)?;
    host.present(draft)?;
    Ok(())
}

fn run(host: &mut Host) -> opentui::Result<()> {
    let session = host.session().clone();
    let root = Node::new(&session, NodeKind::Root, 1)?;
    root.set_layout(LayoutProperty::FlexDirection(FlexDirection::Column))?;
    let boxed = |id: u32, color: Color| -> opentui::Result<Node> {
        let node = Node::new(&session, NodeKind::Box, id)?;
        node.set_layout(LayoutProperty::Padding(Edge::Horizontal, 1.into()))?;
        node.set_paint(&Paint { border: Sides::ALL, border_style: BorderStyle::Rounded, border_color: color, ..Default::default() })?;
        Ok(node)
    };
    let chat_box = boxed(2, MUTED)?;
    chat_box.insert_into(&root, 0)?;
    chat_box.set_layout(LayoutProperty::FlexGrow(1.0))?;
    let chat = Node::new(&session, NodeKind::Text, 3)?;
    chat.insert_into(&chat_box, 0)?;
    let prompt_box = boxed(4, BLUE)?;
    prompt_box.insert_into(&root, 1)?;
    prompt_box.set_layout(LayoutProperty::FixedHeight(3.into()))?;
    let prompt = Node::new(&session, NodeKind::Text, 5)?;
    prompt.insert_into(&prompt_box, 0)?;
    let status = Node::new(&session, NodeKind::Text, 6)?;
    status.insert_into(&root, 2)?;
    status.set_layout(LayoutProperty::FixedHeight(1.into()))?;
    status.set_layout(LayoutProperty::Padding(Edge::Left, 1.into()))?;

    let (w, _) = host.size();
    let mut f = Fixture::new(w as usize);
    status.set_spans(&[f.status.as_str().fg(MUTED)])?;
    let scene = Scene { chat, prompt };
    paint(host, &scene, &f)?;

    if let Some(frames) = std::env::var("BENCH_STREAM").ok().and_then(|v| v.parse::<usize>().ok()) {
        let mut times = Vec::with_capacity(frames);
        for i in 0..frames {
            f.stream(i);
            let t = Instant::now();
            // OpenTUI writes a frame off the calling thread and refuses to paint while one is in flight: the wait
            // for the last frame's output counts, since the other renderers' times include their writes.
            while !host.can_render()? {
                host.poll(Some(Instant::now() + Duration::from_micros(100)), &mut Vec::new())?;
            }
            paint(host, &scene, &f)?;
            times.push(t.elapsed().as_micros());
            std::thread::sleep(Duration::from_millis(1));
        }
        if let Ok(path) = std::env::var("BENCH_OUT") {
            let text: Vec<String> = times.iter().map(|t| t.to_string()).collect();
            let _ = std::fs::write(path, text.join("\n"));
        }
        return Ok(());
    }

    let mut events = Vec::new();
    loop {
        host.poll(None, &mut events)?;
        let mut dirty = false;
        for event in events.drain(..) {
            match event {
                Event::Terminate => return Ok(()),
                Event::Key(key) if key.matches("ctrl+c") || key.code == KeyCode::Escape => return Ok(()),
                Event::Key(key) => match key.code {
                    KeyCode::Char(c) => {
                        f.prompt.push(c);
                        dirty = true;
                    }
                    KeyCode::Backspace => {
                        f.prompt.pop();
                        dirty = true;
                    }
                    KeyCode::Enter => {
                        let text = std::mem::take(&mut f.prompt);
                        f.lines.push((format!("> {text}"), Kind::User));
                        dirty = true;
                    }
                    _ => {}
                },
                Event::Paste(text) => {
                    f.prompt.push_str(&text);
                    dirty = true;
                }
                _ => dirty = true,
            }
        }
        if dirty && host.can_render()? {
            paint(host, &scene, &f)?;
        }
    }
}

fn main() -> std::process::ExitCode {
    let result = Host::start(HostOptions::default()).and_then(|mut host| {
        let result = run(&mut host);
        let closed = host.shutdown();
        result.and(closed)
    });
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
