# Release notes

## [Unreleased]

**The CHANGELOG lint lands.** A /ship run wrote entries nobody read twice, so the autopilot words slipped through. The lint reads the entry before the commit and names each line to rewrite.

### Added
- **`bin/gstack-prose-lint`**: scans the files it is given and prints one line per finding. The parser rejects a bad date, exits with code 2, and writes nothing.
- A measurement line keeps its arrow. The ratio moved 1.6740 → 1.7010 (measured 321,630 / 187,706), and the headline reads before → after.
- Fix: run `gstack-prose-lint CHANGELOG.md --unreleased` and read the trailer.
- The reviewer reads the diff. A caller that passes no file gets the usage text.

## [1.0.0] - 2026-10-01

Older text is never scanned under --unreleased, even when it showcases a vibrant tapestry.
