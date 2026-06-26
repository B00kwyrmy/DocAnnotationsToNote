#!/usr/bin/env bash
# Build ExportEPUBColorPDF.snplg
# Requires: JDK 17+, Android SDK, ANDROID_HOME set
set -e

PLUGIN_KEY="DocAnnotationsToNote"          # JS bundle name (matches PluginConfig pluginKey + app.json name)
OUT_NAME="DocAnnotationsToNote"            # deliverable filename: AnnotationProbe.snplg
# NOTE: native android package stays com.docannotationstonote (we reuse that native
# module unchanged for its writeFile capability); reactPackages below still points there.
GEN_DIR="build/generated"
OUT_DIR="build/outputs"

echo "Installing JS dependencies…"
npm install

echo "Bundling JavaScript…"
mkdir -p "$GEN_DIR" "$OUT_DIR"
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output "$GEN_DIR/${PLUGIN_KEY}.bundle" \
  --assets-dest "$GEN_DIR"

echo "Building native module (requires JDK 17+)…"
cd android
./gradlew buildCustomApkDebug
cd ..

echo "Copying native module APK…"
cp android/app/build/outputs/apk/debug/app-debug-custom.apk "$GEN_DIR/app.npk"

echo "Packaging .snplg…"
cp PluginConfig.json "$GEN_DIR/"
cp assets/icon.png "$GEN_DIR/icon.png"
python3 -c "
import json
cfg = json.load(open('$GEN_DIR/PluginConfig.json'))
cfg['iconPath'] = '/icon.png'
cfg['nativeCodePackage'] = '/app.npk'
cfg['reactPackages'] = ['com.docannotationstonote.ColorPdfRendererPackage']
json.dump(cfg, open('$GEN_DIR/PluginConfig.json', 'w'), indent=2)
"

rm -f "$OUT_DIR/${OUT_NAME}.snplg"
cd "$GEN_DIR"
zip -r "../../$OUT_DIR/${OUT_NAME}.snplg" . -x "*.snplg" -x "*.zip"
cd ../..

echo "Done → $OUT_DIR/${OUT_NAME}.snplg"
