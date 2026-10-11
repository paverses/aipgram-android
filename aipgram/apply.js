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

// 6. App name.
edit("TMessagesProj/src/main/res/values/strings.xml", (t) => {
  t = mustReplace(t, /<string name="AppName">[^<]*<\/string>/, `<string name="AppName">${APP_NAME}</string>`, "AppName");
  return mustReplace(t, /<string name="AppNameBeta">[^<]*<\/string>/, `<string name="AppNameBeta">${APP_NAME} Beta</string>`, "AppNameBeta");
});
