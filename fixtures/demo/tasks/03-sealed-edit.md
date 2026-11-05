---
files: [src/pricing.js]
scope: ["src/**"]
sealed: [test/guard.test.js]
red: false
test: "node --test test/format.test.js test/guard.test.js"
---
Make `formatCents` print a negative amount with a leading minus sign: `-150` prints `-$1.50`.

The sealed test `test/guard.test.js` may not be edited.
