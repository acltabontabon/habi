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
| `/habi/og-v2.png` | The share image | `website/src/pages/og.astro`, rendered by `pnpm og` |

## The source

`website/` is a project of its own: its own `package.json` and lockfile, plain Astro, and no
dependency shared with the app.
The design tokens in `website/src/styles/tokens.css` are the app's, so both read as one product.

```sh
cd website
pnpm dev          # the site on http://localhost:4321/habi/, reloading as you edit
pnpm build        # the static site in website/dist/, as Pages serves it
pnpm preview      # that build, served locally
pnpm media        # public/media/: the tour's screenshots (dark; the site has no light theme), and the film
pnpm og           # public/og-v2.png, from the /og/ page with headless Chrome (pnpm dev first)
```

What the landing page shows of Habi is real: every picture is a screenshot of the app on a
seeded workspace, and the film is cut from the same screenshots (below).

## The film

The landing page shows a film (`docs/media/demo.mp4`): an ad cut from the app's own dark
screenshots, set to a synthesized score. It is the hero's backdrop, the way a streaming service
opens: the still (`demo-poster.jpg`) first, then, a couple of seconds after load, the film eases in
behind the words, muted, from its very beginning, and plays once; it pauses when
scrolled away from and the still returns when it ends. While it loads (or stalls) a small loom weaves
over the still, its weft as long as the film that has really arrived. Nothing is written over or under it: the film tells the problem itself, and the first screen is the film. Nothing depends on it, and it never starts by
itself with reduced motion or data saver. The two small buttons over it start it with sound and take
it full screen. `/#demo` is the hero. Its source is `scripts/film/`, and like the screenshots it is
remade by a script, so changing the app does not mean redrawing it.

| Step | What it does |
| --- | --- |
| `scripts/film/seed.sh <dir>` | builds a workspace that reads like a real team's: two libraries, seven projects, a few skills installed, an update waiting |
| `node scripts/docs-screenshots.mjs` (light, then `HABI_SHOTS_SCHEME=dark`) | photographs the app on it; the dark pictures go to `scripts/film/shots/dark/`, which Git ignores |
| `node scripts/film/score.mjs` | synthesizes the music (`score.wav`), cut to `scripts/film/timeline.json` at its tempo |
| `node scripts/render-film.mjs` | steps the film, one frame at a time, through headless Chrome, and encodes `demo.mp4`, a teaser `demo.gif` for the README, the poster and the chapter times |
| `pnpm media` (in `website/`) | shrinks the pictures and copies the film for the page |

The film is a function of time: `ad.js` stages the screenshots in 3D (windows that turn and
rise, crops of the UI lifted off them, the type over them), `film.css` styles them, and
`timeline.json` says where each scene starts. `node scripts/render-film.mjs
--stills 3,9.6,20` renders single pictures at those seconds, which is the quick way to look at a
change. It uses the site's fonts and tokens, so run `pnpm install` in `website/` first.

## How it works

The landing page's "How it works" is a journey, not a list (`Tour.astro`, `scripts/tour.ts`, the `.rig` rules
in `showcase.css`). The six screens (the dark screenshots `pnpm media` makes) sit on one large plane along a
stitched path; the page pins a stage and, as you scroll, a camera flies from screen to screen, pulling back
mid-flight to show the route, with the saffron thread filling in behind it and a shuttle at its tip, and ends
standing back on the whole weave. Where each screen sits is by hand (`place` in `Tour.astro`); the pins are
percent positions read off the screenshots. The captions are on the stage, not the plane, so they stay put.
With reduced motion, or without scripts, none of it runs and the six moves are a plain list, which is also
what a screen reader reads (the stage is drawn only for the eyes).

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
  `node scripts/docs-screenshots.mjs`, which walks a workspace that reads like a real team's
  (`scripts/film/seed.sh` makes one; the script's header says how to start it), so retaking them
  after a change is one command. It takes the dark ones too, for the landing page and the film. The pictures
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
