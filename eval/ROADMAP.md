# Eval loop — roadmap

Status as of 2026-07-19. Loop machinery is **complete** (implementer protocol,
golden oracle + scorer, SysTest runtime oracle, improver toolchain, corpus
scoreboard, CI regression gate — see PR #617 and `git log` for history).
Full suite **1428/1428** green; `eval-gate` workflow green. Catalog: **40
cases** across tiers L0–L4, of which **11 await golden capture on the VM**
(`golden_pending`). This file tracks only what is still open, ordered by
priority.

Context for P1–P4: public review feedback (LinkedIn thread on the part-4
article, 2026-07-19 — Denis Trunin, Reza Alirezaei) flagged (a) factually
shaky AI-drafted skill content and (b) no public evidence of reliability.
The README/docs "CustAccount" verify example was already replaced with a
real impact-analysis prompt (2026-07-19); the rest is below.

## P1 — Skill & knowledge content audit (VM, urgent, do first)

Public criticism showed at least one concrete defect:
`d365fo-cli/skills/anthropic/sysoperation-batch-patterns/SKILL.md` claims
"SysOperation supports [DataContractAttribute] serialisation — parameters
survive AOS restart" as a differentiator vs RunBase — misleading:
RunBaseBatch parameters also survive restarts (pack/unpack to the batch
table). Same file: "sent to batch queue via canGoBatch" (garbled),
`SysRunnable::run()` (verify this type exists in the AOT at all — suspected
hallucination), `select count(*)` presented in an X++ context, and
`--install-to FleetManagement` demo-model examples throughout. Audit ALL
skill files (d365fo-cli repo) and all 50 `xppKnowledge.ts` entries on the VM:
every named API/type must resolve against the symbol index; every code
example must compile (route through `validate_code`/build where feasible).
Knowledge content must pass the same fail-closed gate as generated code —
that asymmetry is exactly what the public criticism exposed. Output: a
defect list + fixes, and a repeatable `knowledge-audit` script so this runs
in CI against the index snapshot thereafter.

## P2 — Define "100%": coverage taxonomy (VM-free, 1–2 days)

Build `eval/COVERAGE.md` + machine-readable `eval/coverage.json` from three
sources: (1) AOT element types from the metadata parser — mechanically
complete list of everything developable; (2) Microsoft Learn X++ dev TOC —
cross-cutting topics that are not AOT elements (transactions, CoC rules,
performance, upgrade patterns); (3) real-world frequency weights mined from
customization git history + community sources. Each taxonomy leaf gets three
flags: **K** (knowledge entry exists) · **E** (eval case green) · **T**
(tool path can create/validate the artifact). 100% = K∧E∧T on every leaf.
Two published tiers: **core** (anything done at least once per project — hard
commitment) and **total** (incl. exotics like license codes — visible
asymptote), so the metric neither corrupts nor demotivates.

## P3 — Automated gap audit (VM-free, 1 day, after P2)

Script that generates the matrix from reality, not by hand: reads
`KNOWLEDGE_BASE` titles/keywords, eval case ids, and the tool registry, maps
them onto the taxonomy, and reports orphans (knowledge entry with no eval
case = unproven knowledge). Already-known holes it will formalize: workflow
(K yes, E no), KPIs/tiles + XDS (no K, no E — deliberately deprioritized,
rarer in custom-model work), multi-dataset SSRS (T blocked, see P6), custom
services / OData actions, aggregate measurements, deeper DMF/dual-write.

## P4 — Coverage as public CI metric (VM-free, 0.5 day, after P3)

Coverage script runs in the `eval-gate` workflow; percentage + per-domain
table generated into README (badge). A new AOT type or topic without K∧E∧T
visibly drops the number. Doubles as the public reliability benchmark
(pass rates per tier) promised in the LinkedIn thread replies.

## P5 — Capture the 11 pending goldens (VM)

11 of 40 cases are `golden_pending`, including
`L4-bridge-drops-data-entity-primarytable-fields-on-create`, which encodes
the known data-entity caller-wiring gap (the shared XML builder populates a
real query when `primaryTable`/`fields` are passed, but callers still need
to know to pass them). Capturing these goldens closes the catalog and turns
the wiring gap into a scored, regression-gated case.

## P6 — Expose `additionalDatasets` for multi-dataset SSRS

`generate_object`'s `additionalDatasets` parameter is implemented internally
(`generateSmartReport.ts`) but not exposed in the MCP tool schema
(`src/server/toolSchemas/generateObject.ts`), so it is unreachable via the
actual tool interface. Wire up the schema, then add a multi-dataset SSRS
case (`L4-ssrs-report-advanced` covers a filter contract parameter instead).

## P7 — Coverage closure loop (VM, ongoing, ~2–4 leaves/week)

The machinery already exists; this just gives it a queue ordered by
matrix-gap × frequency weight: `eval-author` drafts a case for each leaf
missing E → `eval-run` captures the golden on the VM → MODEL_ERROR clusters
flow through `knowledgeFeedback` into proposed knowledge entries (human
review stays mandatory, as the module enforces) → TOOL_DEFECT/VALIDATOR_GAP
go down the standard improver path. For leaves where model training data is
weak, knowledge entries get a canonical minimal example mined from the real
AOT (example mining), not written from memory.

## P8 — Staying at 100% (ongoing, after P4)

Platform moves with every PU: a monthly release-notes check adds new leaves
flagged `uncovered`, so 100% is always relative to the current platform
version and staleness is visible instead of hidden.

## Blocked / declined (not planned)

- `SysTestConsole.exe` requires an interactive console session
  (unconditional `WaitForDebugger()`/`Console.ReadKey()` even in local-AOS
  mode) — a platform limitation, not fixable from this side. 3 cases stay
  `systest_pending: true` (`L2-coc-extension`, `L3-batch-basic`,
  `L2-event-handler-basic`). `vstest.console.exe` +
  `RunnableDropSysTest.TestAdapter.dll` was tried as a non-interactive
  alternative — discovers zero tests, dead end.
- CI-workflow half of the autonomous improver — the VM-free fix-brief
  generator (`npm run eval:brief`) is done; running Claude Code unattended
  on top of it in GitHub Actions was proposed and **explicitly declined**
  (new autonomous-agent surface needing its own sign-off). Not planned
  unless asked again.

## Invariant (never break)

All eval writes pinned to the `contoso` sandbox; never add
`D365FO_CUSTOM_PACKAGES_PATH` targeting a real model (§11).
