# Summa-UI icons

Curated subset of [Lucide](https://lucide.dev) (package `lucide-static`, pinned in package.json, ISC license, see `LICENSE`).

- `catalog.json` is the source of truth (validates against `../schema/icons.schema.json`).
- `svg/<name>.svg` are standalone, normalised files: 24px grid, `stroke="currentColor"`, stroke width 1.75, round caps and joins. Play, pause, stop, skip and circle-half bake in a fill because they are state controls.
- `npm run icons:build` regenerates the `ICONS` record in `src/ui/icons.tsx` from these files.
- `npm run validate:icons` checks the catalog, the files, and that every key used in `src/ui/icons.tsx` is catalogued.

To add an icon: copy it from `node_modules/lucide-static/icons/`, normalise it like the others, add a catalog entry with a stable Summa name, run `icons:build`. Never rename an existing name.
