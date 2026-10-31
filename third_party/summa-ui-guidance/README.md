# Summa-UI guidance bundle

Framework-agnostic design guidance for AI agents. Nothing here requires React, a bundler or any runtime dependency. The React code elsewhere in this repository (`src/ui`, `src/presets`, `src/lab`) is an optional reference implementation and the laboratory used to evaluate the guidance.

| Path | Purpose | Authored or generated |
| --- | --- | --- |
| `manifest.json` | Versioned file list, sha256 per file, `bundleDigest`, counts, channel | generated |
| `bundle.config.json` | Version, channel (`draft`, `candidate`, `approved`), reviewer | authored |
| `principles.json` | Machine form of `../PRINCIPLES.md` (P01 to P22) | authored, back-links generated |
| `antipatterns/AP-*.json` | 16 anti-patterns with bad and good examples, exceptions, detection | authored |
| `checks/rules.json` | Objective and heuristic checks plus human judgment prompts | authored |
| `tokens.json`, `css/tokens.css` | Design tokens with roles; plain CSS custom properties | generated from `../src/styles/tokens.css` |
| `presets/*.json`, `css/presets.css`, `examples/*.html` | Interaction presets with framework-neutral CSS and HTML | authored |
| `icons/catalog.json`, `icons/svg/*.svg`, `icons/LICENSE` | Curated Lucide subset (ISC) | authored from pinned `lucide-static` |
| `prompt-pack.md` | Compact text for Executor agents | generated |
| `schema/*.schema.json` | JSON Schemas for every authored file | authored |
| `IDS.md` | Stable identifiers | authored |

## Commands

```bash
npm run guidance:build     # regenerate tokens.json, css/tokens.css, principles back-links, prompt-pack.md, manifest.json
npm run validate           # schemas, cross references, PRINCIPLES.md consistency, tokens, em dash rule, manifest hashes
npm run checks -- <url>    # reference evaluator for a subset of checks/rules.json (needs Playwright)
```

Always run `guidance:build` after editing any file in this directory, then `validate`. Releases are pinned by `bundleDigest`; see `../docs/SUMMA_INTEGRATION.md`.

## Rules for changing the bundle
- A change to a principle starts in `../PRINCIPLES.md`, then `principles.json`. The validator fails if titles drift.
- A new anti-pattern needs: id, principles, a visual bad example, at least one good example, exceptions and detection links.
- A new rule that contradicts an approved rule needs an explicit decision recorded in `../docs/DECISIONS.md`.
- No em dashes anywhere in the bundle (principle 13).
