---
id: REVIEW-0007
name: Code review of candidate 4 (direct tests for the big assembly phases)
status: Complete
owners:
    - alistairbayley
created: 2026-08-31
updated: 2026-08-31
reviews: working tree vs 960c965
---

# Code review of candidate 4 (direct tests for the big assembly phases)

| Stage     | Timestamp  |
| --------- | ---------- |
| Authored  | 2026-08-31 |
| Completed | 2026-08-31 |

## Review Scope

The change set is uncommitted in the working tree; HEAD equals the fixed point
`960c965`, so the review diffs the working tree against that commit. This change
is **tests-only** — no production code changed. Reviewed on the two axes the
`code-review` skill covers, run as parallel sub-agents:

- **Standards** — test quality against the repo conventions and the TDD
  test-quality guidance (given/when/then names, seam-level testing, observable
  results over internals, no tautology, no assertion roulette).
- **Spec** — fidelity to candidate 4 in
  [review-0002-architecture-20260830.html](review-0002-architecture-20260830.html)
  (lines 205-263), "Narrow the four golden-only assembly phases".

Files under review:

- MOD `test/unit/assemble-deployment-phases.test.ts` — new describe blocks for
  `assembleDatabases`, `assembleStaticClassification`, `assemblePackageDistricts`,
  `assembleHostDistricts`.
- MOD `test/unit/assemble-overview-phases.test.ts` — `assembleInfraDistricts`.

**Scope decision (agreed with the user before implementing):** candidate 4 was
scoped to **part 3 only** (add direct unit tests). Parts 1 (move the three side
channels into `AssemblyState`) and 2 (declare per-phase reads/writes) were
deliberately not done — part 1 contradicts the `AssemblyState` TSDoc
([assemble-deployment-phases.ts:56-64](../../src/lib/assemble-deployment-phases.ts))
that keeps handoff values out "so the pipeline's data flow stays visible", and
part 2 is already satisfied by the typed options (readers take `ReadonlySet`,
writers take `Set`).

The two axes are reported separately below and deliberately not merged or
re-ranked.

## Standards

Verdict: strong characterisation tests, no hard standards breaches.

### Standards hard violations

None. The tests are seam-level (call the exported phase, assert on
`state.nodes`/`edges`/`warnings` or the return value), use builders instead of
repeated literals, and given/when/then names follow the convention. No `any`, no
emoji, British spelling intact; nothing asserts call order or internal
collaborators. tsc/biome/knip/vitest pass.

### Standards judgement calls

1. **Stub-and-assert-back (mild tautology risk).** In
   `assembleStaticClassification`, `fileMaxFunctionComplexity: () => 7` then
   `expect(...complexity).toBe(7)`, and `coverageForFiles: () => 0.42` then
   `expect(...coverage).toBe(0.42)`. Not pure tautologies — they verify the
   metric is plumbed to the right key and fail if the wiring breaks — but they
   characterise mapping, not computation. (The genuinely independent cases are
   good: the composed `"Serves the API.\n\nExisting."` description, and the
   scrambled `sourceFiles` order asserting preserved `["mod-b","mod-a"]`.)
2. **Two scenarios in one test.** The coverage test asserts both the
   present-and-omitted cases in a single `it` whose name carries two
   given/when/then clauses. Split into two.
3. **Assertion Roulette.** The `assembleHostDistricts` dockerfile case has five
   distinct observable assertions in one test; the sizing test has three, and
   its `typeof loc === "number"` is a weak assertion (passes on any number).
   Label or split; strengthen the loc assertion.
4. **Filesystem I/O in unit tests (pre-existing, out of scope).** The suite
   writes a real temp repo because `assembleStaticClassification` reads disk via
   `readText`/`linesOf` rather than the injected `state.fileText` fake. This is a
   production seam limitation, not fixable in a tests-only change; noted.

No Mystery Guest issues; the builders (`embeddedDb`, `staticOpts`, `pkgOpts`,
`hostOpts`, `infraOpts`, `room`) correctly factor the large option bags.

## Spec

Verdict: part 3 delivered faithfully; the parts 1-2 deferral is evidence-backed.

### Spec — coverage of the card's named behaviours

- **"the only producer of user-facing warnings gains direct tests"** — both
  warning branches in `assemblePackageDistricts` (orphan-area, dev-only R5
  exclusion) now have dedicated tests. Direct hit.
- **"ordering assumptions become assertable"** — `assembleDatabases` drives the
  `nodeIds` snapshot three ways (owner area present → drawn; D1 binding already
  in snapshot → not re-drawn; owner area absent → not drawn), plus
  `sourceFiles`-order replay — exactly the load-bearing snapshot-timing
  dependency the Problem section named.
- `assembleHostDistricts` covers the side-channel writes concretely
  (`claimedSegments`/`serviceClaimedDirs`/`campusFileSets`/`fileNodeOwner`).
  `assembleStaticClassification` is well covered.

### Spec missing or partial requirements

- **Thin coverage on two phases.** `assembleInfraDistricts` gets a single
  happy-path test (image-only backing store) — no external-receiver, drizzle, or
  edge-host paths despite its wide surface. `assemblePackageDistricts`' happy
  path asserts only that the district is drawn, not its interior/layering.
  Acceptable as a start; flagged as the weakest of the five.

### Spec — the parts 1-2 deferral

Defensible on the evidence, not a dodge. Part 1's target
(`AssemblyState` at [assemble-deployment-phases.ts:60-63](../../src/lib/assemble-deployment-phases.ts))
is explicitly documented to keep handoff values out "so the pipeline's data flow
stays visible" — moving the sets into a shared mutable object works against the
card's own stated benefit ("what a phase depends on becomes readable from its
signature"). Part 2 is already satisfied: `assemblePackageDistricts` takes the
sets as `ReadonlySet` (reads), `assembleHostDistricts` as mutable `Set` plus a
mutable `campusFileSets` array (writes) — reads-vs-writes is in the types today.

### Spec scope creep

None. Two test files only; no production code, no unrelated tests touched.

## Summary

- **Standards:** 0 hard violations; 4 judgement calls, all minor and confined to
  test code. Worst within axis: the assertion-roulette + weak `typeof` assertion
  in the `assembleHostDistricts`/sizing tests.
- **Spec:** part 3 delivered faithfully; both card-named behaviours (warnings,
  ordering) directly tested; parts 1-2 deferral evidence-backed; 0 scope creep.
  Worst within axis: the thin `assembleInfraDistricts` and package-district
  happy paths.

## Resolution (2026-08-31)

All four convergent remediations applied (tests-only; `bun run check` green):

1. **Coverage test split** into two `it`s — one for coverage present, one for
   coverage omitted.
2. **`loc` assertion strengthened** — the sizing test now asserts a concrete
   `loc` of 3 (two content lines plus the trailing newline, per `linesOf`'s
   `split("\n")`), with a comment explaining the count, instead of `typeof
   ... === "number"`.
3. **`assembleHostDistricts` dockerfile case split** into three focused tests
   (handoff-set claims; campus file set + file ownership; node shape), sharing a
   `dockerfileHosts()` fixture builder — no more assertion roulette.
4. **`assembleInfraDistricts` second case added** — a host declaring an external
   OTLP receiver now asserts the external node lands in the external-systems
   district, lifting it above a single happy path.

The two noted-but-out-of-scope items stand: the mild stub-and-assert-back
mapping checks (they verify plumbing and are paired with genuinely independent
cases), and the filesystem I/O in these unit tests (a pre-existing production
seam — `assembleStaticClassification` reads disk directly rather than through the
injected `state.fileText`, so it cannot be removed without a production change).
