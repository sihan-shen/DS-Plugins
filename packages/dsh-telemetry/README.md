# `@ds-plugins/dsh-telemetry`

An independent DSH bundle for opt-in, local, bounded, and passive telemetry.
It stores allowlisted observations and pseudonymous references in private JSONL
segments. The private `salt.bin` file is never exported. Queue loss,
incomplete seals, retention, and missing segments are preserved as incomplete
evidence.

## Status and compatibility

- Parent repository: [DSH-Plugins](https://github.com/sihan-shen/DS-Plugins)
- DSH dependency line: `0.1.1-rc.2` (`@deepseek-ai/dsh-base`,
  `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-subprocess`, and
  `@deepseek-ai/dsh-tools`)
- Cordis peer dependency: `4.0.1`
- Availability: optional and disabled by default; it is not included in the
  default DSH profiles and is not yet published to npm. Use a local checkout,
  packed artifact, or a published package when available, then enable it
  explicitly in the host profile.

## Install

When published, install the package together with the DSH host dependencies:

```bash
pnpm add @ds-plugins/dsh-telemetry
```

Until then, use a local checkout or packed artifact from the independent
repository.

The bundle contributes a disabled-by-default `dsh-telemetry` entry. Enable it
in the host profile with an absolute private storage root:

```yaml
- insert:
    - id: dsh-telemetry
      name: '@ds-plugins/dsh-telemetry'
      config:
        enabled: true
        storageRoot: /absolute/private/path/.dsh-telemetry
```

The package exports three public surfaces:

- `@ds-plugins/dsh-telemetry`: Cordis lifecycle and plugin metadata.
- `@ds-plugins/dsh-telemetry/contracts`: versioned telemetry schemas and validators.
- `@ds-plugins/dsh-telemetry/storage`: bounded local store used by offline exporters and tests.

Telemetry is not provider access, live-task validation, or an automatic policy
promotion mechanism. Offline analysis remains owned by `@ds-plugins/dsh-eval`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm run test:package-entry
```

## Offline analysis

Build the offline evaluator before using its CLI:

```bash
pnpm --filter @ds-plugins/dsh-eval build
```

Use the offline evaluator after exporting a store. Every `--store`, `--out`,
`--events`, and `--annotations` path must be absolute:

```bash
node packages/dsh-eval/lib/src/telemetry/cli.js export --store /tmp/dsh-telemetry-demo --out /tmp/dsh-events.jsonl
node packages/dsh-eval/lib/src/telemetry/cli.js analyze --events /tmp/dsh-events.jsonl --annotations /tmp/dsh-annotations.json --out /tmp/dsh-analysis
```

For a runnable repository fixture that exercises both commands with the
existing bounded test corpus, run:

```bash
pnpm --filter @ds-plugins/dsh-eval build
pnpm exec vitest run packages/dsh-eval/tests/telemetry/cli.spec.ts --config vitest.config.ts
```

The fixture is defined in `packages/dsh-eval/tests/telemetry/fixture.ts`; the
test creates private temporary inputs and removes them when it finishes. It is
not provider access, live-task validation, or a full v0.5 acceptance run.

Annotations are human or evaluator assertions. The schemas provide traceability and bounded evidence, not proof that an annotation is true. Metrics report unavailable values explicitly. Lessons and Skill/Prompt/Routing candidates are immutable offline artifacts; candidates are hypotheses that require later evaluation and are never imported by the running scheduler.

The exporter requires exclusive access to the store and refuses a live `writer.lock`. It reads only numbered JSONL segments, rejects corrupt or truncated input, and never opens `salt.bin`. A stale lock must be recovered manually only after verifying that no collector remains. Output is published atomically into an absent target directory with fixed size and file-count limits.

An annotation file is a JSON array. Each entry names one `domainRef`/`runRef`, a pseudonymous task instance and family, the configuration and prompt hashes, an explicit `success`, `failure`, or `unknown` outcome, optional boolean acceptance, and bounded evidence references. Failure annotations also carry one taxonomy category and `observed` or `reviewed` attribution. Evidence references must resolve to the same imported run; the importer rejects conflicts and incomplete seals.

The v0.5 metric inventory is fixed: `task_success_rate`,
`accepted_result_rate`, `worker_spawn_rate`, `model_switch_rate`, and
`verification_cost` are computed when eligible evidence exists;
`cache_hit_ratio`, `uncached_tokens_per_success`, `source_token_estimate`,
`uncached_source_tokens`, `lsp_to_source_ratio`, `worker_reuse_rate`,
`retry_rate`, `latency_per_success`, and `fallback_rate` are currently
unavailable and are reported with `value: null` and `basis: "unavailable"`.

The analysis directory contains metrics, repeated failure patterns, calibration
observations, immutable lesson revisions, inert candidates, and a manifest with
input digests and completeness counts. No wall-clock timestamp is included in
artifact hashes. Candidates remain inert hypotheses: they require later
evaluation and are never imported by the running scheduler or used to change
policy automatically.
