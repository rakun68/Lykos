// Test fixture (T171): the smallest language server that completes the
// handshake. It answers every request with null (`initialize` with empty
// capabilities) and exits on `exit`, framed the way LSP is. Copied into a
// workspace by the tests that need "a server binary that lives in the project".
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
    buf = buf.subarray(sep + 4 + len);
    if (msg.method === "exit") process.exit(0);
    if (msg.id !== undefined && msg.method) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { capabilities: {} } : null });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  }
});
