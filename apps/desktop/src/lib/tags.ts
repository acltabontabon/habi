/** Plain names for the technology tags inspection can establish. */
export const TAG_LABELS: Record<string, string> = {
  "framework:spring-boot": "Spring Boot",
  "framework:react": "React",
  "framework:vue": "Vue",
  "framework:angular": "Angular",
  "framework:next": "Next.js",
  "framework:quarkus": "Quarkus",
  "framework:micronaut": "Micronaut",
  "framework:express": "Express",
  "framework:nestjs": "NestJS",
  "framework:svelte": "Svelte",
  "lang:java": "Java",
  "lang:kotlin": "Kotlin",
  "lang:typescript": "TypeScript",
  "lang:javascript": "JavaScript",
  "lang:python": "Python",
  "lang:go": "Go",
  "lang:rust": "Rust",
  "lang:csharp": "C#",
  "orm:jpa": "JPA",
  "db:jooq": "jOOQ",
  "db:liquibase": "Liquibase",
  "db:flyway": "Flyway",
  "api:openapi": "OpenAPI spec",
  "api:springdoc": "springdoc",
  "build:vite": "Vite",
  "test:junit": "JUnit",
  "test:vitest": "Vitest",
  "test:jest": "Jest",
  "test:playwright": "Playwright",
  "test:cypress": "Cypress",
  "test:testcontainers": "Testcontainers",
  "ci:github-actions": "GitHub Actions",
  "ci:gitlab": "GitLab CI",
  "container:docker": "Docker",
};

export function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

/** "uses Spring Boot", "contains Java code" — how a tag reads as a condition. */
export function tagPhrase(tag: string): string {
  const label = TAG_LABELS[tag];
  if (!label) return `is tagged ${tag}`;
  if (tag.startsWith("lang:")) return `contains ${label} code`;
  if (tag === "api:openapi") return "has an OpenAPI specification";
  return `uses ${label}`;
}

/** Accepts a known name ("Spring Boot") or a raw tag ("framework:spring-boot"). */
export function tagFromInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const known = Object.entries(TAG_LABELS).find(([tag, label]) => {
    const t = text.toLowerCase();
    return label.toLowerCase() === t || tag === t;
  });
  if (known) return known[0];
  return /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/.test(text) ? text : null;
}
