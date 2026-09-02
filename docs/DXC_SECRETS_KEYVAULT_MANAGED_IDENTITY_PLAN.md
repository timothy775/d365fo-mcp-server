# Plan — Move secrets to Key Vault / Managed Identity (close EXC-01, EXC-02)

## Objective

Retire the two BlueScope security exceptions on secret management:

- **EXC-02 — Secrets in an approved vault** (`SEC-FR-05`, `SEC-AI-DTCTLG-06`): the
  storage connection string and the inbound API key are held as App Service
  application settings rather than in an approved vault.
- **EXC-01 — No fixed service credential** (`SEC-AI-DTCTLG-02`): the storage
  account-key connection string is a fixed service credential.

Two independent workstreams:

| Workstream | Secret | Target | Code change? |
|---|---|---|---|
| **A** | Inbound `API_KEY` | Key Vault reference (App Service resolves via its MI) | No |
| **B** | `AZURE_STORAGE_CONNECTION_STRING` (account key) | **Eliminated** — Entra/Managed Identity + RBAC everywhere | Yes |

Workstream A fully closes the API-key half of EXC-02 with no application change.
Workstream B closes both EXC-01 and the storage half of EXC-02, but spans the
runtime app **and the three build pipelines**.

---

## Current-state inventory — every consumer of the storage key

The account key (as a connection string) is consumed in **three** places, sourced
from two stores (App Service app settings + the `xpp-mcp-server-config` Azure
DevOps variable group):

| # | Consumer | File / location | Mechanism |
|---|---|---|---|
| 1 | Runtime read (DB download on startup) | `src/database/download.ts` (`downloadDatabaseFromBlob`, `checkDatabaseVersion`, `initializeDatabase`) | `BlobServiceClient.fromConnectionString` |
| 2 | Build read+write (`blob-manager`) | `scripts/azure-blob-manager.ts:54` | `BlobServiceClient.fromConnectionString` |
| 3 | Build read+write (`az` / azcopy) | the 3 `.azure-pipelines/*.yml` | parse `AccountName`/`AccountKey` → `az storage container generate-sas --account-key`; `az storage blob download --connection-string` |

The inbound API key is consumed only at runtime by `src/middleware/apiKeyAuth.ts`
(`process.env.API_KEY`).

**Already in place (no new provisioning needed):**
- App Service has a **system-assigned managed identity** (`main.bicep` `identity: SystemAssigned`).
- All three pipelines already carry an **ARM service connection** `$(AZURE_SUBSCRIPTION)`
  (used by the `AzureAppServiceManage@0` restart step) — i.e. a service principal /
  workload identity that authenticates to the subscription.

**Note:** `infrastructure/azuredeploy.json` is generated from `main.bicep`
(`az bicep build`). Edit the Bicep, then regenerate the ARM JSON — never hand-edit both.

---

## Workstream A — API key → Key Vault reference (deployment-only)

### A1. Add a Key Vault + secret to `main.bicep`
- `Microsoft.KeyVault/vaults` with `enableRbacAuthorization: true`,
  `publicNetworkAccess` restricted (private endpoint or trusted Azure services in
  the target private design).
- A secret `mcp-api-key` initialised from the existing `@secure() apiKey` param.

### A2. Grant the App Service MI access
- Role assignment **Key Vault Secrets User** for `appService.identity.principalId`
  scoped to the vault.

### A3. Switch the app setting to a KV reference
- Change the `API_KEY` app setting value from the raw param to:
  `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/mcp-api-key/)`
- App Service resolves it at startup via the MI **before** `process.env.API_KEY` is
  read — `apiKeyAuth.ts` is unchanged.

### A4. Regenerate `azuredeploy.json` from Bicep.

**Result:** API key is vaulted, never stored as a literal app setting, no code change.

---

## Workstream B — Storage key → Managed Identity (eliminate the secret)

Done in dependency order so nothing breaks mid-flight. The account key must keep
working until *all* consumers are switched; only then is key access disabled.

### B1. RBAC (additive — do first, safe to run early)
- App Service MI → **Storage Blob Data Reader** on the storage account.
- Pipeline SP (behind `$(AZURE_SUBSCRIPTION)`) → **Storage Blob Data Contributor**
  on the storage account.
- Add these as `Microsoft.Authorization/roleAssignments` in `main.bicep`.

### B2. Runtime code — `src/database/download.ts`
- Add dependency `@azure/identity` (currently only `@azure/storage-blob` is present).
- Replace both `BlobServiceClient.fromConnectionString(connectionString)` sites with:
  ```ts
  import { DefaultAzureCredential } from '@azure/identity';
  const account = process.env.AZURE_STORAGE_ACCOUNT;            // e.g. "d365fomcpcustomer"
  const url = `https://${account}.blob.core.windows.net`;
  const blobServiceClient = new BlobServiceClient(url, new DefaultAzureCredential());
  ```
- Re-gate the "use blob?" logic: today `initializeDatabase` / `downloadDatabaseFromBlob`
  test `process.env.AZURE_STORAGE_CONNECTION_STRING`. Switch the gate to
  `AZURE_STORAGE_ACCOUNT` (keep a fallback to the conn string during transition so a
  rollback is possible).

### B3. Build script — `scripts/azure-blob-manager.ts`
- Same `DefaultAzureCredential` switch in the constructor (`fromConnectionString` →
  account URL + credential).
- When the pipeline runs `npm run blob-manager …` **inside an `AzureCLI@2` task**,
  `DefaultAzureCredential` transparently uses the service-connection login
  (`AzureCliCredential`) — no key, no conn-string env var.

### B4. Pipelines — all three `.azure-pipelines/*.yml`
Convert each blob-touching `- script:` step to `- task: AzureCLI@2` with
`azureSubscription: $(AZURE_SUBSCRIPTION)`, `scriptType: bash`, and:
- **`blob-manager` steps**: drop the `AZURE_STORAGE_CONNECTION_STRING` env; pass
  `AZURE_STORAGE_ACCOUNT` instead. (Auth comes from the task's az login.)
- **azcopy steps**: remove the `AccountName`/`AccountKey` parsing and
  `generate-sas --account-key`. Either:
  - set `AZCOPY_AUTO_LOGIN_TYPE=AZCLI` and use OAuth directly, or
  - mint a **user-delegation SAS**: `az storage container generate-sas --auth-mode login --as-user …`
    (signed by the identity, not the account key).
- **`az storage blob download` step** (platform pipeline): replace
  `--connection-string "$AZURE_STORAGE_CONNECTION_STRING"` with
  `--account-name $(AZURE_STORAGE_ACCOUNT) --auth-mode login`.
- Remove `AZURE_STORAGE_CONNECTION_STRING` from the `xpp-mcp-server-config` variable
  group; add a non-secret `AZURE_STORAGE_ACCOUNT`. (If any secret remains in the group,
  link the group to Key Vault.)

### B5. Capstone — enforce no shared-key access (do LAST)
- In `main.bicep`: remove the `listKeys()`-built `AZURE_STORAGE_CONNECTION_STRING`
  app setting; add `AZURE_STORAGE_ACCOUNT`.
- Set `allowSharedKeyAccess: false` on the storage account.
- Regenerate `azuredeploy.json`.

This is the auditor-grade proof that EXC-01/EXC-02 (storage) are closed: with shared
key disabled, **no** account key works anywhere. It is a hard cutover — it breaks the
instant any consumer (B2/B3/B4) is still on the key, so it must be last.

---

## Rollout sequence (strict order)

1. **B1** RBAC role assignments (additive — both key and identity work afterward).
2. **A1–A4** API-key Key Vault reference (independent; can ship anytime).
3. **B2 + B3** code changes (`@azure/identity`, `DefaultAzureCredential`) behind the
   new `AZURE_STORAGE_ACCOUNT` gate, conn-string fallback retained. Deploy app; verify.
4. **B4** pipeline conversion to `AzureCLI@2` + identity auth. Run each pipeline once
   to confirm upload/download still works on identity.
5. **B5** remove conn-string fallback, drop the app setting, set
   `allowSharedKeyAccess: false`, regenerate ARM, redeploy.

Each step is independently reversible until B5.

---

## Verification

- **App runtime:** deploy to a test slot/RG; confirm startup DB download succeeds with
  only `AZURE_STORAGE_ACCOUNT` set (no conn string). Check `/health`.
- **API key:** confirm KV-reference app setting resolves (App Service → Configuration
  shows "Key Vault Reference" green); confirm `X-Api-Key` auth still passes/fails correctly.
- **Pipelines:** run `custom`, `standard`/`all`, and `platform-upgrade` once each with
  the conn string removed; confirm `upload-database`, `upload-custom/standard`,
  `download-database`, `delete-custom`, azcopy, and the `az storage blob download` step
  all succeed on identity.
- **Enforcement:** after B5, attempt a key-based call (`az storage blob list
  --account-key …`) and confirm it is rejected (403 `KeyBasedAuthenticationNotPermitted`).

---

## Risks & mitigations

- **RBAC propagation delay** (data-plane role assignments can take minutes) — assign
  early (B1), verify before flipping gates.
- **azcopy OAuth on hosted agents** — `AZCOPY_AUTO_LOGIN_TYPE=AZCLI` requires a recent
  azcopy; pin/verify the agent's azcopy version, else fall back to user-delegation SAS.
- **`allowSharedKeyAccess:false` blocks portal key access and any tooling still using
  keys** — confirm no out-of-band scripts/people rely on the key before B5.
- **Pipeline SP scope** — Data Contributor must be on the correct storage account;
  least-privilege (not subscription-wide).

---

## Document updates (BlueScope response)

After (or alongside) implementation, update
`bluescope/BLUESCOPE_AI_SECURITY_RESPONSE_HYBRID_Final.md`:

- **EXC-02**: note the API-key half is closed by a Key Vault reference and the storage
  half by managed identity; the storage close **spans the three build pipelines**, not
  just the App Service.
- **EXC-01**: the storage fixed-credential is eliminated (identity + `allowSharedKeyAccess:false`),
  reducing the residual to only the optional APIM→backend hop.
- Update the matrix rows `SEC-FR-05 / DTCTLG-06` and `SEC-AI-DTCTLG-02` from
  Partially Satisfied / Strengthened toward Satisfied once evidenced.

---

## Effort estimate

| Item | Rough effort |
|---|---|
| A (API key → KV ref, Bicep only) | 0.5 day |
| B1 RBAC in Bicep | 0.5 day |
| B2 `download.ts` + `@azure/identity` | 0.5 day |
| B3 `azure-blob-manager.ts` | 0.5 day |
| B4 three pipelines → `AzureCLI@2` + identity | 1–1.5 days (incl. test runs) |
| B5 enforcement + ARM regen + redeploy | 0.5 day |
| Doc updates | 0.5 day |
| **Total** | **~4–5 days** |
</content>
</invoke>
