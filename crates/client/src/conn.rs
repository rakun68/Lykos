//! One connection to the engine server: newline-delimited JSON, after the handshake `lykos/server/wire.ts` runs.
use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;

use hmac::{Hmac, KeyInit, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::address::{hex, unhex};
use crate::protocol::Welcome;

#[cfg(windows)]
type Stream = std::fs::File;
#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// The server speaks another protocol version; the message names both.
    Protocol(String),
    /// A key did not prove itself, on either side.
    Auth(String),
    /// The server answered a request with an error.
    Server(String),
    Closed,
    Malformed(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Protocol(m) | Error::Auth(m) | Error::Server(m) => f.write_str(m),
            Error::Closed => f.write_str("the engine server closed the connection"),
            Error::Malformed(m) => write!(f, "the engine server sent {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

fn open(path: &Path) -> io::Result<Stream> {
    #[cfg(windows)]
    {
        // Every pipe instance busy (ERROR_PIPE_BUSY, 231): the server is between accepts. Brief, so retry.
        let mut tries = 0;
        loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(path) {
                Err(e) if e.raw_os_error() == Some(231) && tries < 50 => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                other => return other,
            }
        }
    }
    #[cfg(unix)]
    {
        Stream::connect(path)
    }
}

fn proof(key: &[u8], side: &str, nonce: &str) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(side.as_bytes());
    mac.update(b":");
    mac.update(nonce.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn same(a: &str, b: &str) -> bool {
    // Constant time over equal lengths: what leaks is only the length, which is fixed.
    match (unhex(a), unhex(b)) {
        (Some(x), Some(y)) if x.len() == y.len() && !x.is_empty() => x.iter().zip(&y).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0,
        _ => false,
    }
}

pub struct Conn {
    reader: BufReader<Stream>,
    writer: Stream,
    line: String,
}

impl Conn {
    /// Connects and runs the handshake. `protocol` is the version this client claims (tests claim an old one).
    pub fn open(path: &Path, key: &[u8], client: &str, protocol: u32) -> Result<(Conn, Welcome)> {
        let stream = open(path)?;
        let writer = stream.try_clone()?;
        let mut conn = Conn { reader: BufReader::with_capacity(1 << 16, stream), writer, line: String::new() };
        let welcome = conn.handshake(key, client, protocol)?;
        Ok((conn, welcome))
    }

    fn handshake(&mut self, key: &[u8], client: &str, protocol: u32) -> Result<Welcome> {
        let mut nonce = [0u8; 32];
        getrandom::fill(&mut nonce).map_err(|e| Error::Io(io::Error::other(e.to_string())))?;
        let nonce = hex(&nonce);
        self.send(&json!({ "type": "hello", "protocol": protocol, "client": client, "nonce": nonce }))?;
        let challenge = self.recv()?.ok_or(Error::Closed)?;
        refused(&challenge)?;
        let (Some(server_nonce), Some(server_proof)) = (challenge["nonce"].as_str(), challenge["proof"].as_str()) else {
            return Err(Error::Malformed("no challenge".into()));
        };
        if !same(server_proof, &proof(key, "server", &nonce)) {
            return Err(Error::Auth("the server did not prove it holds this user's engine key".into()));
        }
        let auth = proof(key, "client", server_nonce);
        self.send(&json!({ "type": "auth", "proof": auth }))?;
        let welcome = self.recv()?.ok_or(Error::Closed)?;
        refused(&welcome)?;
        serde_json::from_value(welcome).map_err(|e| Error::Malformed(e.to_string()))
    }

    pub fn send(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| Error::Malformed(e.to_string()))?;
        bytes.push(b'\n');
        self.writer.write_all(&bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    /// The next line, or None once the server closed the connection.
    pub fn recv(&mut self) -> Result<Option<Value>> {
        loop {
            self.line.clear();
            if self.reader.read_line(&mut self.line)? == 0 {
                return Ok(None);
            }
            if self.line.trim().is_empty() {
                continue;
            }
            return serde_json::from_str(&self.line).map(Some).map_err(|e| Error::Malformed(e.to_string()));
        }
    }
}

fn refused(v: &Value) -> Result<()> {
    if v["type"] != "refused" {
        return Ok(());
    }
    let message = v["message"].as_str().unwrap_or("refused").to_string();
    Err(if v["reason"] == "protocol" { Error::Protocol(message) } else { Error::Auth(message) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_is_the_servers_hmac() {
        // Node: createHmac("sha256", Buffer.alloc(32, 1)).update("server:abc").digest("hex")
        assert_eq!(proof(&[1u8; 32], "server", "abc"), "e07072c34be8d3ebc4adb862eb47ce3d21b23a1698c4622ef6f4a776ec8693ef");
        assert!(same("00ff", "00ff"));
        assert!(!same("00ff", "00fe"));
        assert!(!same("", ""));
    }
}
