# Don't obfuscate code
-dontobfuscate

# Our code
-keep class com.limelight.binding.input.evdev.* {*;}

# Moonlight common
-keep class com.limelight.nvstream.jni.* {*;}

# The pinned WebRTC AAR does not supply consumer rules. Its native library
# resolves these Java ABI classes and callbacks at runtime, outside R8's Java
# reachability graph (including org.jni_zero.JniZero during JNI_OnLoad).
# Preserve the SDK boundary; application/resource shrinking remains enabled.
-keep class org.webrtc.** { *; }
-keepclasseswithmembers,includedescriptorclasses class org.jni_zero.** {
    @org.jni_zero.CalledByNative <methods>;
}
-keepclasseswithmembers,includedescriptorclasses class org.jni_zero.** {
    @org.jni_zero.CalledByNativeUnchecked <methods>;
}

# Okio
-keep class sun.misc.Unsafe {*;}
-dontwarn java.nio.file.*
-dontwarn org.codehaus.mojo.animal_sniffer.IgnoreJRERequirement
-dontwarn okio.**

# BouncyCastle
-keep class org.bouncycastle.jcajce.provider.asymmetric.* {*;}
-keep class org.bouncycastle.jcajce.provider.asymmetric.util.* {*;}
-keep class org.bouncycastle.jcajce.provider.asymmetric.rsa.* {*;}
-keep class org.bouncycastle.jcajce.provider.digest.** {*;}
-keep class org.bouncycastle.jcajce.provider.symmetric.** {*;}
-keep class org.bouncycastle.jcajce.spec.* {*;}
-keep class org.bouncycastle.jce.** {*;}
-dontwarn javax.naming.**

# jMDNS
-dontwarn javax.jmdns.impl.DNSCache
-dontwarn org.slf4j.**
