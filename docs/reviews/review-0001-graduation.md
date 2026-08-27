---
id: REVIEW-0001
name: Review of the graduation work (RFC-0001, RFC-0002, RFC-0003)
status: Complete
owners:
    - alistairbayley
created: 2026-08-26
updated: 2026-08-26
reviews: b6ba721..fdd8dc3
---

# Review of the graduation work (RFC-0001, RFC-0002, RFC-0003)

| Stage     | Timestamp        |
| --------- | ---------------- |
| Authored  | 2026-08-26 15:05 |
| Completed | 2026-08-26 15:05 |

## Review Scope

59 commits, `b6ba721..fdd8dc3`, 147 files, +18161/-5013. Reviewed in seven
slices along two axes each (Standards: conformance to `~/.agents/*.md` and the
repo's own documented rules; Spec: fidelity to the originating RFC or BACKLOG
entry), plus three cross-cutting audits: behaviour preservation, TSDoc
accuracy, and test quality.

| Slice                         | Range                | Spec                              |
| ----------------------------- | -------------------- | --------------------------------- |
| Quality tooling and goldens   | `b6ba721..fa4d6b5`   | none (ad hoc)                     |
| RFC-0001 generator extraction | `fa4d6b5..97bf999`   | `docs/rfcs/rfc-0001-*.md`         |
| Generator bug fixes           | `97bf999..8bae686`   | BACKLOG "Known quirks"            |
| RFC-0002 assembly dedupe      | `c0a66fe~1..02d32e6` | `docs/rfcs/rfc-0002-*.md`         |
| Divergence fixes              | `02d32e6..eb8f0c9`   | BACKLOG entries, RFC-0002 Context |
| Pre-commit hooks, TSDoc pass  | `eb8f0c9..1fa2677`   | none (ad hoc)                     |
| RFC-0003 shadcn viewer        | `8053e60~1..fdd8dc3` | `docs/rfcs/rfc-0003-*.md`         |

## Behaviour Preservation Verdict

Both refactors claim byte-identical generator output. The claim was tested by
running the generator at each slice boundary against `~/git/aria-evals`, a
repository the golden fixture does not cover, in both modes, and diffing all
nine emitted artefacts (`map.json` compared with `generatedAt` removed, the
rest compared byte for byte).

| Boundary                                | Deployment mode  | Overview mode |
| --------------------------------------- | ---------------- | ------------- |
| RFC-0001 extraction `ca2e39a..97bf999`  | identical        | identical     |
| Generator bug fixes `97bf999..8bae686`  | 1 line, intended | identical     |
| RFC-0002 dedupe `8bae686..02d32e6`      | identical        | identical     |
| Divergence fixes onward `02d32e6..HEAD` | identical        | identical     |

Two consecutive runs of HEAD are also identical in both modes, so determinism
holds on a live repository as well as on the fixture.

The `fa4d6b5..97bf999` slice as a whole does change overview output by 1894
lines of `map.json`. Bisection attributes all of it to `7894d6c`, the
deliberate overview QA-stripping commit that regenerated both goldens. The
extraction proper, Phases 1 to 5, is byte-clean in both modes.

This is stronger evidence than the golden harness itself provides: the harness
parses both maps and compares with `toEqual`, which is semantic rather than
byte equality, despite the test being named "then output is byte-identical".

## Confirmed Defects

Each was reproduced by execution, not inferred from reading.

### Defect 1: Goldens Are Not Portable

`test/golden/mini-repo-deployment.json:5` and the overview golden both record
`"repository": "/Users/alistairbayley/git/code-as-city/test/fixtures/mini-repo"`.
`generateMap` compares the whole object, and `repository` is derived from the
test file's own location, so all three golden tests fail in any other clone or
in CI. With no CI configured, the pre-commit hook is the only enforcement
point, and this makes the project's central guardrail machine-specific.

### Defect 2: Path Reassignment Crashes Without a Root Package

`src/lib/assemble-deployment.ts` throws `Path reassignment without a package`.
`discoverPackages` never synthesises a root package, so in a monorepo with no
root `package.json`, a source file outside every package directory containing
a `"../..."` string literal that resolves into another package's directory
yields `{ pkg: null }` and reaches the throw.

Not introduced by the extraction. The pre-refactor `src/generate-map.mjs`
dereferenced `reassigned.pkg.id` unguarded and dies on the same input with
`TypeError: null is not an object`. The extraction faithfully preserved a
latent crash and gave it a clearer message. `src/lib/rooms.ts` handles the
same null with `continue`, which is the correct behaviour.

### Defect 3: Wrangler Name Pattern Is Unanchored

`src/lib/wrangler.ts` matches the worker name with
`/name\s*=\s*["']([^"']+)["']/`, which also matches inside `database_name`. A
`wrangler.toml` carrying a `[[d1_databases]]` block and no top-level `name`
yields the database name as the worker name, and `database_name` wins even
when a real top-level `name` follows it. The accompanying test places `name`
first, so it passes.

### Defect 4: The TypeScript Fallback Is Unreachable

`src/lib/complexity.ts` guards the compiler path with `if (ts)`, which tests
only that the dynamic import resolved, not that it produced a usable compiler.
When `(await import("typescript")).default` is a truthy object without
`ScriptTarget`, the generator dies with a `TypeError` instead of taking the
documented decision-point regex fallback. Reproduced at HEAD and at all four
historical commits by running with no `node_modules`.

Complexity feeds building heights and footprints (O6 into O5 and M11), so this
is also the one place where map output depends on the generator's own
environment rather than on the target repository.

### Defect 5: Repo-Controlled Text Reaches RegExp Unescaped

`src/lib/assemble-deployment.ts` interpolates `sub`, a Commander subcommand
token parsed from the target repository's CI workflow, directly into a
`RegExp` constructor. A regex metacharacter in a subcommand name either throws
a `SyntaxError` or silently fails to match. `src/lib/assembly-helpers.ts`
escapes its interpolations correctly; this site was missed.

### Defect 6: Viewer Tests Measure No Coverage

`vitest.config.ts` sets `coverage.include` to `["src/**", "viewer/lib/**"]`,
omitting `viewer/components/**`, so none of the 33 viewer chrome tests
contribute to the coverage report.

### Defect 7: Dockerfile Entry Detection Reads Only the First Line

`src/lib/dockerfile.ts` documents that entry detection considers any
`ENTRYPOINT` or `CMD` token naming an inventoried file, but its pattern is
non-global, so only the first such line is tokenised. The common split form,
an `ENTRYPOINT` naming the interpreter followed by a `CMD` naming the script,
returns null.

## Spec Divergences Recorded as Closed but Still Open

### Overview Database Targeting Still Picks the First Database

BACKLOG recorded the M8/O8 divergence as closed by routing both modes through
one district-local-else-first strategy in `src/lib/inference.ts`. The shared
strategy exists, but `src/lib/assemble-overview.ts` still selects a single
database and passes `databases: [{ id }]` with no `districtId`, so the
district-local preference can never fire and the overview still always targets
the first database.

### Entry Classification Has a Third Copy

BACKLOG named three partial copies of entry classification. Two were routed
through `isEntryPoint`. The third, the entry-directory room check in
`src/lib/assemble-deployment.ts`, is untouched, and the replacement BACKLOG
entry drops it from the record rather than justifying it as by design.

## Test Quality Findings

134 tests pass, but the number overstates the safety net.

The golden test runs the generator through `execFileSync`, so v8 coverage
never instruments it. `assemble-deployment.ts`, `assemble-overview.ts`,
`emit.ts`, `complexity.ts`, `host-config.ts`, `flow.ts` and `generate-map.ts`
all report zero coverage, and the full run reports about 30% of statements.
Those two large modules are pinned solely by what the `mini-repo` fixture
happens to exercise, and the fixture contains no external node, no `delivers`
edge, no `deploys` edge and no OTLP producer edge. The duplicated `delivers`
inference that RFC-0001 cites as its motivating example is entirely
unfixtured.

Only `map.json` is asserted. `map.md`, `deps-rooms.dot`, `deps-rooms.md`,
`coupling.json`, `deploy-shape.json` and `shared-libraries.md` could emit
anything at all and every test would still pass.

Two specific tests do not pin what they claim:

- `test/unit/viewer/sidebar.test.tsx` builds a harness that reimplements
  filtering as `label.includes(term)`, while the real filter matches label,
  kind and description. The test cannot fail if the real search breaks.
- `test/unit/inference.test.ts` asserts `edgesSoFar: 0` on a recorded
  callback, pinning private call order rather than observable behaviour.

## TSDoc Accuracy Findings

Eleven documented claims contradict the code. No false determinism or sorting
claims were found, which is the category that would matter most. The
substantive ones:

- `dockerfile.ts` promises any `ENTRYPOINT`/`CMD` token matches; see Defect 7.
- `reachability.ts` describes a breadth-first closure; `reachableFrom` pops,
  which is depth-first.
- `reachability.ts` cites R1 for the dev-tooling test where the function's own
  docblock correctly says R2.
- `rooms.ts` documents `segmentsFor` as returning a dominant segment or null;
  it returns an object.
- `assemble-deployment.ts` directs readers to HEURISTICS.md for rule IDs
  `7a` to `7f`, which are that file's own internal section markers.
- `assembly-helpers.ts` says every non-alphanumeric character is replaced,
  where underscores survive; and says basename minus extension, where
  `x.d.ts` becomes `x.d` and upper-case extensions are not stripped.
- `assemble-deployment.ts` documents a directory reference for dir-backed
  children, a null return that is `undefined`, and "the first imported
  identifier" where only braced named imports are scanned.
- `hosts.ts` omits that an equal-ranked variant also drops a host through the
  filename tie-break.

## Documentation Overclaims

- HEURISTICS.md was not updated in the wrangler bug-fix slice, although D7
  gained a new name source and two-step `main` resolution. This breaks the
  standing rule that HEURISTICS.md is updated whenever a generator rule
  changes.
- RFC-0003 Phase 5 records the reduced-motion block as replaced by Tailwind
  equivalents. `viewer/globals.css` still carries it, unlayered, with a
  comment explaining that an unlayered rule beats every layered one, which is
  the specificity technique the RFC's own problem statement condemned.
- RFC-0003's goal of reducing `RepoCity.tsx` to the scene graph, camera and
  selection state is ticked at 2091 lines, with the app shell, map loading and
  chrome view-model assembly still in the file.
- RFC-0002 nominates Effect.ts for the map envelope and typed emit errors.
  Nothing Effect-related landed and no deviation was recorded.
- The golden determinism test is named "then output is byte-identical" but
  compares parsed objects.

## Standards Findings

- `src/lib/complexity.ts` performs a top-level `await import` into a
  module-level mutable binding, against the rules that modules must be safe to
  import, that module-level mutable application state is prohibited, and that
  dynamic loading sits behind a documented seam.
- `viewer/lib/utils.ts` and `viewer/hooks/use-mobile.ts` are shadcn CLI output
  but sit outside `viewer/components/ui/**`, so the recorded exemption does
  not reach them; both lack TSDoc and explicit return types.
- `src/lib/coupling.ts` exports `couplingFromEdges` solely because a test
  wants it, which the design guidance names as an anti-pattern.
- `viewer/components/folder-browser.tsx` assigns `submitRef.current` during
  render, and its ref initialiser contains a `void forceOverview;` statement
  written only to satisfy `noUnusedParameters`.
- `viewer/RepoCity.tsx` calls `evidenceColors(ink)` inside `edges.map`,
  rebuilding the record per edge per render where it was previously a module
  constant.
- `viewer/components/viewport-overlays.tsx` uses US spelling in new TSDoc
  prose. The `neighborhood` identifiers in `viewer/lib/flow-layout.ts` are
  upstream functionary naming. (Superseded after the review: the whole
  neighbourhood/district split was a naming inconsistency rather than two
  concepts, and the viewer has since unified on district. See Resolution.)
- Two `eslint-disable` directives survive in `viewer/RepoCity.tsx` in a
  toolchain with no eslint.
- Several unit tests under `test/unit/` do real filesystem I/O, some of it in
  `describe` bodies at collection time.

## Findings Not Raised

The accepted deviations recorded in the RFCs and BACKLOG were excluded by
design and are not re-flagged: the generated `viewer/components/ui/**` surface,
the legend swatches and showcase card wrapper, the folder list highlight, the
dropped sidebar accent stripe, the overview's local fan-in and fan-out
helpers, and the two intended viewer behaviour changes. The trade behind the
dropped sidebar stripe is sound.

## What Held Up Well

- The extraction is unusually faithful. Every float constant matches, the
  7a-iii host-forwarding block is verbatim, and no array was replaced by a Map
  or Set anywhere in the refactor. `scanImports` still iterates the
  `sourceFiles` array, so edge order is preserved.
- Of the added `throw new Error` sites forced by strict TypeScript, all are
  genuinely unreachable except the pre-existing crash in Defect 2.
- The merged OTLP and database inference pass emits edges in the original
  per-module order in both modes, and no mode gained or lost a pass.
- Test names follow given-when-then throughout, with no exceptions found.
- The viewer chrome tests held the behaviour-only line. The single class
  assertion is `toHaveClass("dark")`, which is the theme hook's observable
  contract rather than styling.
- The pre-commit hook is correctly built: `.husky/_/h` runs `sh -e`, so a
  failing check genuinely aborts the commit rather than passing through the
  last command's exit status.
- `bun run check` is green at HEAD: typecheck, lint, knip and 134 tests.

## Resolution

Every finding above was actioned in the same session as the review. Fixes to
generator behaviour were written test-first; the fixture goldens were not
regenerated, because none of the fixes changes output on the fixture.

| Finding | Resolution |
| --- | --- |
| Defect 1: goldens not portable | `repository` normalised to `<fixture>` in the harness and goldens; a test now fails if a golden regains an absolute path |
| Defect 2: path-reassignment crash | `findPathReassignments` skips a claiming file owned by no package; `PathReassignment.pkg` is non-optional, so the throw is gone |
| Defect 3: unanchored wrangler name | `name` and `main` patterns anchored with `/m` |
| Defect 4: unreachable TypeScript fallback | Compiler load moved behind `loadComplexityCompiler`, an injectable seam that probes the API and returns null when unusable |
| Defect 5: unescaped RegExp interpolation | `escapeRegex` extracted and applied at the CI-subcommand site |
| Defect 6: viewer coverage gap | `viewer/components/**` and `viewer/hooks/**` added to `coverage.include` |
| Defect 7: Dockerfile first-line-only | All ENTRYPOINT/CMD lines scanned in file order |
| Overview database targeting | Reclassified as a mode difference by design, in code comment, HEURISTICS.md and BACKLOG |
| Entry classification third copy | Reclassified as a distinct room-level rule, in code comment and BACKLOG |
| TSDoc defects | All corrected |
| HEURISTICS.md stale for D3/D7 | Both rules and the D failure-modes paragraph updated |
| RFC-0003 reduced-motion and RepoCity scope | Deviations recorded against the ticked checkboxes |
| RFC-0002 Effect.ts | Outcome recorded: neither candidate was drop-in |
| sidebar test reimplemented the filter | Filter extracted to `viewer/lib/rail-search.ts`; the test drives the real rule, and kind/description matching is now pinned |
| `couplingFromEdges` exported for a test | Unexported; the behaviour is tested through `analyseCoupling` |
| Standards: dead eslint directives, missing TSDoc, US spelling, render-phase ref write, per-edge allocation | All fixed |

Two findings were **not** actioned, deliberately:

- The `inference.ts` call-order assertion was reported as pinning private
  ordering. It is not: `onImporters` running before the edges are emitted is
  documented contract that the deployment map depends on to parent the
  database node. The test was split so each case names one rule, and the
  assertion kept.
- Direct unit tests for `assemble-deployment.ts` and `assemble-overview.ts`,
  and fixture coverage for the unexercised rules, remain open. Both are
  larger pieces of work than this review; they belong in their own RFC.

  Partly addressed since (2026-08-27): the golden test now drives the generator
  in-process through `runGenerator` rather than shelling out with
  `execFileSync`, so v8 instruments the assembly modules the review reported at
  zero coverage. `assemble-deployment.ts` reaches 71% and
  `assemble-overview.ts` 87% (with `generate-map.ts`, `emit.ts` and the rest of
  the pipeline likewise now measured), and the overall statement coverage rose
  from about 37% to 66%. The fixture was also grown to exercise the rules the
  review named as unfixtured: an external node (the `openai` D17 client SDK),
  a `deploys` edge (a package-local `wrangler.toml` with a `src/api` entry-dir
  room), an OTLP producer edge (a `@opentelemetry` bootstrap module feeding an
  `otel-collector` compose service), and a `delivers` edge (the `ollama`
  single-word external referenced by `@mini/service`). Each has a focused
  golden assertion. This is still coverage through the fixture, not direct unit
  tests: the two modules have no test of their own, and the remaining uncovered
  branches (visible in the coverage report) are untouched. The dedicated
  per-module tests belong in their own follow-up.

  Note recorded while fixturing `delivers`: `inferExternalDelivers` normalises
  the external's *label* to lower-case alphanumeric, so a multi-word label such
  as "OpenAI API" becomes `openaiapi`, which the reference pattern can match
  neither in an import specifier nor as an `OPENAIAPI_` env prefix (real code
  writes `OPENAI_API_KEY`, i.e. `OPENAI_API`). Of the current SDK labels only
  the single-word "Ollama" can ever match; every other label ends in " API" or
  "server" and is unreachable. This looks like a latent defect in the signal,
  not just a fixture gap, and is left for a separate behaviour change rather
  than folded into this test work.

### Verification of the fixes

- `bun run check` green: typecheck, lint, knip, 151 tests (up from 134).
- The golden tests were run from a copy of the repo at a different path and
  passed, which they could not do before.
- Generator output was compared before and after the fixes against
  `~/git/aria-evals` (both modes), `~/git/aria-tools`, `~/git/nzlaw` and
  `~/git/functionary.dev`: byte-identical in every case. The fixes only alter
  behaviour on the specific shapes they address.
- The crash in Defect 2 was reproduced end-to-end before the fix and the same
  repository now maps successfully.

## Follow-up: Viewer Terminology Unified on District

Raised separately after the review, and settled here because it turned on a
review question: were the viewer's neighbourhoods and districts two concepts
or one name too many?

They were one concept. `viewer/lib/flow-layout.ts` grouped nodes into
"neighbourhoods" while keying the very same groups as `districtLayer` and
`maxDistrictLayer` in the same function, and `RepoCity.tsx` counted them as
`districtCount`. What genuinely differs from a district is the map's *scope
node*, and the layout code already had a separate, consistent name for that:
`scope`, in `scopeById`, `scopeOrder` and `scopeOfNode`.

So the rename merges nothing. `neighbourhood` became `district` across the
viewer (226 occurrences in five files), and the two synthetic districts keep
their explicit forms: `__near:<scope>` satellite strips and `__system`. The
rail and in-scene markers now read `D1`, `D2`, ... rather than `N1`, `N2`,
and the status line reads "N districts".

Not renamed: `distinct-neighbour` in `test/unit/coupling.test.ts`, which is
graph vocabulary (a node's neighbours in the import graph), unrelated to the
city's districts.

The two completed RFC-0003 checkboxes that describe "neighbourhood sections"
were left as written: they record what was planned and built under the name
in use at the time.
