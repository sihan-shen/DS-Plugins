# `dsh-lsp-actions` compatibility review

Review date: 2026-08-30
Reviewed commit: `ea0354ca444075b37b791bd8638fecdbc40fb5d0`
Package version: `0.4.0`
Pinned DSH: `0.1.1-rc.2`

## Decision

`PluginCompatibilityReportV1.status` is **`patch-required`**. The candidate is
not installed and is not included in the default profile.

The declared Node engine `^22.19.0 || >=24.0.0` accepts the Node 24 shell.
The declared DSH peer range `>=0.1.0-rc.8 <0.2.0` does not accept the pinned
`0.1.1-rc.2` under npm prerelease rules.

The workshop metadata declares `filesystem:read`, `filesystem:write`, and
`subprocess`, with no network permission. This metadata does not prove that a
child language-server process is network-isolated.

The reviewed registration contains these eight tools:

1. `lsp_diagnostics`
2. `lsp_symbols`
3. `lsp_completion`
4. `lsp_signature_help`
5. `lsp_inlay_hints`
6. `lsp_format`
7. `lsp_code_action`
8. `lsp_rename`

`lsp_format`, `lsp_code_action`, and `lsp_rename` are registration-level write
tools. A read-only session is therefore not sufficient for direct compatibility;
the write tools must be absent from the model-visible registration.

## Artifact binding

The checked-in artifact is explicitly a source snapshot rather than an
installable package:

- `artifact_kind`: `source-snapshot`
- `artifact_url`: `null`
- `integrity`: `null`
- `snapshot_source`: `src/index.ts at reviewed_commit`
- `manifest_sha256`: `sha256:672e057fcc49cf809a0d6e0418ccc4b4779ec027015d8696f4b3f632720d9ac7`
- `registration_snapshot_sha256`: `sha256:e020db6f7e24a48d61a2ce1b74bff1a48abfe61a6bc40b4284b62e7d86aad1cf`

The checker recomputes both hashes from the checked-in fixtures before emitting
the report and returns `artifact_integrity: not-provided`; it does not pretend
to verify a tarball.

## Allowed next actions

Direct integration may be reconsidered only after one of these outcomes:

1. An upstream release explicitly accepts DSH `0.1.1-rc.2`.
2. An audited fixed tarball or patch is supplied with verifiable integrity.
3. A self-owned adapter registers only approved read-only tools.

The checker is offline and performs no installation, provider, credential,
network, shell, or task-command operation.
