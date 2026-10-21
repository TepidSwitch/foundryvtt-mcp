# Testing Requirements

This project uses **bun** + **`just`** (see `development.md` for the full
command reference). Prefer the `just` recipes — they are what CI runs, keeping
local/CI parity.

## Tiers

| Tier | Command | Scope |
|------|---------|-------|
| Unit | `just test` (`bun run test`, Vitest) | Pure logic, and fake-socket tests for Foundry-facing code (see below). `just test-coverage` reports v8 coverage (summary, text and HTML in `coverage/`); there are no coverage thresholds, so the number is informational. |
| E2E | `just test-e2e` (`bun run test:e2e`) | Playwright smoke specs (`tests/e2e/**`). |
| Gate | `just qa` | biome + `tsc` + unit Vitest — run before committing. |

## What to test

Not every new function needs a unit test. Match the test to what the code does:

- **Pure logic** (calculations, parsing, formatting, decision branches) gets
  unit tests. These are cheap, deterministic, and where most bugs are caught.
- **Code that talks to Foundry** (`modifyDocument` calls, request shapes,
  dot-path updates) is covered by a **fake-socket test** that asserts the
  resulting world state, or by the live smoke suite (`just smoke-live`). Do not
  rely on mocked unit tests here: they passed while the real request shape
  was wrong. Example: ActorDelta dot-path updates are silently dropped by
  Foundry, and no mock could show that.
- **Do not write tests that only restate the code**, such as asserting that a
  mock was called with the same literal the code passes. They break on every
  refactor and prove nothing. Do not write tests that check TypeScript types
  at runtime; `just check-types` does that.
- **Every live-found bug gets a regression test** at the lowest level that can
  reproduce it (a pure-function test if possible, otherwise a fake-socket
  test). Add the test in the same change as the fix.

## Coverage areas

- Tool handlers (read **and** write) and the Socket.IO `modifyDocument` protocol
  (see `foundry-write-protocol.md`)
- Authentication (4-step Socket.IO join) and connection lifecycle
- `foundry://` resource URIs and tool/contract schemas
- World-data caching and querying
