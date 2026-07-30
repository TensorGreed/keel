# Changelog

## 2.0.0

### Breaking

- `greet` now takes an options object: `greet({ name })`. Passing a bare string throws a
  `TypeError`. Migrate `greet(name)` to `greet({ name })`.
- `shout` has been removed; use `greet` and uppercase the result yourself.

## 1.0.0

- Initial release. `greet(name)` returns a greeting.
