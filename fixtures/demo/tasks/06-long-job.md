---
files: [scripts/slow-check.js]
scope: ["scripts/**"]
red: false
test: "npm run slow-check"
---
Run `npm run slow-check` as a background job and report its last line when it finishes. It prints
one line a second for five minutes. Change nothing.
