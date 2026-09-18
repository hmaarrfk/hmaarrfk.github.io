# hmaarrfk.github.io
Personal webpage

Trying to enable ssl between the user and cloudfare 
https://rck.ms/jekyll-github-pages-custom-domain-gandi-https-ssl-cloudflare/

## Page versioning & cache busting

Every page ends with a small footer giving the short commit hash the site was
built from (linked to that commit on GitHub) and the build time, so it is
obvious at a glance whether you are looking at a rebuilt page or a cached one.
The same hash is also in the `<head>` as `<meta name="build-revision">` /
`<meta name="build-date">`, which makes it checkable without scrolling:

```sh
curl -s https://www.markharfouche.com/ | grep 'name="build-'
```

The hash comes from `site.github.build_revision` (jekyll-github-metadata, part
of the `github-pages` gem; it falls back to `git rev-parse HEAD` when building
locally, and to the literal `dev` outside a checkout).

Two includes do the work:

| Include | What it emits |
|---------|---------------|
| `_includes/v.html` | The bare 7-character token, dropped into a query string: `?v=` followed by an `include v.html` tag |
| `_includes/version.html` | The footer line itself |

Every stylesheet and script the site serves is requested as
`<path>?v=<short hash>`. The hash changes on every push even when a file's bytes
do not — that is the point: a release forces a re-fetch instead of trusting
whatever the browser cached, so a page can never end up running a new HTML shell
against a stale script.

The standalone tool pages under `/tools/` need two extra pieces, because their
JavaScript is a graph of ES modules rather than a single file:

* **An import map.** A relative import inside a module (`import … from
  './voice.js'`) resolves *without* the importing module's query string, so a
  `?v=` on the entry point alone would not reach its dependencies. Each tool
  page therefore emits an import map whose keys are the bare module URLs and
  whose values carry `?v=`, which rewrites the whole graph in one place.
  Vendored third-party libraries are deliberately left out: they are pinned
  copies that only change by being replaced.
* **An explicit query on workers.** Import maps do not apply to `new Worker`,
  so the modules that spawn one copy their own `?v=` across by hand
  (`workerUrl.search = new URL(import.meta.url).search`), and a worker that
  imports a sibling does so dynamically with `self.location.search` appended.

Those pages carry `layout: null` front matter so Jekyll runs Liquid over the
HTML (which is how the `?v=` gets there) while leaving them standalone. They
hold no inline JavaScript, and the `.js` files beside them have no front matter,
so Liquid never touches the JavaScript itself.
