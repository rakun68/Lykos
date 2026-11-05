---
files: [src/pricing.js]
scope: ["src/**", "test/**"]
test: "node --test"
---
Add `splitBill(cents, people)` to `src/pricing.js`. It splits a bill of `cents` between `people`
people and returns an array with one integer amount per person, in cents.

- `cents` is a non-negative integer; anything else is a `TypeError`.
- `people` is an integer of at least 1; anything else is a `RangeError`.
- The amounts sum to exactly `cents`, and no two amounts differ by more than one cent.
- The array has exactly `people` entries.

Add tests for it under `test/`.
