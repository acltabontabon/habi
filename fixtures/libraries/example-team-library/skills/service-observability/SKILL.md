---
name: service-observability
description: Add metrics, structured logs and traces to a Spring Boot service following team conventions. Use when adding endpoints or background jobs.
---

# Service observability

- Expose Micrometer timers for every endpoint and outbound call.
- Use structured logging with a request id in the MDC.
- Propagate trace context to outbound HTTP and messaging.
