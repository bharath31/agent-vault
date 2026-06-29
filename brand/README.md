# brand/ — single source of truth for positioning + visual assets

`content.ts` holds nominee's canonical positioning copy (tagline, subhead, the
insight, the layer diagram, "when you don't need it", URLs, colors). The goal:
**a positioning change is one edit here, fanned out to every surface** — instead
of hand-editing a dozen files and missing three.

## How it's used

- **Visual assets** (`compositions/*.tsx`) import `content.ts` directly and are
  rendered with [Remotion](https://remotion.dev) into the committed PNGs/MP4/GIF.
  Re-render after a copy change; the assets can't drift from the source.
- **Static surfaces** (`.md`, `.html`, `.txt`) can't import TS, so they're kept
  in sync by hand against `content.ts`. The registry below is the checklist.

## Rendering the assets

The Remotion project lives outside the workspace to avoid adding heavy deps to
the monorepo. From a Remotion project that imports `../brand/content.ts`:

```bash
# stills
npx remotion still compositions/Banner.tsx  ../.github/media/banner.png
npx remotion still compositions/Og.tsx       ../site/assets/og.png
# video (then convert to gif if needed)
npx remotion render compositions/Proof.tsx   ../site/assets/nominee-proof.mp4
```

See `compositions/` for the composition source.

## Surface registry — everywhere positioning copy lives

When the story changes, update `content.ts`, re-render the assets, and walk this list:

| Surface | File | Carries |
|---|---|---|
| README hero + banner alt | `README.md` | tagline, banner alt, problem, layer, when-not, examples |
| README banner image | `.github/media/banner.png` | tagline (rendered) |
| Landing hero | `site/index.html` | tagline (short), subhead, insight |
| Landing layer + when-not | `site/index.html` (`#why`) | layer diagram, when-not |
| Landing OG image | `site/assets/og.png` | tagline (rendered) |
| Docs intro | `site/docs/index.html` | tagline, when-not, freshness explainer |
| Blog (insight post) | `site/blog/oauth-refresh-is-probably-broken/` | insight |
| llms.txt (site + root) | `site/llms.txt`, `llms.txt` | tagline, key concepts, when-not |
| Example READMEs | `examples/*/README.md` | scoped framing + when-not |
| Live demo worker | `site/agent-worker/src/index.ts` | demo copy (freshness/approval) |

> Factual drift (snippets that no longer compile, renamed flags, dead anchors) is
> a separate problem — handle it with compiled `examples/` + a CI link checker,
> not this file.
