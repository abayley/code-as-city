---
id: REVIEW-0011
name: Code review of HC-018, HC-021 and HC-026
status: Complete
owners:
    - alistairbayley
created: 2026-09-22
updated: 2026-09-22
reviews: working tree vs 355f72e
---

# Code review of HC-018, HC-021 and HC-026

| Stage      | Timestamp  |
| ---------- | ---------- |
| Authored   | 2026-09-22 |
| Remediated | 2026-09-22 |

## Review Scope

Uncommitted working tree (standalone-Dockerfile host, bundled-library
discount, Python inventory) diffed against the fixed point `355f72e` via
`git diff HEAD` (20 tracked files, 669 insertions, 71 deletions; plus 7 new
untracked fixture files). Reviewed on the two axes the `code-review` skill
covers, run as parallel sub-agents:

- **Standards** — conformance to `~/.agents/coding-standards.md`,
  `coding-standards-typescript.md`, `agent-design-and-test-guidance.md`,
  `markdown-rules.md`, and the repo's `AGENTS.md`, plus the Fowler smell
  baseline.
- **Spec** — fidelity to the HC-018, HC-021 and HC-026 Direction sections as
  of the fixed point (`git show 355f72e:docs/heuristic-changes.md`).

## Standards

No hard documented-standard breaches. Rule homes kept (S1 in `packages.ts`,
D1 in `hosts.ts`, D14 in `assemble-deployment-phases.ts`, M13 in `scans.ts`,
O10 in `assemble-overview.ts`); `HEURISTICS.md` rows and failure modes
updated; HC entries flipped Proposed to Done with evidence and fixture
verification; British spelling holds; new test cases use given-when-then
with targeted matchers, no broad snapshots.

1. **Judgement — Duplicated Code (id suffix).** `hosts.ts`'s
   `for (let suffix = 2; takenIds.has(id); suffix += 1)` repeats the HC-015
   suffix loop now in `discoverPackages`/`discoverPythonPackages`
   (`packages.ts`). The shared id-suffix shape wants one helper.
2. **Judgement — Duplicated Code (pyproject parse).**
   `discoverPythonPackages` calls `pythonProjectName(...)` twice per dir
   (once for the id, once for the name), parsing the same `pyproject.toml`
   twice; bind once.
3. **Judgement — possible Feature Envy.** `assemble-overview.ts`'s
   `hosts.find((h) => h.name === name)?.file ?? ""` inside the `bandNames`
   sort reaches into `Host` data to decide another module's band label;
   canonical-file knowledge now arrives via `isCanonicalComposeFile`.
4. **Judgement — Message Chains / cost.** Same hunk: the `hostFileOf`
   linear scan runs per comparator (`O(n log n · n)`); precompute a
   `Map<name, file>`.
5. **Judgement — Shotgun Surgery (accepted trade-off).**
   `discoverPackages(repo, dirs, usedIds)` threads `usedIds` through
   `generate-map.ts` so Node/Python families share the HC-015 namespace;
   one logical id change now touches three signatures.

## Spec

(a) Missing or partial:

1. **Dev-stance is filename-blind (HC-018).** *"Needs a guard against
   double-counting when compose *also* builds the same Dockerfile, and a
   stance on Dockerfiles that are clearly dev or test images."* Test-path
   and double-count guards are done; the dev stance is only "a dev-server
   ENTRYPOINT/CMD tags the service `dev-environment`". A `Dockerfile.dev` /
   `Dockerfile.test` with a normal CMD still draws a full production host.
2. **Dockerfile name pattern is narrow (HC-018).** *"Treat an inventoried
   Dockerfile with no compose owner as a single-service host."* Code matches
   only `/^Dockerfile(\..+)?$/`; lowercase `dockerfile`,
   `Dockerfile-prod` / `Dockerfile_test` (dash/underscore, no dot) never
   become hosts despite "per inventoried `Dockerfile*`" in the Resolution.
3. **Python test hygiene missing (HC-026).** The import-graph and D17
   follow-ups are correctly deferred, but `TEST_FILE_PATTERN`
   (`/\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/`) does not exclude pytest
   `test_*.py` / `conftest.py`, so Python tests are inventoried as
   rooms/shape.
4. **Release-evidence gate deferred (HC-021).** *"a release-evidence signal
   … as a second gate"* — explicitly deferred in the Resolution, so
   genuinely-published-and-bundled (paperclip's adapters) currently reads
   only as `bundled`.

(b) Scope creep:

None material. The `assemble-overview.ts` canonical-band fix, the
`isCanonicalComposeFile` export, the M13 `firstParagraph` refactor, and the
`HEURISTICS.md` D1/D14/S1/M13/O10 updates all directly serve the three
Resolutions.

(c) Implemented but looks wrong:

1. **`pythonProjectName` is section-unbounded (HC-026).** Resolution: "name
   from pyproject `[project] name`". The parser slices from `[project]` with
   no end-of-section bound, so a `name` under a later `[project.urls]` /
   `[project.scripts]` / `[tool.*]` table misnames the package.
2. **Bundled check is directory-identity, not file-membership (HC-021).**
   Resolution: "skips a published package whose directory a host image
   COPYs". The implementation checks `owningPackage(dir) === pkg` per
   `serviceClaimedDirs` entry, so a coarse `COPY packages packages` /
   `COPY . .` (whose owning package is the root) fires no bundled tag even
   though the files landed in the image — under-discounting the coarse-COPY
   case the entry was written for.

## Summary

Standards: 5 findings (0 hard — all judgement-call smells); worst: the
duplicated id-suffix loop across `hosts.ts`/`packages.ts`. Spec: 6 findings
(4 partial, 0 creep, 2 wrong); worst: the HC-021 directory-identity check
under-discounts coarse-COPY bundling.

## Remediation

Every finding addressed, by code change, doc change, or recorded decision:

| Finding | Remediation |
| --- | --- |
| S1 duplicated id-suffix loop | All three call sites (`discoverPackages`, `discoverPythonPackages`, the standalone host) now use the existing `uniqueId` helper from `assembly-helpers.ts` (no new abstraction; runtime-import safe — that module's `packages` import is type-only) |
| S2 double pyproject parse | `discoverPythonPackages` parses the manifest once per directory; the name feeds both id and display name |
| S3 Feature Envy (band label) | Canonical-file knowledge computed once as a `Set` of canonical host names; the comparator only reads the set |
| S4 host-file scan per comparison | Same change: one precomputed set, no per-comparison walk |
| S5 usedIds threading | Accepted as-is (decision): the shared HC-015 namespace across Node/Python families is the point; three signatures threading one set is the honest shape. Recorded here |
| SP-A1 dev-stance filename-blind | A dev/test/local filename qualifier (segment-wise, so `Dockerfile-latest` stays a host) tags the service `dev-environment` — a tag, not an exclusion, per HC-024 (`hosts.ts` unit tests) |
| SP-A2 narrow Dockerfile pattern | Pattern widened to `/^[Dd]ockerfile([-_.].+)?$/`: lowercase and `-`/`_` qualifiers bind (`hosts.ts` unit tests) |
| SP-A3 pytest hygiene | `test_*.py` and `conftest.py` are I4 test paths whatever directory they sit in (HEURISTICS.md I4 row updated; pinned by a fixture `test_helpers.py` plus an `inventory.ts` unit test) |
| SP-A4 release-evidence gate | Deferred (decision, as the Resolution already recorded): genuinely-published-and-bundled reads as `bundled`; HEURISTICS.md failure modes carry the deferral. Recorded here |
| SP-C1 unbounded `[project]` match | The name match is bounded to its own section — body split at the next `[...]` header (`packages.ts` unit test with a later `[tool.setup]` name) |
| SP-C2 directory-identity bundling | The claim reads two ways: claimed directory owned by the package, or claimed file of the package (coarse parent COPY still bundles landed files). HEURISTICS.md D14 row updated; a phase unit test pins the file-membership arm |

Verified after remediation: `bun run check` green (typecheck, lint, knip,
425 tests with coverage); goldens unchanged by the remediation pass (the
fixture exercises none of the tightened paths except the pytest exclusion,
which draws no node). Note: a self-map over this repo fails the vendored
validator ("Building code-as-city-src must contain at least two rooms") —
verified identical on the fixed point via a clean HEAD worktree, so
pre-existing and out of scope.
