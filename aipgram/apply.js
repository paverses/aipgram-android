// Points the DrKLO/Telegram Android sources at the Airagram server (gramsrv) and rebrands the app.
// Idempotent: run `node aipgram/apply.js` from the repository root, also after merging upstream.
const fs = require("fs");
const path = require("path");

const SERVER_IP = "2.27.200.223";
const SERVER_PORT = 2398;
const APP_ID = 90000001;
const APP_HASH = "6f0c7ab1a4e3d2b58c91f07e5d34a2c1"; // gramsrv does not check it; any 32 hex chars
const PACKAGE = "org.airagram.messenger";
const APP_NAME = "Airagram";
const LINK_HOST = "airagram.top"; // public links (t.me on Telegram)
const OLD_LINK_HOST = "airagram.duckdns.org"; // previous domain, still opened in the app
const RSA_KEY = [
  "-----BEGIN RSA PUBLIC KEY-----",
  "MIIBCgKCAQEAuwI+651GHh3hcvtJZmZbFw6KvldOtxcsdBe95Woa6mnRoIz4xQBq",
  "yFaLNnzKFRawuh8++7x2kup+XZY+rlSAmEqLcNTSMyqcPkON/YMujSbpZrm0Q3Sy",
  "IJrALPUmq/oUEedldmf0mqDGvUylqY6iKSaEA9oD2AXRupFqvZEc3c90ZsYmog7J",
  "N9nwtBch+bsPEWaTkOjUUJQlpwP3UTAa2bvCusu8P5cQPp1RjeKj8MUPkgWwmL/N",
  "4EgdboJEdP6Ew7/Ie99hZQYmze5enwN990wrgJ9/kX4KzDYil3R0wSFdN3gem9uy",
  "jmlmZH5ZKn2JgO5scJpswZ7oqYTTysyWlwIDAQAB",
  "-----END RSA PUBLIC KEY-----",
];
const RSA_FINGERPRINT = "0xebdfef51b081fda5";

const root = path.resolve(__dirname, "..");
function edit(rel, fn) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) {
    console.log("unchanged", rel);
    return;
  }
  fs.writeFileSync(file, after);
  console.log("patched  ", rel);
}
function walkJava(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJava(full, out);
    else if (entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}
function mustReplace(text, re, replacement, what) {
  if (!re.test(text)) throw new Error("pattern not found: " + what);
  return text.replace(re, replacement);
}

// 1. Data centers: every DC (production and test) is the AIPGram server; no IPv6.
edit("TMessagesProj/jni/tgnet/ConnectionsManager.cpp", (t) => {
  const dcs = (ids) => ids.map((id) => [
    `        if (datacenters.find(${id}) == datacenters.end()) {`,
    `            datacenter = new Datacenter(instanceNum, ${id});`,
    `            datacenter->addAddressAndPort("${SERVER_IP}", ${SERVER_PORT}, 0, "");`,
    `            datacenters[${id}] = datacenter;`,
    `        }`,
  ].join("\n")).join("\n\n");
  const body = [
    "void ConnectionsManager::initDatacenters() {",
    "    // AIPGram: all data centers are served by the AIPGram server.",
    "    Datacenter *datacenter;",
    "    if (!testBackend) {",
    dcs([1, 2, 3, 4, 5]),
    "    } else {",
    dcs([1, 2, 3]),
    "    }",
    "}",
  ].join("\n");
  return mustReplace(t, /void ConnectionsManager::initDatacenters\(\) \{[\s\S]*?\n\}\n/, body + "\n", "initDatacenters");
});

// 2. Server RSA key used for the auth-key handshake (both backends).
edit("TMessagesProj/jni/tgnet/Handshake.cpp", (t) => {
  const pem = RSA_KEY.map((line, i) => `"${line}${i < RSA_KEY.length - 1 ? "\\n" : ""}"`)
    .join("\n                                                  ");
  const block = [
    "            if (serverPublicKeys.empty()) {",
    "                // AIPGram: the AIPGram server key (same for the test backend).",
    `                serverPublicKeys.emplace_back(${pem});`,
    `                serverPublicKeysFingerprints.push_back(${RSA_FINGERPRINT});`,
    "            }",
  ].join("\n");
  return mustReplace(t, /            if \(serverPublicKeys\.empty\(\)\) \{\n                (if \(ConnectionsManager|\/\/ AIPGram)[\s\S]*?\n            \}\n/, block + "\n", "serverPublicKeys");
});

// 3. Application identity (no Telegram api keys needed: gramsrv accepts it).
edit("TMessagesProj/src/main/java/org/telegram/messenger/BuildVars.java", (t) => {
  t = mustReplace(t, /public static int APP_ID = \d+;/, `public static int APP_ID = ${APP_ID};`, "APP_ID");
  t = mustReplace(t, /public static String APP_HASH = "[0-9a-f]*";/, `public static String APP_HASH = "${APP_HASH}";`, "APP_HASH");
  return t.replace(/"org\.(telegram|aipgram)\.messenger\.beta"\.equals/, `"${PACKAGE}.beta".equals`);
});

// 4. Package name, so the app installs next to the official Telegram.
edit("gradle.properties", (t) => mustReplace(t, /^APP_PACKAGE=.*$/m, `APP_PACKAGE=${PACKAGE}`, "APP_PACKAGE"));

// 5. google-services.json must list the new package names or the Gradle plugin refuses to build.
edit("TMessagesProj_App/google-services.json", (t) => {
  const json = JSON.parse(t);
  const template = json.client[0];
  for (const suffix of ["", ".beta", ".web"]) {
    const name = PACKAGE + suffix;
    if (json.client.some((c) => c.client_info.android_client_info.package_name === name)) continue;
    const copy = JSON.parse(JSON.stringify(template));
    copy.client_info.android_client_info.package_name = name;
    json.client.push(copy);
  }
  return JSON.stringify(json, null, 2) + "\n";
});

// 6. Public links live on our domain instead of t.me: the fallback prefix before the server config
//    arrives, the intent filter for links opened from other apps, and every hard-coded host check.
edit("TMessagesProj/src/main/java/org/telegram/messenger/MessagesController.java", (t) => t
  .replace(`getString("linkPrefix", "t.me")`, `getString("linkPrefix", "${LINK_HOST}")`)
  .replace(`getString("linkPrefix", "${OLD_LINK_HOST}")`, `getString("linkPrefix", "${LINK_HOST}")`));
edit("TMessagesProj/src/main/AndroidManifest.xml", (t) => {
  if (t.includes(`android:host="${LINK_HOST}"`)) return t;
  return mustReplace(t, /( *)<data android:host="t\.me" android:scheme="https" \/>\n/,
    (m, indent) => m + `${indent}<data android:host="${LINK_HOST}" android:scheme="http" />\n${indent}<data android:host="${LINK_HOST}" android:scheme="https" />\n`,
    "t.me intent filter");
});
// aipgram:// (the scheme of our public link pages; gramsrv reserves tg) opens like tg://
edit("TMessagesProj/src/main/AndroidManifest.xml", (t) => t.includes('android:scheme="aipgram"') ? t :
  mustReplace(t, /( *)<data android:scheme="tg" \/>\n/, (m, indent) => m + `${indent}<data android:scheme="aipgram" />\n`, "tg scheme filter"));
edit("TMessagesProj/src/main/java/org/telegram/ui/LaunchActivity.java", (t) => t.includes('"aipgram".equalsIgnoreCase') ? t :
  mustReplace(t, /( *)Uri data = intent\.getData\(\);\n/, (m, indent) =>
    `${indent}// AIPGram: aipgram:// links from our public pages behave like tg:// ones\n` +
    `${indent}Uri data = intent.getData() != null && "aipgram".equalsIgnoreCase(intent.getData().getScheme())\n` +
    `${indent}        ? Uri.parse("tg" + intent.getData().toString().substring("aipgram".length()))\n` +
    `${indent}        : intent.getData();\n`, "LaunchActivity data"));
for (const file of walkJava(path.join(root, "TMessagesProj/src/main/java"))) {
  edit(path.relative(root, file), (t) => {
    if (!t.includes('"t.me"') || t.includes(`"${LINK_HOST}".equals`) || t.includes(`.equals("${LINK_HOST}")`)) return t;
    return t
      .replace(/"t\.me"\.(equals|equalsIgnoreCase)\(([^()]*(?:\([^()]*\))?)\)/g,
        (m, eq, arg) => `(${m} || "${LINK_HOST}".${eq}(${arg}))`)
      .replace(/([A-Za-z_][\w.]*(?:\(\))?)\.(equals|equalsIgnoreCase)\("t\.me"\)/g,
        (m, recv, eq) => `(${m} || ${recv}.${eq}("${LINK_HOST}"))`);
  });
}

// 7. App name.
edit("TMessagesProj/src/main/res/values/strings.xml", (t) => {
  t = mustReplace(t, /<string name="AppName">[^<]*<\/string>/, `<string name="AppName">${APP_NAME}</string>`, "AppName");
  return mustReplace(t, /<string name="AppNameBeta">[^<]*<\/string>/, `<string name="AppNameBeta">${APP_NAME} Beta</string>`, "AppNameBeta");
});


// 8. airagram:// opens like tg:// as well (aipgram:// from the old link pages keeps working).
edit("TMessagesProj/src/main/AndroidManifest.xml", (t) => t.includes('android:scheme="airagram"') ? t :
  mustReplace(t, /( *)<data android:scheme="tg" \/>\n/, (m, indent) => m + `${indent}<data android:scheme="airagram" />\n`, "tg scheme filter"));
edit("TMessagesProj/src/main/java/org/telegram/ui/LaunchActivity.java", (t) => t.includes('"airagram".equalsIgnoreCase') ? t :
  mustReplace(t,
    /Uri data = intent\.getData\(\) != null && "aipgram"\.equalsIgnoreCase\(intent\.getData\(\)\.getScheme\(\)\)\n(\s*)\? Uri\.parse\("tg" \+ intent\.getData\(\)\.toString\(\)\.substring\("aipgram"\.length\(\)\)\)/,
    (m, indent) => 'Uri data = intent.getData() != null && ("aipgram".equalsIgnoreCase(intent.getData().getScheme()) || "airagram".equalsIgnoreCase(intent.getData().getScheme()))\n' +
      indent + '? Uri.parse("tg" + intent.getData().toString().substring(intent.getData().getScheme().length()))', "LaunchActivity scheme"));

// 9. Own launcher icon instead of the Telegram plane (rendered by aipgram/branding/make_icons.py).
{
  const res = path.join(root, "TMessagesProj/src/main/res");
  const brand = path.join(__dirname, "branding/res");
  for (const dir of fs.readdirSync(brand)) {
    if (!dir.startsWith("mipmap-")) continue;
    for (const file of fs.readdirSync(path.join(brand, dir))) {
      fs.copyFileSync(path.join(brand, dir, file), path.join(res, dir, file));
    }
    // every launcher bitmap variant (default and alternate icons) becomes the Airagram icon
    for (const file of fs.readdirSync(path.join(res, dir))) {
      if (!/^(ic_launcher|icon_\d+_launcher)(_round)?\.png$/.test(file)) continue;
      const src = file.includes("_round") ? "airagram_launcher_round.png" : "airagram_launcher.png";
      fs.copyFileSync(path.join(brand, dir, src), path.join(res, dir, file));
    }
  }
  const adaptive = path.join(res, "mipmap-anydpi-v26");
  for (const file of fs.readdirSync(adaptive)) {
    if (!file.endsWith(".xml")) continue;
    edit(path.relative(root, path.join(adaptive, file)), () => [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <background android:drawable="@mipmap/airagram_background" />',
      '    <foreground android:drawable="@mipmap/airagram_foreground" />',
      '    <monochrome android:drawable="@mipmap/airagram_foreground" />',
      '</adaptive-icon>',
      ''].join("\n"));
  }
  console.log("copied    launcher icons");
}

// 10. Drop permissions a messenger without calls or self-updates does not need; antivirus heuristics
//     treat them (installing packages, overlays, background location, phone control) as spyware signals.
const REMOVED_PERMISSIONS = ["REQUEST_INSTALL_PACKAGES", "INSTALL_PACKAGES", "SYSTEM_ALERT_WINDOW", "CALL_PHONE",
  "READ_PHONE_NUMBERS", "READ_PHONE_STATE", "READ_CALL_LOG", "ACCESS_BACKGROUND_LOCATION", "MANAGE_OWN_CALLS"];
edit("TMessagesProj_App/src/main/AndroidManifest.xml", (t) => {
  if (t.includes("Airagram: permissions removed")) return t;
  const lines = REMOVED_PERMISSIONS.map((name) =>
    `    <uses-permission android:name="android.permission.${name}" tools:node="remove" />`).join("\n");
  return mustReplace(t, /(android:installLocation="auto">\n)/, `$1\n    <!-- Airagram: permissions removed from the merged manifest -->\n${lines}\n`, "app manifest");
});

// 11. Release signing with the Airagram key when CI provides it (AIRAGRAM_KEYSTORE / AIRAGRAM_KEYSTORE_PASSWORD),
//     never with the public Telegram keystore that malware clones also use.
edit("TMessagesProj_App/build.gradle", (t) => t.includes("AIRAGRAM_KEYSTORE") ? t :
  mustReplace(t, /        release \{\n            storeFile file\("\.\.\/TMessagesProj\/config\/release\.keystore"\)\n            storePassword RELEASE_STORE_PASSWORD\n            keyAlias RELEASE_KEY_ALIAS\n            keyPassword RELEASE_KEY_PASSWORD\n        \}/,
    [
      "        release {",
      '            def airagramKeystore = System.getenv("AIRAGRAM_KEYSTORE")',
      '            storeFile file(airagramKeystore ?: "../TMessagesProj/config/release.keystore")',
      '            storePassword airagramKeystore ? System.getenv("AIRAGRAM_KEYSTORE_PASSWORD") : RELEASE_STORE_PASSWORD',
      '            keyAlias airagramKeystore ? "airagram" : RELEASE_KEY_ALIAS',
      '            keyPassword airagramKeystore ? System.getenv("AIRAGRAM_KEYSTORE_PASSWORD") : RELEASE_KEY_PASSWORD',
      "        }",
    ].join("\n"), "release signing config"));

// 12. Native code goes through ccache when CI provides it, so unchanged C/C++ is not recompiled every build.
edit("TMessagesProj/build.gradle", (t) => t.includes("CMAKE_C_COMPILER_LAUNCHER") ? t :
  mustReplace(t, /(externalNativeBuild \{\n\s+cmake \{\n\s+version '[^']+'\n\s+arguments )/,
    `$1'-DCMAKE_C_COMPILER_LAUNCHER=' + (System.getenv("AIRAGRAM_CCACHE") ?: ''), '-DCMAKE_CXX_COMPILER_LAUNCHER=' + (System.getenv("AIRAGRAM_CCACHE") ?: ''), `,
    "cmake arguments"));
