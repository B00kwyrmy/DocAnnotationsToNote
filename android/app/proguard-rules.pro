# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# ── ExportColorPDFCombined R8 keep-rules ──────────────────────────────────────
# 1. This plugin's OWN classes. PluginHost instantiates the native ReactPackage by
#    its fully-qualified name (com.docannotationstonote.ColorPdfRendererPackage,
#    from PluginConfig.json's reactPackages) by reflection — keep it un-renamed,
#    plus the renderer module that does all the PDF/PNG work.
-keep class com.docannotationstonote.** { *; }

# 2. The Supernote SDK (sn-plugin-lib) classes the host reaches by reflection.
-keep class com.ratta.** { *; }
-dontwarn com.ratta.**

# 3. React Native native modules (methods exposed to JS, @ReactModule classes).
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod <methods>; }
-keep @com.facebook.react.module.annotations.ReactModule class * { *; }
-dontwarn com.facebook.**

# 4. PdfBox-Android (text extraction). Uses reflection + bundled Java resources;
#    keep its classes and silence warnings about the desktop AWT/font bits it omits.
-keep class com.tom_roush.** { *; }
-dontwarn com.tom_roush.**
-dontwarn java.awt.**
-dontwarn javax.**
