---
files: [src/pricing.js]
scope: ["src/**"]
sealed: [test/format.test.js]
test: "node --test test/format.test.js"
---
Make `formatCents` print dollars and cents with two decimals: `150` prints `$1.50`, `1005` prints
`$10.05`.

The sealed test `test/format.test.js` pins both cases.
