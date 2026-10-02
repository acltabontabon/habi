## Java service conventions

- Target the Java version declared in the build; do not raise it in unrelated changes.
- Keep controllers thin: validation and mapping in the web layer, rules in services.
- Every schema change ships as a reviewed migration; never edit an applied changeset.
- Prefer constructor injection; avoid field injection.
- Log with structured key/value pairs and never log credentials or personal data.
