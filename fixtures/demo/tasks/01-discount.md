---
files: [src/pricing.js]
scope: ["src/**"]
sealed: [test/discount.test.js]
test: "node --test test/discount.test.js test/format.test.js test/guard.test.js"
---
Implement `applyDiscount(cents, percent)` in `src/pricing.js` so it follows every rule in `SPEC.md`.

The sealed test `test/discount.test.js` pins three cases. `SPEC.md` is the whole contract: a case the
sealed test does not pin is still a rule.
