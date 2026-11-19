## What and why

<!-- What does this change, and why? Link the issue it closes, if any (Closes #123). -->

## Version bump

<!-- See CONTRIBUTING.md -> Pull requests. Pick one. -->

- [ ] major (breaks existing users)
- [ ] minor (new, backwards-compatible capability)
- [ ] patch (fix or wording, no contract change)
- [ ] none (internal only: tests, CI, refactor)

## Checklist

- [ ] `scripts/check.sh` passes locally
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` (or this is internal only)
- [ ] CLI behaviour changes have a test in `plugins/factory/test/`
- [ ] Follows `CLAUDE.md`: TypeScript run via npx with no runtime dependencies, gates in the CLI, human-only commands in the hook (`plugins/factory/src/gate.ts`), new `job.json` fields handled by the dashboard, new `factory.json` keys in `DEFAULTS` and validation

## How it was tested

<!-- Commands run and what you saw. For prompt changes, what you ran through /factory:run. -->
