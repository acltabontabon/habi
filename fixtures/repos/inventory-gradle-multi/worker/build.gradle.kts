plugins {
    id("inventory.java-conventions")
    application
}

val queueVersion = "2.1.0"

dependencies {
    implementation("com.example.queue:client:$queueVersion")
}
