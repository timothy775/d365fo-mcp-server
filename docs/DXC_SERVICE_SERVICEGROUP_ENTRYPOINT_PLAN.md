# Plan — Close the service / service-group / privilege-entry-point gaps

## Objective

Three related gaps surfaced while trying to stand up a REST-exposed service for
`DXC_TMSRouteStatusInboundProcessor` and grant it via the existing
`DXC_TMSRouteStatusInboundMaintain` privilege:

| # | Gap | Kind | Status before this plan |
|---|---|---|---|
| A1 | `service-group` has no read tool (`get_object_info`) | Read-side gap | Never implemented |
| A2 | `service`/`service-group` **create** rejected on some running `d365fo-local` processes | Deployment/staleness, not code | Already fixed in source (`e5f307d`, 2026-07-21); some deployed checkouts/processes predate it |
| A3 | Azure security-object search index returns false-negative "not found" for a privilege that verifiably exists on disk | Data-quality gap | Observed once, not yet root-caused |
| B | No `modify` operation adds an entry point (menu item **or** service operation) to an **existing** `security-privilege` | Code gap | Never implemented |

A1/A3 are read-side. A2 is an ops/rollout problem, not a code change (already
tracked in [[Ninja MCP]] / `docs/DXC_...` on the Obsidian side — not duplicated
here). **B is the one genuine, currently-unimplemented capability gap** and is
what actually blocked attaching the entry point.

---

## Current-state inventory

### Create path (already works, in source)

| Piece | Location |
|---|---|
| `objectType` enum has `service`/`service-group` | `src/server/toolSchemas/d365foFile.ts:43` |
| XML builders | `src/tools/xml/serviceXml.ts` — `buildAxServiceXml`, `buildAxServiceGroupXml` |
| Dispatch in `create` | `src/tools/write/createD365File.ts:1414-1417` |
| Both types deliberately bypass the C# bridge's structured-`properties` channel — direct-XML only | not in `BRIDGE_CREATE_TYPES` (`src/bridge/bridgeAdapter.ts:1228`), same reasoning as `security-privilege`/`security-duty`/`security-role` (comment at `bridgeAdapter.ts:1221-1226`) |

### Read path (partially works)

| Type | Reader | Registered in `get_object_info`? |
|---|---|---|
| `service` | `src/tools/readers/serviceInfo.ts` (`getServiceInfoTool`) — reads `symbols` (`type='service'`), `service_operations`, `service_group_members` from the SQLite symbol index | Yes — `src/tools/readers/objectInfoRegistry.ts:85` |
| `service-group` | **None** | **No** — absent from the `objectType` enum in both `src/server/toolSchemas/getObjectInfo.ts` and the Azure mirror |

The indexer already captures service-group membership: `symbolIndex.ts:2617-2630`
inserts into `service_group_members` and indexes a `type: 'service-group'` symbol
row per group. The data exists; there's just no tool surfacing it.

### Security-privilege entry points

| Piece | Location |
|---|---|
| Create-time entry-point XML (`<AxSecurityEntryPointReference>`) | `src/tools/xml/securityPrivilegeXml.ts:59-67`, gated by `properties.targetObject` |
| Entry-point type enum (already includes `ServiceOperation`, not just menu items) | `SECURITY_ENTRY_POINT_TYPES` in `src/utils/axEnumProperties.ts:47-49` → `['None', 'MenuItemDisplay', 'MenuItemOutput', 'MenuItemAction', 'ServiceOperation']` |
| Access-level → `<Grant>` shape (`view`/`read` = Read only, `maintain` = full CRUD) | `securityPrivilegeXml.ts:41-57` |
| `security-privilege` in `BRIDGE_MODIFY_TYPES`? | **No** — absent from `src/bridge/bridgeAdapter.ts:1263-1270` |
| A `modify.operation` for entry points? | **No** — the enum (`d365foFile.ts` operation list, mirrored in `modifyD365File.ts:1225-1228`) has `add-menu-item-to-menu` (targets `menu` objects only) and generic `modify-property`, nothing that touches `<EntryPoints>` on a `security-privilege` |

Confirmed on disk: `DXC_TMSRouteStatusInboundMaintain.xml` exists
(`C:\AOSService\PackagesLocalDirectory\DXC\DXC\AxSecurityPrivilege\`) with
`<EntryPoints></EntryPoints>` empty — the object is real, it just has nothing
attached, and there is currently no supported way to attach something to it
without hand-editing the XML or recreating the object from scratch (destructive
if it already has other grants).

**Precedent already in the codebase for exactly this shape of fix:**
`directXmlAddMenuItemToMenu` (`modifyD365File.ts:497-545`) — a modify operation
that bypasses the bridge entirely (the bridge can NullRef on objects outside its
startup roots) and edits the XML file directly: read → strip BOM/CRLF → locate
the collection element → splice in a new child → atomic write. `add-entry-point`
is the same shape, targeting `<EntryPoints>` instead of `<Elements>`.

---

## Workstream A — Service / Service-Group read-side + rollout

### A1. Add a `service-group` reader
- Add `'service-group'` to the `objectType` enum in `src/server/toolSchemas/getObjectInfo.ts` (and the Azure-side mirror).
- Implement `getServiceGroupInfoTool` in `src/tools/readers/serviceInfo.ts` (or a sibling file), mirroring `getServiceInfoTool`: look up the `type='service-group'` symbol row, then list members via `SELECT service_name FROM service_group_members WHERE group_name = ?`.
- Register it in `objectInfoRegistry.ts` next to line 85.
- Cheap, low-risk — the indexed data already exists.

### A2. Finish the create-path rollout
Already-shipped source fix (`e5f307d`) needs to reach every checkout that backs
a live `d365fo-local` connection. Tracked operationally in the Obsidian
`[[Ninja MCP]]` note's "Tool update" section, not repeated here — this plan
just flags it as a precondition for A1/B being reachable in practice.

### A3. Investigate the security-index false negative
`security_info(mode="artifact", artifactType="privilege")` and `search()`
both returned "not found" for `DXC_TMSRouteStatusInboundMaintain` despite the
file existing and *other* custom objects (the `DXC_TMSRouteStatusInbound*`
classes) being indexed correctly from the same query surface. Re-run
`extract-metadata` + `build-database` and re-check; if the miss persists,
root-cause whether `AxSecurityPrivilege` indexing has a coverage gap for
this model (separate investigation — out of scope to fix blind here).

---

## Workstream B — `add-entry-point` modify operation (the real gap)

### B1. Extract a shared entry-point-fragment builder
Pull the fragment logic out of `buildAxSecurityPrivilegeXml`
(`securityPrivilegeXml.ts:59-67`) into an exported function, e.g.
`buildEntryPointFragment(targetObject: string, objType: string, accessLevel: 'view'|'read'|'maintain'): string`,
reusing the existing `assertKnownEnumValue(..., SECURITY_ENTRY_POINT_TYPES, ...)`
validation and the existing Grant-shape logic. Both `create` and the new
`modify` operation call the same function — guarantees identical XML shape,
no drift.

### B2. Direct-XML modify handler
New function in `modifyD365File.ts`, modeled directly on
`directXmlAddMenuItemToMenu` (lines 497-545):
- Read the privilege's XML file, strip BOM/normalize CRLF.
- If an `<AxSecurityEntryPointReference>` with the same `<Name>` already
  exists, **replace its `<Grant>` block** (idempotent — a retry upgrades
  the grant instead of duplicating the entry). This matters concretely: a
  stray backup file (`DXC_TMSRouteStatusInboundMaintain.xml.backup-2026-08-11T04-47-45-311`,
  content-identical to the live file) indicates an earlier attempt already
  touched this exact object before timing out — the new op needs to be safe
  to retry against that state.
- Otherwise splice a new fragment into `<EntryPoints>`/`<EntryPoints />`,
  same pattern as the `<Elements>` splice at lines 525-531.
- `writeFileAtomic` + `normalizeD365Xml`, same as the menu-item precedent.

### B3. Wire the operation in
- Add `'add-entry-point'` to the `operation` enum in `src/server/toolSchemas/d365foFile.ts` and the zod schema in `modifyD365File.ts:~1225-1228`.
- New params: `targetObject` (required), `objectType` (entry-point type — reuse `SECURITY_ENTRY_POINT_TYPES`, default `MenuItemDisplay` for parity with create), `accessLevel` (`view`/`maintain`, default `view`).
- New `case 'add-entry-point':` in the operation switch, calling B2's handler directly — no bridge attempt needed (`security-privilege` stays out of `BRIDGE_MODIFY_TYPES`; `canBridgeModify` gating is per-operation, not a blanket per-objectType allow/deny, so this needs no change to that set — confirmed via `bridgeAdapter.ts:1296-1298`).

### B4. Op-spec + knowledge docs
- Add the `add-entry-point` contract to `src/tools/specs/d365foFileOpSpecs.ts` (the `get_knowledge(kind="op-spec", topic="add-entry-point")` payload).
- Update `src/tools/knowledge/xppKnowledge.ts`'s `custom-services`/security topic if it documents the entry-point shape (it was already found to have one wrong claim about `<Operations>` vs `<ServiceOperations>` during the `e5f307d` work — check it's still accurate here too).

### B5. `remove-entry-point` (optional, lower priority)
Symmetry with the rest of the operation enum's add-X/remove-X pairs
(`add-relation`/`remove-relation`, `add-index`/`remove-index`, …). Not
required for the immediate use case — defer unless requested.

### B6. Tests
New cases (extend `tests/tools/securityPrivilegeXml.test.ts` or a new
`tests/tools/securityPrivilegeModify.test.ts`):
- Add first entry point to an empty privilege (`<EntryPoints></EntryPoints>` → one child).
- Add a second entry point (list grows, first untouched).
- Re-add the same `targetObject` — asserts idempotent Grant replacement, not a duplicate `<AxSecurityEntryPointReference>`.
- `objectType: "ServiceOperation"` — the actual case that unblocked this investigation (a REST service operation does **not** need an `AxMenuItemAction`).
- `objectType: "MenuItemDisplay"` — the existing menu-item case, for regression safety.
- `accessLevel: "maintain"` vs `"view"` — correct `<Grant>` shape per level.

---

## Rollout sequence

1. **A1** (service-group reader) — independent, ship anytime.
2. **B1** (shared fragment builder) — refactor-only, no behavior change; do first so B2 has something to call.
3. **B2 + B3** (handler + wiring) — the actual capability.
4. **B4** (op-spec/knowledge docs) — same PR as B2/B3, so the tool is self-documenting on first use.
5. **B6** (tests) — same PR.
6. **A2** (rollout to stale checkouts) — operational, can happen in parallel with the above; tracked in Obsidian.
7. **A3** (index investigation) — independent, lowest priority; doesn't block B.

## Verification

- Unit: B6's test cases pass.
- Live re-attempt against the actual blocked object:
  `d365fo_file(action="modify", objectType="security-privilege", objectName="DXC_TMSRouteStatusInboundMaintain", operation="add-entry-point", params={targetObject: "<the DXC_TMSRouteStatusInboundService operation name>", objectType: "ServiceOperation", accessLevel: "maintain"})`
  — confirm the file's `<EntryPoints>` is populated and BP-clean (`run_bp_check`).
- `get_object_info(objectType="service-group", name=...)` returns membership after A1.
- Re-run the earlier failed `security_info`/`search` lookup for
  `DXC_TMSRouteStatusInboundMaintain` after A3 and confirm it now resolves.

## Risks & mitigations

- **Same NullRef class the bridge has for new menus** (`directXmlAddMenuItemToMenu`'s
  own doc comment) could apply to privileges the bridge hasn't loaded from its
  startup roots — mitigated by design: B2 never calls the bridge for this op.
- **Idempotency** — without the Grant-replace behavior in B2, a retried call
  (e.g. after another timeout) would duplicate `<AxSecurityEntryPointReference>`
  entries. Explicitly designed against, given we already have direct evidence
  (the stray backup file) that retries happen in practice.
- **Enum drift** — `SECURITY_ENTRY_POINT_TYPES` is shared between create and
  modify via B1's extraction; a future entry-point type only needs updating
  in one place.
- **Stale deployed builds** (this whole investigation's recurring theme) — B's
  fix is only reachable once A2's rollout lands on whichever checkout backs
  the caller's `d365fo-local` connection. Worth an explicit reminder in the
  PR description, not just relying on readers to remember.

## Effort estimate

| Item | Rough effort |
|---|---|
| A1 service-group reader | 0.5 day |
| A3 index investigation (time-boxed) | 0.5 day |
| B1 shared fragment builder (refactor) | 0.25 day |
| B2 direct-XML handler + idempotency | 0.5 day |
| B3 schema/operation wiring | 0.25 day |
| B4 op-spec + knowledge doc updates | 0.25 day |
| B6 tests | 0.5 day |
| **Total (A1, A3, B — excludes A2 rollout, which is operational)** | **~2.75 days** |
