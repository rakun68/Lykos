# Pricing rules

All amounts are integer cents.

1. A price is never negative, before or after any discount.
2. A discount percent is clamped to 0..100 before it is applied.
3. A discounted price is rounded half up to whole cents.
4. `formatCents` prints dollars with two decimals and a leading `$`. A negative amount or a fraction of a
   cent is an error.
