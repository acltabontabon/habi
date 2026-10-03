# The website

`https://acltabontabon.com/habi/` is the landing page, and the documentation lives under it at
`https://acltabontabon.com/habi/docs/`. Both come out of one Astro build in `website/` and deploy
as one GitHub Pages artifact.

| URL | What it is | Where it comes from |
| --- | --- | --- |
| `/habi/` | The landing page | `website/src/pages/index.astro` and its components |
| `/habi/docs/` | The documentation index | `docs/README.md`, rendered by `website/src/lib/docs.ts` |
| `/habi/docs/<page>/` | A guide, a library author's page or a project page | `docs/guide/`, `docs/library-authors/`, `docs/project/` |
| `/habi/docs/media/…` | An image a published page shows | the file itself, in `docs/media/` |
| `/habi/og.png` | The share image | `website/src/pages/og.astro`, rendered by `pnpm og` |

## The source

`website/` is a project of its own: its own `package.json` and lockfile, plain Astro, and no
dependency shared with the app.
The design tokens in `website/src/styles/tokens.css` are the app's, so both read as one product.

```sh
cd website
pnpm dev          # the site on http://localhost:4321/habi/, reloading as you edit
pnpm build        # the static site in website/dist/, as Pages serves it
pnpm preview      # that build, served locally
pnpm snapshot     # src/data/recommendations.json, from the habi CLI and the fixtures
pnpm og           # public/og.png, from the /og/ page with headless Chrome (pnpm dev first)
```

What the landing page shows of Habi's output is real: `pnpm snapshot` runs the `habi` command
against the fixture repositories and libraries. The "Receipts" section draws the app's own views
from that snapshot.

## The documentation

`docs/` is the one copy of the documentation anybody edits. It reads on GitHub as it always has,
and `scripts/check-links.mjs` checks its links there. The site build also renders it into pages
under `/habi/docs/`, so someone who clicks Docs on the site reads it there, in the site's type and
colors, instead of in a code repository.

- **What is published.** The index (`docs/README.md`) and every page in `docs/guide/`,
  `docs/library-authors/` and `docs/project/`. A page's address is its file name:
  `docs/guide/getting-started.md` is `/habi/docs/getting-started/`, so two published pages may not
  share a name, and the build says so if they do. `docs/dev/` is for people changing the code, so
  a link to it, or to the README, CONTRIBUTING or a source file, goes to GitHub.
- **The sidebar** is the index's tables: each `##` section with a published page in it, and in
  each the pages it lists, in its order and under its names for them. A new guide appears in the
  sidebar once the index lists it.
- **Links are checked as they are rewritten.** A link to a page, a `#section` or an image the site
  does not have fails `pnpm build`. Heading ids follow GitHub's rule, the same one
  `scripts/check-links.mjs` uses, so an anchor that works on GitHub works here too.
- **Images** live in `docs/media/` and are served from there, at `/habi/docs/media/`; a PNG or
  JPEG keeps its space before it loads. The screenshots are taken from the running app by
  `node scripts/docs-screenshots.mjs`, which walks the sample workspace like a first-time user
  (its header says how to start it), so retaking them after a change is one command. The pictures
  in the sharing guide come from `node scripts/docs-screenshots-sharing.mjs`, which needs a GitHub
  repository to open a pull request against (it closes the request when it finishes); both scripts
  drive Chrome through `scripts/lib/cdp.mjs`.
- **On a narrow screen** the list of pages folds into a `<details>`, so the pages need no script.

`pnpm dev` renders the docs again on every request and reloads the page when a file in `docs/`
changes, so an edited guide shows as you save it.

## Deploying

`.github/workflows/website.yml` builds `website/` and deploys it to GitHub Pages on a push to
`main` that touches `website/` or `docs/`, and on demand. CI builds the site on every pull request,
so a broken link in the docs fails the pull request before it can fail the deploy.

The docs on the site follow `main`, not the latest release. Until releases are frequent that keeps
one copy current; if they drift, build the docs pages from the newest `vX.Y.Z` tag instead.

Nothing about the domain lives in this repository. `acltabontabon.com` belongs to the account's
user site, and GitHub applies a user site's custom domain to every project site, so the `/habi/`
prefix comes from the repository name (`base` in `website/astro.config.mjs`). `SITE` and `BASE`
override both, for example to serve the site from a domain of its own.
