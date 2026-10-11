// Points the DrKLO/Telegram Android sources at the AIPGram server (gramsrv) and rebrands the app.
// Idempotent: run `node aipgram/apply.js` from the repository root, also after merging upstream.
const fs = require("fs");
const path = require("path");

const SERVER_IP = "2.27.200.223";
const SERVER_PORT = 2398;
const APP_ID = 90000001;
const APP_HASH = "6f0c7ab1a4e3d2b58c91f07e5d34a2c1"; // gramsrv does not check it; any 32 hex chars
const PACKAGE = "org.aipgram.messenger";
const APP_NAME = "AIPGram";
const LINK_HOST = "aipgram.duckdns.org"; // public links (t.me on Telegram)
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
  return t.replace(/"org\.telegram\.messenger\.beta"\.equals/, `"${PACKAGE}.beta".equals`);
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
edit("TMessagesProj/src/main/java/org/telegram/messenger/MessagesController.java", (t) =>
  t.replace(`getString("linkPrefix", "t.me")`, `getString("linkPrefix", "${LINK_HOST}")`));
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
