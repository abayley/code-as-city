---
id: REVIEW-0009
name: Code review of HC-020, HC-027, and HC-028
status: Complete
owners:
    - alistairbayley
created: 2026-09-21
updated: 2026-09-21
reviews: ee34f6c...HEAD
---

# Code review of HC-020, HC-027, and HC-028

| Stage    | Timestamp  |
| -------- | ---------- |
| Authored | 2026-09-21 |

## Review Scope

Commits `724c03e` (Generator: image-identity folding, D14 entry chain,
unified package districts) and `34eb6f5` (Docs: resolve HC-020, HC-027,
HC-028), diffed against the fixed point `ee34f6c` — where
REVIEW-0008's scope ended — via `git diff ee34f6c...HEAD` (19 files, 785
insertions). Reviewed on the two axes the `code-review` skill covers, run as
parallel sub-agents:

- **Standards** — conformance to `~/.agents/coding-standards.md`,
  `coding-standards-typescript.md`, `agent-design-and-test-guidance.md`,
  `markdown-rules.md`, and the repo's `AGENTS.md`, plus the Fowler smell
  baseline.
- **Spec** — fidelity to the HC-020, HC-027, and HC-028 Direction sections as
  of the fixed point (`git show ee34f6c:docs/heuristic-changes.md`).

## Standards

1. **Hard — debug output shipped.** `src/lib/assemble-deployment-phases.ts:1251`
   carries a `console.log("DBG", pkg.name, "residual: ...")` left in by the
   immich investigation. Breaches `coding-standards.md` ("clean up
   intermediate/scratch files after task completion") and pollutes every
   generator run. Must be removed.
2. **Hard-adjacent — duplicated comment.** The "takes that service's role
   label ('Server' from 'Immich Server')" comment appears twice, three lines
   apart; the first is dangling above the debug block.
3. **Judgement — Data Clumps / Primitive Obsession.** `{ name: string;
   image?: string | undefined }` is spelled inline in four signatures
   (`isServiceShadowed`, `serviceOwnerKey`, the two `isShadowed` seams). The
   name+image identity is HC-020's domain concept; it wants a named type with
   one home.
4. **Judgement — Duplicated Code (minor).** `hosts.ts` builds
   `serviceNames` and `serviceIdentities` sets from the same `host.services`,
   and the rank-1 dedup branch re-derives the other's name set inside the
   filter; one parameterised key builder would collapse the arms.
5. **Judgement — comment restating the catalogue.** The ~20-line narrative
   above the HC-028 hunk largely restates HEURISTICS.md's M3 row; AGENTS.md
   endorses rule-ID citations, not verbatim restatement. Trim.
6. **Suppressed** — the `isShadowed` wrapper (Middle Man) is the existing
   seam pattern; the fixture's CommonJS `esbuild.js` is production-shaped
   fixture data, not project code.

Compliant: TSDoc on new exports, kebab-case, British spelling, given/when/
then test names with pinned HC IDs, goldens regenerated intentionally,
markdown tables formatted.

## Spec

(a) Missing or partial:

1. **HC-020 variant tags.** *"same name with different images stays
   distinct, tagged as the variants they are"* — the nodes are distinct but
   carry no variant/alternative tag anywhere in the diff. Partial.
2. **HC-027 dist-cite.** *"an entry that is the dist path itself when no
   source match exists (keep the node, cite the dist file)"* — deferred with
   the HC-028 dependency recorded. Known, accepted deferral.
3. **HC-028 collapse arm.** *"attach to that district as a support room (or
   collapse when they are build scripts of the package's one artefact)"* —
   only the attach arm exists; the Direction offered either, but the choice
   is not recorded as a decision.
4. **HC-028 precedence decision.** *"a decision on the name source's
   precedence (tag vs package name vs D14 entry)"* — `packageDistrictLabel`
   implements tag-if-unique, then service role, then package name, and adds
   a repo-wide CLI-uniqueness gate the Direction never stated; neither the
   gate nor the D14-entry arm's absence is justified in the Resolution.

(b) Scope creep:

1. **I4 test-compose exclusion in D1** — not in the HC-020 Direction;
   justified only in the Resolution (it became necessary once image-identity
   dedup let `tests/` and `dev/` composes surface as districts). Deliberate
   but undocumented in the Direction.
2. **`stripJsComments` in this diff** — the comment-guard work belongs to the
   REVIEW-0008 remediation but `src/lib/text.ts` was omitted from e41dc89's
   staging list, so the function only landed with 724c03e. The symptom is
   creep in this diff; the cause is an incomplete commit: **e41dc89's tree
   does not standalone-typecheck** (its `inference.ts` imports a
   `stripJsComments` that does not exist at that commit).
3. The live `console.log` (also Standards finding 1).

(c) Implemented but suspect:

1. **Dev-variant carve-out (`host.rank < 2`)** keeps name-only dedup for a
   whole rank class — the very name-matching HC-020 calls over-firing. There
   is a pinned unit test ("given a dev-ranked variant its canonical covers by
   name, when deduped, then the dev variant drops"), so the behaviour is
   intentional and covered; the Direction's "check the interaction" is
   satisfied, but the carve-out's breadth is a recorded judgement, not a
   spec line.
2. **Service-role label prefix match.** `serviceLabel.startsWith(own)` —
   a package `media` under service `media-processor` reads "Processor"
   (arguably right), but `media-db` would read "Db" (wrong). A word-boundary
   guard (`startsWith(own + " ")`) would match the spec's example without
   the false positives.

## Summary

Standards: 6 findings (2 hard — the shipped `console.log` and the duplicated
comment); worst: the debug output in the committed generator. Spec: 8
findings (4 partial, 3 creep — one of which is the e41dc89 staging omission,
1 suspect); worst: e41dc89's tree not standing alone, with the untagged
HC-020 variants the largest unfinished spec arm.
