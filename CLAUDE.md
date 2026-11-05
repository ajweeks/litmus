# litmus: notes for agents

A Next.js chat UI (port 3000) that fact-checks the model's replies as they stream. See `README.md`.

litmus is also a library: `lib/*` is exported as `litmus/lib/*` (see `exports` in `package.json`). Stämmer siffrorna? (~/code/siffror) depends on this repository pinned to a release tag (`v0.1.0`), so changes to exported functions can break it. To release: bump `version` in `package.json`, commit, `git tag -a v<version>`, then bump the tag in siffror. Keep exported signatures compatible within a minor version.

API keys live only in the browser and are sent per request; the server never reads provider keys from the environment. Next.js is newer than your training data: read `AGENTS.md` before writing Next code.

Checks: `npm run typecheck && npm test` (offline).
