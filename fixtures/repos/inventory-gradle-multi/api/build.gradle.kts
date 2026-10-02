plugins {
    id("inventory.java-conventions")
    id("org.springframework.boot") version "3.3.2"
    kotlin("jvm") version "2.0.20"
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.flywaydb:flyway-core")
    runtimeOnly("org.postgresql:postgresql:42.7.4")
}
