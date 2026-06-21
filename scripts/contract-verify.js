const fs = require("fs");
const path = require("path");

const CONTRACT_PATH = "repo.contract.v1.json";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function existsMatch(pattern) {
  if (!pattern.includes("*")) {
    return fs.existsSync(pattern);
  }
  const dir = path.dirname(pattern);
  const prefix = path.basename(pattern).replace("*", "");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.startsWith(prefix));
}

if (!fs.existsSync(CONTRACT_PATH)) {
  console.log("No repo.contract.v1.json found — defaulting to registry-safe, skipping checks.");
  process.exit(0);
}

const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8"));

if (contract.plane === "registry" && contract.deployable) {
  fail("REGISTRY_CANNOT_BE_DEPLOYABLE");
}

if (contract.plane === "surface" && !contract.deployable) {
  fail("SURFACE_MUST_BE_DEPLOYABLE");
}

for (const pattern of contract.forbidden || []) {
  if (existsMatch(pattern)) {
    fail(`FORBIDDEN_ARTIFACT_PRESENT: ${pattern}`);
  }
}

console.log("CONTRACT_VALID");
