---
paths:
  - "core/sunbird_ai_core/base/**"
  - "**/functions/**.py"
  - "**/main.py"
---

# Base-class pattern (Flink jobs & process functions)

- A concrete Flink job **extends `BaseFlinkJob`** (`core/sunbird_ai_core/base/base_flink_job.py`,
  an `ABC`) and implements the single abstract method `build_pipeline(self) -> None`, wiring
  sources/process-functions/sinks onto `self.env`. `BaseFlinkJob.run()` (Template Method
  pattern) calls `build_pipeline()` then `self.env.execute(self.config.job_name)` — don't
  override `run()`. Entrypoint is always `SomeJob.main()` (a `@classmethod` on the base class)
  called from `if __name__ == "__main__":` in that job's `main.py`.
- A concrete process function **extends `BaseProcessFunction`**
  (`core/sunbird_ai_core/base/base_process_function.py`, itself extending PyFlink's
  `ProcessFunction`) and implements `process_element(self, value, ctx)`. Only override
  `open()`/`__init__` if the subclass needs its own extra setup beyond storage/knowlg
  (e.g. `TranscriptionFunction` constructs a transcription provider) — always call
  `super().__init__(...)`/`super().open(...)` **first**, then add subclass-specific setup.
  If a function needs none of the shared storage/knowlg lifecycle (e.g.
  `caption_generator`'s `EventRouter`, `enrichment_router`'s `RouterFunction`), extend plain
  PyFlink `ProcessFunction` directly instead — don't force it through `BaseProcessFunction`.
- **`__init__` runs once, locally, when the job graph is built. `open()` runs separately, once
  per parallel task instance, on the actual (possibly remote) TaskManager.** Anything holding a
  live connection or client (`BlobStorageUtil`, `KnowlgClient`) must be constructed in
  `open()`, never `__init__`. Every such attribute is typed `X | None = None` in `__init__` and
  narrowed with `assert self.x is not None, "open() must be called before ..."` at the top of
  any method that uses it (mypy needs this to type-narrow past `None`). Follow this pattern for
  new attributes rather than assuming they're always populated.
- `close()` is currently a no-op — `BlobStorageUtil`/`KnowlgClient` both make fresh HTTP
  requests per call and hold no persistent connection to tear down. It's kept as a method so
  Flink's lifecycle contract and any future subclass have a stable hook, not because anything
  needs it today.
- `BaseProcessFunction.emit_to_dlq(event, error, ctx, output_tag)` is the one shared way to
  route a failed event to a DLQ side output — see `kafka-contracts.md`. Don't hand-roll DLQ
  emission in new process functions.
