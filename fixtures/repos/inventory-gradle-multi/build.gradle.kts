// Root build: shared settings only. Convention plugins in buildSrc may add
// dependencies Habi cannot see without running Gradle.
subprojects {
    repositories { mavenCentral() }
}
