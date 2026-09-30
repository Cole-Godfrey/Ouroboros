# Contributing

The harness is TypeScript that Node 22.22.2 or Node 24.15+ with npm 12.2+ runs directly, with no build step. The only runtime dependencies are Pi and viem.

Run `npm ci` once, then `npm run check` before every change. It runs the typecheck and all tests in about a minute, offline. The tests include end-to-end runs of the real Pi against a scripted model, so they exercise the agent extension, the metering proxy, the daemon and the self-modification pipeline together.

Keep code simple and commented in plain language. Comments, docstrings and commit messages start lowercase. Add a test for every behaviour you add, and never weaken the gate, the audit log, the reconciler, the vault or the Charter check. Those paths are protected, and a change to them is treated as high risk by the self-modification pipeline.

Prose in documentation should be short, plain and mostly paragraphs, without em dashes or semicolons.

Use `npm install --global npm@12.2.0` after installing a supported Node version. npm 12 is required because older npm versions honor Pi's published shrinkwrap over the patched dependency override.

Rebuild the system-description PDF from `docs/SYSTEM.md` with `uv run scripts/build_pdf.py`. The script declares its Python dependencies and includes the current artwork and diagrams.
