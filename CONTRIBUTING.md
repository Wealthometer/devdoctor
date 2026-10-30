# Contributing

1. `npm install`, then `npm test`. Tests build throwaway projects and git repositories in the temp directory, and PulseAPI's run against a local HTTP server, so nothing touches the network except DepScope's registry tests (which use a fake `fetch`).
2. Each tool lives in `src/tools/`. Shared pieces (file walking, import graph, reports, config) are in `src/core/`.
3. A new rule needs a stable id, a message that says what's wrong in plain words, a one-line hint on how to fix it, and a test that shows both a hit and a near-miss.
4. Commit messages follow Conventional Commits. `npx commitsmith hook` installs a checker.
5. Before opening a PR: `npm run typecheck && npm test && npm run build && node bin/devdoctor.js check`.
