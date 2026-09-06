# DSH Telemetry

Telemetry is opt-in, local, bounded, and passive. It stores allowlisted observations and pseudonymous references in private JSONL segments. The private `salt.bin` file is never exported. Queue loss, incomplete seals, retention, and missing segments are preserved as incomplete evidence.

Use the offline evaluator after exporting a store:

```bash
node packages/dsh-eval/lib/src/telemetry/cli.js export --store /tmp/dsh-telemetry-demo --out /tmp/dsh-events.jsonl
node packages/dsh-eval/lib/src/telemetry/cli.js analyze --events /tmp/dsh-events.jsonl --annotations /tmp/dsh-annotations.json --out /tmp/dsh-analysis
```

Annotations are human or evaluator assertions. The schemas provide traceability and bounded evidence, not proof that an annotation is true. Metrics report unavailable values explicitly. Lessons and Skill/Prompt/Routing candidates are immutable offline artifacts; candidates are hypotheses that require later evaluation and are never imported by the running scheduler.

The exporter requires exclusive access to the store and refuses a live `writer.lock`. It reads only numbered JSONL segments, rejects corrupt or truncated input, and never opens `salt.bin`. A stale lock must be recovered manually only after verifying that no collector remains. Output is published atomically into an absent target directory with fixed size and file-count limits.

An annotation file is a JSON array. Each entry names one `domainRef`/`runRef`, a pseudonymous task instance and family, the configuration and prompt hashes, an explicit `success`, `failure`, or `unknown` outcome, optional boolean acceptance, and bounded evidence references. Failure annotations also carry one taxonomy category and `observed` or `reviewed` attribution. Evidence references must resolve to the same imported run; the importer rejects conflicts and incomplete seals.

The analysis directory contains metrics, repeated failure patterns, calibration observations, immutable lesson revisions, inert candidates, and a manifest with input digests and completeness counts. No wall-clock timestamp is included in artifact hashes.
