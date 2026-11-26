# Frontend Instructions

## Design reference

Use `design/reference.png` as the reference for the light desktop layout with an environment table, persistent left navigation and an environment inspector on the right.

The frontend supports SQL file uploads and manual execution records. Do not imply that downloading a package executes SQL or advances the ledger. Preserve the distinction between application code version, confirmed SQL version, and an existing environment's manually confirmed baseline. The backend is authoritative for the ledger. Java backend persistence and Docker are implemented at the repository root.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
