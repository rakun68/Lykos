//! Find the user's engine server or start one, send requests, and follow events on a second connection that
//! reconnects and resubscribes after the last seq it saw. Two connections because a synchronous Windows pipe
//! handle serializes reads and writes: one blocked reading events would hold every request behind it.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::address::{engine_dir, engine_path, read_key};
use crate::conn::{Conn, Error, Result};
use crate::protocol::{Event, Welcome, PROTOCOL_VERSION};

#[derive(Clone, Debug)]
pub struct Options {
    pub dir: PathBuf,
    /// The command that starts a server: `LYKOS_SERVE_CMD` (a JSON array), else `lykos serve`.
    pub serve: Vec<String>,
    pub name: String,
    pub protocol: u32,
    /// How long a started server has to begin listening.
    pub start_timeout: Duration,
}

impl Options {
    pub fn from_env(name: &str) -> std::io::Result<Options> {
        let serve = std::env::var("LYKOS_SERVE_CMD")
            .ok()
            .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    // `lykos` is an npm shim, a .cmd file `CreateProcess` does not run on its own.
                    vec!["cmd".into(), "/d".into(), "/c".into(), "lykos".into(), "serve".into()]
                } else {
                    vec!["lykos".into(), "serve".into()]
                }
            });
        Ok(Options { dir: engine_dir()?, serve, name: name.into(), protocol: PROTOCOL_VERSION, start_timeout: Duration::from_secs(20) })
    }
}

/// A connection that works now, or why not: `Absent` means start one.
fn try_connect(opts: &Options) -> Result<Option<(Conn, Welcome)>> {
    let key = match read_key(&opts.dir) {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    match Conn::open(&engine_path(&opts.dir), &key, &opts.name, opts.protocol) {
        Ok(c) => Ok(Some(c)),
        Err(Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Whether a server answers now, without starting one: tests that wait for one to stop.
pub fn try_connect_only(opts: &Options) -> Option<Welcome> {
    try_connect(opts).ok().flatten().map(|(_, w)| w)
}

/// Starts `lykos serve` outside this process's console and process group, so it outlives the client.
fn start_server(opts: &Options) -> Result<()> {
    let mut cmd = Command::new(&opts.serve[0]);
    cmd.args(&opts.serve[1..]).env("LYKOS_ENGINE_DIR", &opts.dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: not on the client's (pseudo)console, so closing it spares the server.
        cmd.creation_flags(0x0000_0200 | 0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()?;
    Ok(())
}

/// Connects, starting a server when none answers. Returns whether this call started it.
pub fn connect_or_start(opts: &Options) -> Result<(Conn, Welcome, bool)> {
    if let Some((c, w)) = try_connect(opts)? {
        return Ok((c, w, false));
    }
    start_server(opts)?;
    let deadline = Instant::now() + opts.start_timeout;
    loop {
        if let Some((c, w)) = try_connect(opts)? {
            return Ok((c, w, true));
        }
        if Instant::now() > deadline {
            return Err(Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("no engine server answered within {:?} of starting one", opts.start_timeout))));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub struct Client {
    opts: Options,
    conn: Conn,
    pub welcome: Welcome,
    pub started: bool,
    next_id: u64,
}

impl Client {
    pub fn connect(opts: Options) -> Result<Client> {
        let (conn, welcome, started) = connect_or_start(&opts)?;
        Ok(Client { opts, conn, welcome, started, next_id: 1 })
    }

    /// One request and its response. The request connection never subscribes, so nothing else arrives on it.
    ///
    /// A connection that broke (the server restarted, or exited idle and a new one started) is replaced: a request
    /// whose write failed never reached the server and is sent again on the new connection. One whose write went
    /// through and whose answer was lost is not resent, since it may have run: the caller sees the error, and the
    /// next request goes out on a new connection.
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "id": id, "method": method, "params": params });
        if let Err(e) = self.conn.send(&msg) {
            if !broken(&e) {
                return Err(e);
            }
            self.reconnect()?;
            self.conn.send(&msg)?;
        }
        match self.answer(id) {
            Err(e) if broken(&e) => {
                // Best effort: if no server answers now, the next request tries again.
                let _ = self.reconnect();
                Err(e)
            }
            other => other,
        }
    }

    fn reconnect(&mut self) -> Result<()> {
        let (conn, welcome, started) = connect_or_start(&self.opts)?;
        self.conn = conn;
        self.welcome = welcome;
        self.started |= started;
        Ok(())
    }

    fn answer(&mut self, id: u64) -> Result<Value> {
        loop {
            let v = self.conn.recv()?.ok_or(Error::Closed)?;
            if v["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(m) = v["error"]["message"].as_str() {
                return Err(Error::Server(m.to_string()));
            }
            return Ok(v["result"].clone());
        }
    }

    /// Follows every session's events from `after` on, on a thread of its own.
    pub fn subscribe(&self, after: BTreeMap<String, u64>) -> Events {
        Events::start(self.opts.clone(), after)
    }
}

/// Whether an error means the connection is gone, as opposed to the server refusing the request.
fn broken(e: &Error) -> bool {
    matches!(e, Error::Io(_) | Error::Closed)
}

/// What the event thread hands the UI.
#[derive(Debug)]
pub enum Update {
    Event(Event),
    /// The events connection dropped; the thread is reconnecting.
    Disconnected(String),
    /// Resubscribed; the replay of what was missed follows as ordinary events.
    Reconnected,
}

pub struct Events {
    pub rx: Receiver<Update>,
    stop: Arc<AtomicBool>,
}

impl Events {
    fn start(opts: Options, after: BTreeMap<String, u64>) -> Events {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(after));
        let flag = stop.clone();
        thread::Builder::new()
            .name("lykos-events".into())
            .spawn(move || follow(opts, seen, tx, flag))
            .expect("spawn the events thread");
        Events { rx, stop }
    }

    /// Stops reconnecting. The thread ends at its next event or failed connect.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn follow(opts: Options, seen: Arc<Mutex<BTreeMap<String, u64>>>, tx: Sender<Update>, stop: Arc<AtomicBool>) {
    let mut first = true;
    let mut backoff = Duration::from_millis(50);
    while !stop.load(Ordering::Relaxed) {
        let result = (|| -> Result<()> {
            let (mut conn, _, _) = connect_or_start(&opts)?;
            let after = seen.lock().unwrap().clone();
            conn.send(&json!({ "id": 1, "method": "subscribe", "params": { "after": after } }))?;
            if !first && tx.send(Update::Reconnected).is_err() {
                return Ok(());
            }
            first = false;
            backoff = Duration::from_millis(50);
            loop {
                let Some(v) = conn.recv()? else { return Err(Error::Closed) };
                if v.get("event").is_none() {
                    continue;
                }
                let event: Event = serde_json::from_value(v).map_err(|e| Error::Malformed(e.to_string()))?;
                {
                    let mut s = seen.lock().unwrap();
                    let last = s.entry(event.session.clone()).or_insert(0);
                    if event.seq <= *last {
                        continue;
                    }
                    *last = event.seq;
                }
                if tx.send(Update::Event(event)).is_err() || stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
            }
        })();
        match result {
            Ok(()) => return,
            Err(e @ (Error::Protocol(_) | Error::Auth(_))) => {
                let _ = tx.send(Update::Disconnected(e.to_string()));
                return;
            }
            Err(e) => {
                if tx.send(Update::Disconnected(e.to_string())).is_err() {
                    return;
                }
                thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(2));
            }
        }
    }
}
