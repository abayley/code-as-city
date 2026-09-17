# code-as-city Agent Guide

A deterministic generator (`src/`) that turns a repository into a Functionary
city map, and a three.js viewer (`viewer/`) that renders it. Golden-master
tests over `test/fixtures/mini-repo` are the behaviour-preservation gate for
the generator.

## Read First

- `README.md` — what the project is, how to run it, what each run emits.
- `HEURISTICS.md` — before touching `src/lib/`: every rule the generator
  applies, its ID, and the module that implements it. Rule IDs are cited in
  map warnings, commit messages, and reviews.
- `docs/heuristic-changes.md` — before proposing a generator behaviour
  change: the HC-NNN catalogue of candidate rule changes and their status.
  Check whether the change is already recorded.
- `BACKLOG.md` — agreed ideas not yet built, mode differences that are by
  design (not bugs), and known bugs.
- `vendor/functionary/city-map-schema.md` — the map schema the generator
  emits and the viewer validates.

## Standards Outside the Repository

Code and reviews are judged against the global standards in `~/.agents/`:
`coding-standards.md`, `coding-standards-typescript.md`,
`agent-design-and-test-guidance.md`, `markdown-rules.md`, and
`rfc-template.md`. Read them before editing. If they are absent on this
machine, ask for them; the repository does not carry a copy.

## Local-Only Directories

`out/`, `baseline/`, `coverage/`, and `dist/` are gitignored. A fresh clone
has none of them.

- `viewer/lib/local-showcases.ts` statically imports seven maps from `out/`.
  Until they exist, `bun run typecheck`, `bun run dev`, and `bun run build`
  fail with TS2307 on that file. Generate them with `bun src/generate-map.ts`
  over the named repositories, or edit the import list to what you have.
- `test/fixtures/mini-repo/coverage/` is written by the test run itself, so
  run `bun run test` once before running the generator over the fixture.
- `docs/refactoring.log` is a local tool log, not documentation.

## Generator Changes

- Each rule has one home: the module `HEURISTICS.md` names for its group. A
  shared inference rule that fires in both map modes lives once in
  `src/lib/inference.ts` with per-mode options; shared sweeps such as M4 stay
  in the emitting module.
- Adding a rule: take the next ID in its group, add its row to
  `HEURISTICS.md` (signal, action, failure modes, tuning constants), and cite
  the ID in the commit message.
- Any change to golden output is intentional and explained. Regenerate the
  goldens with the commands in `README.md` and describe the diff in the
  commit.

## Viewer Changes

- Pure logic lives in `viewer/lib/` as deep, pure modules (`navigation.ts`,
  `projection.ts`, `flow-layout.ts`, `sizing.ts`) with unit tests under
  `test/unit/viewer/`. `RepoCity.tsx` holds the react-three-fiber scene and
  wires the chrome together.
- `viewer/components/ui/` is shadcn CLI output. Regenerate it with the CLI;
  knip ignores it for that reason.
- The chrome uses stock shadcn components only. Colour that varies per item
  travels as data (a Badge, a prop), never as an inline hex.

## Documentation Conventions

- `docs/rfcs/rfc-NNNN-slug.md` — the plan for a multi-commit change, from
  `~/.agents/rfc-template.md`: frontmatter (`id`, `name`, `status`, `owners`,
  `created`, `updated`, `supersedes`, `superseded_by`), a stage timestamp
  table, and phased checklists ticked as each item lands.
- `docs/reviews/review-NNNN-slug-YYYYMMDD.md` — a review of a change set on
  two axes, Standards and Spec, with `reviews: <head> vs <base>` in the
  frontmatter. `review-0002-architecture-20260830.html` is the exception: an
  architecture review whose numbered candidates 1 to 6 are the refactors that
  the "candidate N" commits and reviews 0003 to 0007 refer to. Candidates 1
  to 5 have landed; candidate 6 (a text seam for the host-config scan) is
  open.
- `docs/heuristic-changes.md` — HC-NNN entries, each with evidence and the
  rules it touches, status Proposed, Accepted, Done, or Rejected. A heuristic
  change gets an HC entry first, then either an RFC or a direct change with
  regenerated goldens.
- Prose and code use British spelling.

## Commit Conventions

- The pre-commit hook runs lint-staged, typecheck, knip, and the full test
  suite with coverage, so a commit takes a while. Run `bun run check` first
  and commit only when it is green.
- Commit subjects lead with the area (`Generator:`, `Viewer:`, `Tests:`,
  `Docs:`) and cite the rule, HC, RFC, or review IDs the change serves.
