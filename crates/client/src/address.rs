//! Where the engine server listens, and the user's key: `lykos/server/address.ts`, read the same way.
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The run directory: `LYKOS_ENGINE_DIR`, or `~/.lykos/run`.
pub fn engine_dir() -> io::Result<PathBuf> {
    if let Some(dir) = std::env::var_os("LYKOS_ENGINE_DIR").filter(|v| !v.is_empty()) {
        return std::path::absolute(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|v| !v.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
    Ok(PathBuf::from(home).join(".lykos").join("run"))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// What a client connects to: the pipe name on Windows (a hash of the run directory), the socket on Linux.
pub fn engine_path(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        let digest = Sha256::digest(pipe_key(&dir.to_string_lossy()).as_bytes());
        PathBuf::from(format!(r"\\.\pipe\lykos-engine-{}", &hex(&digest)[..16]))
    } else {
        dir.join("engine.sock")
    }
}

/// The string the pipe name hashes, as the server computes it: Node's `path.resolve` drops a trailing separator
/// (except a drive root's), which `std::path::absolute` keeps.
fn pipe_key(dir: &str) -> String {
    let lower = dir.to_lowercase();
    let trimmed = lower.trim_end_matches(['\\', '/']);
    if trimmed.len() == lower.len() || trimmed.ends_with(':') {
        if trimmed.ends_with(':') {
            return format!("{trimmed}\\");
        }
        return lower;
    }
    trimmed.to_string()
}

/// The key, which the server writes on its first start. A client never creates it: it starts the server instead.
pub fn read_key(dir: &Path) -> io::Result<Vec<u8>> {
    let text = std::fs::read_to_string(dir.join("engine.key"))?;
    unhex(&text)
        .filter(|k| k.len() == 32)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "the engine key is not 32 bytes of hex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
        assert_eq!(unhex("000fff"), Some(vec![0, 15, 255]));
        assert_eq!(unhex("0g"), None);
    }

    #[test]
    fn a_trailing_separator_names_the_same_pipe() {
        assert_eq!(pipe_key(r"C:\Run\"), r"c:\run");
        assert_eq!(pipe_key(r"C:\Run"), r"c:\run");
        assert_eq!(pipe_key(r"C:\"), r"c:\");
    }

}
