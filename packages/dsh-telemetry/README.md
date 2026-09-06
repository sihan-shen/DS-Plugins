# DSH Telemetry

Telemetry is opt-in, local, bounded, and passive. It stores allowlisted observations and pseudonymous references in private JSONL segments. The private `salt.bin` file is never exported. Queue loss, incomplete seals, retention, and missing segments are preserved as incomplete evidence.

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
