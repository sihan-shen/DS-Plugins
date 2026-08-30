import { describe, expect, it } from 'vitest'
import { checkCandidate } from '../../scripts/check-dsh-plugin-candidate.mjs'
import { parsePluginCompatibilityReportV1 } from '../../packages/dsh-context/src/index.ts'

const reviewedCommit = 'ea0354ca444075b37b791bd8638fecdbc40fb5d0'

describe('pinned dsh-lsp-actions compatibility gate', () => {
  it('produces a data-bound negative compatibility report from checked-in fixtures', () => {
    const report = checkCandidate()
    expect(parsePluginCompatibilityReportV1(report)).toEqual(report)

    expect(report).toMatchObject({
      schema_version: 1,
      package_name: 'dsh-lsp-actions',
      package_version: '0.4.0',
      reviewed_commit: reviewedCommit,
      dsh_version: '0.1.1-rc.2',
      status: 'patch-required',
      peer_range: '>=0.1.0-rc.8 <0.2.0',
      peer_accepts_dsh: false,
      node_range: '^22.19.0 || >=24.0.0',
      node_compatible: true,
      permissions: ['filesystem:read', 'filesystem:write', 'subprocess'],
      network_permission: false,
      network_isolation_proven: false,
      lifecycle_scripts: ['prepare'],
      registration_tools: [
        'lsp_diagnostics',
        'lsp_symbols',
        'lsp_completion',
        'lsp_signature_help',
        'lsp_inlay_hints',
        'lsp_format',
        'lsp_code_action',
        'lsp_rename',
      ],
      registration_write_tools: ['lsp_format', 'lsp_code_action', 'lsp_rename'],
      artifact_integrity: 'not-provided',
      artifact_metadata_bound: true,
    })
    expect(report.registration_tools).toHaveLength(8)
    expect(report.manifest_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(report.registration_snapshot_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(report.next_action).toContain('read-only adapter')
    expect(report.next_action).toContain('peer-range')
    expect(report.next_action).toContain('integrity')
  })

  it('does not treat a read-only session as safe while write tools are registered', () => {
    const report = checkCandidate()

    expect(report.read_only_session_sufficient).toBe(false)
    expect(report.registration_write_tools).toEqual(['lsp_format', 'lsp_code_action', 'lsp_rename'])
    expect(report.status).not.toBe('direct-compatible')
  })
})
