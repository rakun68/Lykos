// T212 review regressions: each test is a defect the reviewers found in the first implementation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandPathAccesses, decideCommandPaths } from "./bash-paths.js";
import { collectPathRules, decidePath, type PathContext } from "./path-rules.js";

const CTX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
const WIN: PathContext = { cwd: "C:\\proj", home: "C:\\Users\\u", extraDirs: [], outside: { read: "ask", write: "ask" } };
const RULES = () => collectPathRules({}, false);

describe("T212 review: PowerShell backslash paths", () => {
  it("a PowerShell read of a secret is decided like the file tool reading it", () => {
    const target = "C:\\Users\\u\\.ssh\\config";
    const tool = decidePath(target, "read", RULES(), WIN);
    assert.equal(tool.decision, "deny");
    for (const verb of ["Get-Content", "gc", "type"]) {
      assert.equal(decideCommandPaths(`${verb} ${target}`, RULES(), WIN).decision, "deny", verb);
    }
    assert.equal(decideCommandPaths(`Get-Content -Path "${target}"`, RULES(), WIN).decision, "deny");
    assert.equal(decideCommandPaths(`Get-Content '${target}'`, RULES(), WIN).decision, "deny");
  });

  it("a redirect and a write cmdlet keep their backslashes too", () => {
    assert.equal(decideCommandPaths("echo x > C:\\Users\\u\\.ssh\\config", RULES(), WIN).decision, "deny");
    assert.equal(decideCommandPaths("Set-Content C:\\Users\\u\\.ssh\\config hi", RULES(), WIN).decision, "deny");
    assert.equal(decideCommandPaths("Get-Content ~\\.ssh\\config", RULES(), WIN).decision, "deny");
  });
});

describe("T212 review: << in a comment or arithmetic is not a heredoc", () => {
  it("a comment's << does not swallow later lines", () => {
    const command = "# see <<TAG\ncat .env";
    assert.deepEqual(commandPathAccesses(command), [{ path: ".env", access: "read" }]);
    assert.equal(decideCommandPaths(command, RULES(), CTX).decision, "deny");
  });

  it("arithmetic's << does not swallow later lines", () => {
    for (const command of ["echo $((8<<2))\ncat .env", "echo $(( 1 << 2 ))\ncat .env", "(( x = 1<<2 ))\ncat .env"]) {
      assert.deepEqual(commandPathAccesses(command), [{ path: ".env", access: "read" }], command);
      assert.equal(decideCommandPaths(command, RULES(), CTX).decision, "deny", command);
    }
  });

  it("a real heredoc body is still not scanned", () => {
    assert.deepEqual(commandPathAccesses("cat <<EOF\ncat .env\nEOF\ncat a.txt"), [{ path: "a.txt", access: "read" }]);
  });
});

describe("T212 review: PowerShell data operands are not paths", () => {
  it("Add-Content / Set-Content / Out-File name only their first positional", () => {
    assert.equal(decideCommandPaths("Add-Content .gitignore .env", RULES(), CTX).decision, "allow");
    assert.equal(decideCommandPaths("Set-Content notes.txt .env", RULES(), CTX).decision, "allow");
    assert.deepEqual(commandPathAccesses("Add-Content -Path out.txt -Value .env"), [{ path: "out.txt", access: "write" }]);
    assert.deepEqual(commandPathAccesses("Set-Content -Value x out.txt"), [{ path: "out.txt", access: "write" }]);
  });

  it("the first positional is still checked", () => {
    assert.equal(decideCommandPaths("Add-Content .env hello", RULES(), CTX).decision, "deny");
  });
});

describe("T212 review: comments and file descriptors", () => {
  it("a path named only in a shell comment is not a read operand", () => {
    assert.equal(decideCommandPaths("cat README.md # .env", RULES(), CTX).decision, "allow");
    assert.deepEqual(commandPathAccesses("cat README.md # .env"), [{ path: "README.md", access: "read" }]);
  });

  it("a # inside a word or quotes is not a comment", () => {
    assert.deepEqual(commandPathAccesses("cat a#b.txt"), [{ path: "a#b.txt", access: "read" }]);
    assert.deepEqual(commandPathAccesses("cat 'a #b'"), [{ path: "a #b", access: "read" }]);
    assert.equal(decideCommandPaths("echo hi\ncat .env # why", RULES(), CTX).decision, "deny");
  });

  it("an escaped quote inside a string does not end it, so a later # is not a comment (phase review)", () => {
    assert.equal(decideCommandPaths('echo "hello \\" #" && cat .env', RULES(), CTX).decision, "deny");
    assert.equal(decideCommandPaths('echo "a\\\\" # .env', RULES(), CTX).decision, "allow");
  });

  it("a digit that ends a filename before > is not a file descriptor", () => {
    const tool = decidePath("/work/proj/.env2", "read", RULES(), CTX);
    assert.equal(tool.decision, "allow");
    assert.equal(decideCommandPaths("cat .env2>out", RULES(), CTX).decision, "allow");
    assert.equal(decideCommandPaths("cat .env>out", RULES(), CTX).decision, "deny");
  });

  it("a bare fd number before > is still not a path", () => {
    assert.deepEqual(
      [...commandPathAccesses("cat a.txt 2>err.log")].sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: "a.txt", access: "read" },
        { path: "err.log", access: "write" },
      ],
    );
    assert.deepEqual(commandPathAccesses("cat a.txt 2>&1"), [{ path: "a.txt", access: "read" }]);
  });
});
