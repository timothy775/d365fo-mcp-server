# Tool Reference — 34 Tools

Every tool the server exposes, grouped by purpose. The AI agent picks tools automatically — the *example prompts* show what to ask to trigger them; you never name tools yourself.

> Several tools are **unified** behind a discriminator parameter (`action` / `mode` / `kind` / `objectType` / `include`) instead of one tool per variant — e.g. `search`, `get_method`, `d365fo_file`, `analyze_code`, `form_pattern`, `prepare`, `security_info`, `get_knowledge`, `labels`, `get_object_info`, `generate_smart`. Fewer tools to choose from, same coverage.

> **C# bridge first:** on Windows D365FO VMs, the bridge-backed read tools (marked †) query the live `IMetadataProvider` (always-fresh metadata) and `DYNAMICSXREFDB` (compiler-resolved cross-references), falling back to SQLite transparently on Azure/Linux. All write operations go exclusively through the bridge. See [BRIDGE.md](BRIDGE.md) and [SQLITE_DEPENDENCY.md](SQLITE_DEPENDENCY.md).
>
> **Server modes:** `full` = all 34 tools · `read-only` (Azure) = search/analysis only · `write-only` (hybrid companion) = file operations + bridge-backed reads. See [MCP_CONFIG.md](MCP_CONFIG.md).

---

## Recommended workflows

The grounding chain is what makes generated code compile on the first try:

```mermaid
flowchart LR
    subgraph Extend["Extending existing code"]
        A1["prepare<br/>(mode=change)"] --> A2[generate code]
        A2 --> A3[resolve_references<br/>+ validate_xpp]
        A3 --> A4["d365fo_file<br/>(action=modify)"]
    end
    subgraph Create["New objects"]
        B1["prepare<br/>(mode=create)"] --> B2[generate code]
        B2 --> B3[resolve_references<br/>+ validate_xpp]
        B3 --> B4["d365fo_file<br/>(action=create)"]
    end
    subgraph Forms["New forms"]
        C1["form_pattern<br/>(action=analyze)"] --> C2["form_pattern<br/>(action=spec)"]
        C2 --> C3["generate_smart<br/>(objectType=form, cloneFrom)"]
        C3 --> C4["form_pattern<br/>(action=validate)"]
        C4 --> C5["d365fo_file<br/>(action=create)"]
    end
```

| Workflow | Chain | Gate |
|----------|-------|------|
| CoC / event handler / extension | `prepare(mode="change")` → generate → `resolve_references` + `validate_xpp` → `d365fo_file(action="modify")` | grounding token + reference proof |
| New class / table / enum | `prepare(mode="create")` → generate → `resolve_references` + `validate_xpp` → `d365fo_file(action="create")` | grounding token + collision check |
| New form | `form_pattern(action="analyze", recommend)` → `form_pattern(action="spec")` → `generate_smart(objectType="form", cloneFrom)` → `form_pattern(action="validate")` → `d365fo_file(action="create")` | structural pattern gate (FP001–FP010) |

---

## 🔍 Search & Discovery (3)

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `search` † | Search 580K+ symbols by name or keyword (FTS5, < 10 ms). `queries[]` runs up to 10 searches in parallel; `scope="extensions"` limits to custom/ISV models (filters out Microsoft code) | *"Find classes related to sales order posting"* · *"Look up CustTable, SalesLine and PaymTerm at once"* · *"What extensions do we have on VendTable?"* |
| `batch_get_info` | Detailed info for up to 10 known objects (any type) in one parallel call | *"Get full details of CustTable, SalesLine and CustInvoiceJour"* |
| `code_completion` | IntelliSense-style member listing with prefix filter | *"Methods on SalesTable starting with calc"* |

† = bridge-first on Windows D365FO VMs

## 📊 Advanced Object Info (3)

One unified reader covers every object type via `objectType`; type-specific flags go in `options`.

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `get_object_info` † | Read one object's metadata by `objectType`: `class`, `table`, `form`, `query`, `view`, `enum`, `edt`, `report`, `data-entity`, `menu-item`, `service`, `map`, `config-key`, `security-policy`, `macro`. Options: `{includeRdl}` (report), `{searchControl}` (form), `{compact:false}` (class), `{mode:"hierarchy"}` (edt), `{filter}` (macro). | *"Show the structure of SalesFormLetter"* · *"Operations of AifUserSessionService"* · *"Datasets of the SalesInvoice report"* |
| `get_method` † | Method `include="signature"` (exact signature — **mandatory before CoC**), `include="source"` (full X++ body), or `include="both"` (default) | *"Signature of SalesFormLetter.run?"* · *"Show me the body of CustTable.validateWrite"* |
| `find_references` † | Where-used analysis, xref-enriched (reference type, caller class/method) | *"Where is updateInventory called from?"* |

## 🏷️ Label Management (1)

One unified tool covers all label operations via `action` (mirrors the `get_object_info` pattern).

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `labels` | `action=search` — full-text query across 20M+ label rows, all languages · `action=info` — all translations of a labelId (or list label files when omitted) · `action=create` — add a label to all language files of a model · `action=rename` — rename a label ID across .label.txt, X++ and XML | *"Is there a label for 'payment terms'?"* · *"Show translations of @SYS12345"* · *"Create label 'Priority tier' in en-US, cs, de"* · *"Rename label MyOldId to MyNewId everywhere"* |

## 🧠 Code Intelligence (2)

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `get_knowledge` | `kind="knowledge"` — queryable X++ rulebook: select grammar, CoC, SysDa, FormRun lifecycle, form patterns, AX2012→D365FO migration · `kind="error"` — compiler / runtime / BP errors explained with concrete fixes | *"What are the rules for crossCompany selects?"* · *"Explain error 'object not initialized' in batch"* |
| `analyze_code` † | `mode="patterns"` — common patterns for a scenario · `mode="implementations"` — real implementations of a similar method · `mode="completeness"` — missing standard methods on a class · `mode="api-usage"` — how an API is initialized and called (compiler-resolved callers) | *"How are number sequences usually implemented here?"* · *"How do other classes implement validateWrite?"* · *"What standard methods is my service class missing?"* |

## 🎨 Smart Object Generation (2)

One unified pattern-aware generator covers tables, forms and reports via `objectType`.

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `generate_smart` | `objectType=table` — pattern-aware table XML with EDT suggestions · `objectType=form` — **clones reference forms** (`cloneFrom` + `tableMapping`, patterns and sub-patterns preserved), template fallback, optional lifecycle method stubs (`includeMethodStubs`) · `objectType=report` — complete SSRS stack in one call: TmpTable + Contract + DP + Controller + AxReport/RDL | *"Create an audit log table with SalesId, PostedAt, PostedBy"* · *"Create a SimpleList form for MyRentalGroup by cloning CustGroup"* · *"Create report InventByZones with these 7 fields"* |
| `suggest_edt` | EDT suggestions for a field name (fuzzy, confidence-ranked) | *"Which EDT for a field CustomerAccount?"* |

## 📈 Pattern Analysis & Codegen (2)

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `get_table_patterns` | Field/index patterns for table groups | *"What do parameter tables typically look like?"* |
| `generate_code` | X++ boilerplate: SysOperation, CoC, event handler, business event, custom service, lookup form, … | *"Generate a SysOperation skeleton for VendRecalc"* |

## 📝 File Operations (2)

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `d365fo_file` | `action=create` — create any of 18 AOT object types in the correct location + register in `.rnrproj` (gated by grounding token and form-pattern validation) · `action=modify` — safe metadata edits via the C# bridge, 25 operations: add-field, add-control, add-method, replace-code, modify-property, … · `action=generate` — XML preview without writing (cloud-friendly) | *"Create the class file in my project"* · *"Add the field to the General tab of the form extension"* · *"Show me the XML for this enum without creating it"* |
| `undo_last_modification` | Revert the last write: checkout HEAD or delete untracked file | *"Undo that last change"* |

## 🔐 Security & Extensions (9)

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `security_info` | `mode="artifact"` — privilege / duty / role details + full hierarchy · `mode="coverage"` — which roles reach a form/table/menu item (Role → Duty → Privilege → Entry Point) + OLS policies | *"What does the duty VendPaymentTermsMaintain contain?"* · *"Who has access to the VendPaymTerms form?"* |
| `find_coc_extensions` † | Existing CoC wrappers of a method — **check before writing a new one** | *"Is SalesFormLetter.run already wrapped by CoC?"* |
| `find_event_handlers` † | All `[SubscribesTo]` handlers for an event | *"What subscribes to CustTable onInserted?"* |
| `get_table_extension_info` † | All extensions of a table: fields, indexes, methods | *"What fields have we added to CustTable?"* |
| `analyze_extension_points` † | CoC-eligible methods, delegates, events on an object | *"What can I extend on SalesFormLetter?"* |
| `recommend_extension_strategy` | Best extensibility mechanism for a goal | *"How should I customize sales confirmation posting?"* |
| `validate_object_naming` | Naming conventions + symbol-index collision check | *"Is MY_VendPaymTermsMaintain a valid name?"* |
| `get_workspace_info` | Detected paths, model, project, server mode + **index staleness warning** — call first in every session | *"Check my workspace configuration"* |
| `verify_d365fo_project` | Objects exist on disk and in the `.rnrproj` | *"Verify everything we created is in the project"* |

## 🏗️ SDLC & Build (5)

> Local-only — require a Windows D365FO VM; excluded from the Azure `read-only` mode.

| Tool | What it does | Example prompt |
|------|--------------|----------------|
| `build_d365fo_project` | MSBuild compilation with structured xppc diagnostics (severity, object, line, fix hints for the first errors) | *"Build the project and show the errors"* |
| `trigger_db_sync` | Database sync for the current model | *"Sync the database"* |
| `run_bp_check` | Microsoft Best Practices (xppbp.exe) analysis | *"Run a BP check on my model"* |
| `run_systest_class` | Execute SysTest unit tests via SysTestRunner | *"Run the MyServiceTest class"* |
| `update_symbol_index` | Re-index a single changed file without restart | *"Refresh the index for the table I just created"* |

## ✅ Quality & Grounding (5)

| Tool | What it does | When it runs |
|------|--------------|--------------|
| `prepare` | `mode="change"` — one call before extending: signature + existing CoC wrappers + eligibility + strategy + **grounding token** · `mode="create"` — one call before creating: collision check + naming + EDT/label suggestions + property defaults + **grounding token** | automatically, before modifications / new objects |
| `resolve_references` | Proves every type/field/method/label in generated code against the index — anti-hallucination gate | automatically, after generation |
| `validate_xpp` | Offline BP validator, < 50 ms: deprecated APIs, CoC correctness, select anti-patterns, data-driven XML property rules mined from standard models | automatically, after generation |
| `form_pattern` | `action="analyze"` — pattern advisor (`recommend={entityKind, fieldCount, usageIntent, tableName}` → right pattern + reference forms; also analyzes existing forms) · `action="spec"` — full pattern spec (required containers/ordering, sub-patterns, versions, reference forms, lifecycle) · `action="validate"` — structural validation FP001–FP010; structural errors **block form writes** (`FORM_PATTERN_ENFORCE`) | advisor up front; validate before form writes |
| `review_workspace_changes` | AI code review of uncommitted X++ changes (git diff) | on request: *"Review my changes"* |

> **Grounding enforcement:** `prepare` issues a SHA-256 provenance token (30-min TTL) **bound to the object it was issued for**. When `GROUNDING_ENFORCE=true` is set in `.env`:
> - extension patterns in `generate_code` and extension objectTypes in `d365fo_file(action="create"/"modify")` require a valid token for the target object, and
> - X++ source passed to `d365fo_file(action="create"/"modify")` is run through `resolve_references` — the write is rejected while any identifier cannot be proven against the index.
>
> This ensures generated code is grounded in your actual codebase, not AI training data.
>
> **Hybrid deployment note:** grounding tokens live in the issuing process's memory. In `write-only` mode (local companion) `prepare` is not exposed and tokens issued by the read-only/Azure instance cannot be validated locally, so `GROUNDING_ENFORCE=true` is **ignored** there (with a startup warning) — otherwise the agent would loop forever between the two servers. Only enable enforcement on a `full`-mode server.

---

## Tips
- **Describe goals, not tools.** The instruction files route requests automatically — *"add a priority field to CustTable and show it on the form"* triggers the whole chain.
- **Let the gates work.** `GROUNDING_ENFORCE` and `FORM_PATTERN_ENFORCE` (both default on) reject ungrounded or structurally invalid writes — that's the feature, not friction.
- **Verify after writing.** `verify_d365fo_project` confirms disk + project registration in one call.
- **Full conversations:** [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) shows seven real multi-tool scenarios end to end.
