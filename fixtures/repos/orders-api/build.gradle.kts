plugins {
    alias(libs.plugins.spring.boot)
    id("io.spring.dependency-management") version "1.1.6"
    kotlin("jvm") version "2.0.20"
    kotlin("plugin.spring") version "2.0.20"
}

group = "com.example"
version = "0.9.0"

dependencies {
    implementation(libs.spring.boot.starter.web)
    implementation(libs.spring.boot.starter.jooq)
    implementation("org.postgresql:postgresql:42.7.4")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    // jooqGenerator("org.jooq:jooq-codegen") is configured in CI only.
}
