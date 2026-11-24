//! A pseudo-terminal for the terminal pane (P5 #48): ConPTY on Windows, `openpty` elsewhere. Lykos's own, on the
//! system calls alone: portable-pty imported WS2_32, advapi32 and bcrypt, which cost every run about 0.8 MB at start
//! (rule 10).
use std::fs::File;
use std::io;

/// A shell on a pseudo-terminal: its output to read, its input to write, its size and its end.
pub struct Pty {
    pub writer: File,
    sys: sys::Pty,
}

/// Waits for the shell to exit, on a thread of its own.
pub struct Waiter(sys::Waiter);

impl Waiter {
    pub fn wait(self) {
        self.0.wait();
    }
}

impl Pty {
    /// Starts `program` in `cwd` at `cols` by `rows`. Returns the pty, its output, and what waits for the exit.
    pub fn spawn(program: &str, cwd: &str, cols: u16, rows: u16) -> io::Result<(Pty, File, Waiter)> {
        let (sys, reader, writer, waiter) = sys::spawn(program, cwd, cols.max(1), rows.max(1))?;
        Ok((Pty { writer, sys }, reader, Waiter(waiter)))
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.sys.resize(cols.max(1), rows.max(1));
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::fs::File;
    use std::io;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::{null, null_mut};
    use std::sync::Arc;

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Coord {
        x: i16,
        y: i16,
    }

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill: u32,
        flags: u32,
        show_window: u16,
        reserved2_len: u16,
        reserved2: *mut u8,
        std_input: Handle,
        std_output: Handle,
        std_error: Handle,
    }

    #[repr(C)]
    struct StartupInfoExW {
        info: StartupInfoW,
        attributes: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }

    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
    const INFINITE: u32 = 0xFFFF_FFFF;

    // `raw-dylib`: no import library needed, and kernel32 is loaded already.
    #[link(name = "kernel32", kind = "raw-dylib")]
    extern "system" {
        fn CreatePipe(read: *mut Handle, write: *mut Handle, attrs: *const c_void, size: u32) -> i32;
        fn CreatePseudoConsole(size: Coord, input: Handle, output: Handle, flags: u32, pc: *mut Handle) -> i32;
        fn ResizePseudoConsole(pc: Handle, size: Coord) -> i32;
        fn ClosePseudoConsole(pc: Handle);
        fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(list: *mut c_void, flags: u32, attr: usize, value: *const c_void, size: usize, prev: *mut c_void, ret: *mut usize) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(app: *const u16, cmd: *mut u16, pa: *const c_void, ta: *const c_void, inherit: i32, flags: u32, env: *const c_void, cwd: *const u16, si: *const StartupInfoExW, pi: *mut ProcessInformation) -> i32;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn TerminateProcess(h: Handle, code: u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }

    /// A process handle, closed once neither the pty nor its waiter holds it.
    struct Process(Handle);
    // SAFETY: a process handle may be used and closed from any thread.
    unsafe impl Send for Process {}
    unsafe impl Sync for Process {}
    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateProcessW and is closed once, here.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct Pty {
        console: Handle,
        process: Arc<Process>,
    }
    // SAFETY: a pseudo console handle may be resized and closed from any thread.
    unsafe impl Send for Pty {}

    pub struct Waiter(Arc<Process>);

    impl Waiter {
        pub fn wait(self) {
            // SAFETY: the handle stays open while this Arc holds it.
            unsafe { WaitForSingleObject(self.0 .0, INFINITE) };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn check(ok: bool) -> io::Result<()> {
        if ok {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn spawn(program: &str, cwd: &str, cols: u16, rows: u16) -> io::Result<(Pty, File, File, Waiter)> {
        let size = Coord { x: cols as i16, y: rows as i16 };
        let (mut in_read, mut in_write, mut out_read, mut out_write) = (null_mut(), null_mut(), null_mut(), null_mut());
        // SAFETY: each call gets valid out-pointers; every handle made here is closed on every path, or handed to a
        // File that closes it.
        unsafe {
            check(CreatePipe(&mut in_read, &mut in_write, null(), 0) != 0)?;
            if CreatePipe(&mut out_read, &mut out_write, null(), 0) == 0 {
                let e = io::Error::last_os_error();
                CloseHandle(in_read);
                CloseHandle(in_write);
                return Err(e);
            }
            let reader = File::from_raw_handle(out_read);
            let writer = File::from_raw_handle(in_write);
            let mut console = null_mut();
            let hr = CreatePseudoConsole(size, in_read, out_write, 0, &mut console);
            // The console holds its own copies of its ends.
            CloseHandle(in_read);
            CloseHandle(out_write);
            if hr < 0 {
                return Err(io::Error::other(format!("CreatePseudoConsole failed: {hr:#x}")));
            }
            let mut len = 0usize;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut len);
            let mut list = vec![0u8; len];
            let attrs = list.as_mut_ptr().cast::<c_void>();
            let started = (|| -> io::Result<ProcessInformation> {
                check(InitializeProcThreadAttributeList(attrs, 1, 0, &mut len) != 0)?;
                let updated = UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, std::mem::size_of::<Handle>(), null_mut(), null_mut()) != 0;
                let result = check(updated).and_then(|()| {
                    let mut si: StartupInfoExW = std::mem::zeroed();
                    si.info.cb = std::mem::size_of::<StartupInfoExW>() as u32;
                    // No inherited standard handles: the shell's are the console's.
                    si.info.flags = STARTF_USESTDHANDLES;
                    si.attributes = attrs;
                    let mut pi: ProcessInformation = std::mem::zeroed();
                    let mut cmd = wide(program);
                    let dir = wide(cwd);
                    check(CreateProcessW(null(), cmd.as_mut_ptr(), null(), null(), 0, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, null(), dir.as_ptr(), &si, &mut pi) != 0)?;
                    Ok(pi)
                });
                DeleteProcThreadAttributeList(attrs);
                result
            })();
            let pi = match started {
                Ok(pi) => pi,
                Err(e) => {
                    ClosePseudoConsole(console);
                    return Err(e);
                }
            };
            CloseHandle(pi.thread);
            let process = Arc::new(Process(pi.process));
            Ok((Pty { console, process: process.clone() }, reader, writer, Waiter(process)))
        }
    }

    impl Pty {
        pub fn resize(&self, cols: u16, rows: u16) {
            // SAFETY: the console is open until drop.
            unsafe { ResizePseudoConsole(self.console, Coord { x: cols as i16, y: rows as i16 }) };
        }
    }

    impl Drop for Pty {
        fn drop(&mut self) {
            // SAFETY: both handles are open until here; closing the console ends what else is attached to it and
            // lets its output reach end of file.
            unsafe {
                TerminateProcess(self.process.0, 1);
                ClosePseudoConsole(self.console);
            }
        }
    }
}

#[cfg(unix)]
mod sys {
    use std::fs::File;
    use std::io;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::ptr::{null, null_mut};

    pub struct Pty {
        master: OwnedFd,
        pid: libc::pid_t,
    }

    pub struct Waiter(Child);

    impl Waiter {
        pub fn wait(mut self) {
            let _ = self.0.wait();
        }
    }

    fn size(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
    }

    pub fn spawn(program: &str, cwd: &str, cols: u16, rows: u16) -> io::Result<(Pty, File, File, Waiter)> {
        let (mut master, mut slave) = (-1, -1);
        let ws = size(cols, rows);
        // SAFETY: valid out-pointers; the two descriptors are owned at once.
        if unsafe { libc::openpty(&mut master, &mut slave, null_mut(), null(), &ws) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openpty returned these two descriptors, owned by nothing else.
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        let mut cmd = Command::new(program);
        cmd.current_dir(cwd).env("TERM", "xterm-256color").stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec: a new session, with the pty as its terminal.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        let pid = child.id() as libc::pid_t;
        let reader = File::from(master.try_clone()?);
        let writer = File::from(master.try_clone()?);
        Ok((Pty { master, pid }, reader, writer, Waiter(child)))
    }

    impl Pty {
        pub fn resize(&self, cols: u16, rows: u16) {
            use std::os::fd::AsRawFd;
            let ws = size(cols, rows);
            // SAFETY: the master is open; TIOCSWINSZ reads the winsize.
            unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
        }
    }

    impl Drop for Pty {
        fn drop(&mut self) {
            // SAFETY: the shell leads its own session: SIGHUP to its group ends it and what it started.
            unsafe { libc::kill(-self.pid, libc::SIGHUP) };
        }
    }
}
