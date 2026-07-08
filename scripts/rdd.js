#!/usr/bin/env node
/**
 * Registry Drift Detector (RDD v1.0)
 *
 * Hard gate: studio-registry.json is only valid if every project it
 * declares can be observed on GitHub as a real repository containing
 * real code that matches its declared type. If registry != reality,
 * this process exits non-zero and CI fails.
 *
 * Verification happens against the GitHub API (the only source of
 * truth reachable from a single-repo CI checkout), never against
 * sibling directories on disk.
 *
 * Modes:
 *   node scripts/rdd.js            full check (schema + GitHub reality)
 *   node scripts/rdd.js --offline  schema validation only, no network
 *
 * Auth: uses RDD_TOKEN or GITHUB_TOKEN if set. Public repos verify
 * without a token; private repos in the registry require RDD_TOKEN
 * (a PAT with read access to them), because the default Actions
 * GITHUB_TOKEN cannot see other repositories.
 */

import fs from "node:fs";

const REGISTRY_PATH = process.env.RDD_REGISTRY ?? "studio-registry.json";
const TOKEN = process.env.RDD_TOKEN || process.env.GITHUB_TOKEN || "";
const OFFLINE = process.argv.includes("--offline");
const API = "https://api.github.com";

// File signatures that count as evidence for a declared implementation
// language. Extend this map when new project types enter the registry.
const LANG_SIGNATURES = {
  "c#": [".cs", ".csproj", ".sln"],
  python: [".py", "pyproject.toml", "requirements.txt", "setup.py"],
  typescript: [".ts", ".tsx", "tsconfig.json"],
  javascript: [".js", ".mjs", "package.json"],
};

// Any of these mark a file as "code" for ghost detection, regardless of
// declared language.
const CODE_EXTENSIONS = [
  ".cs", ".py", ".ts", ".tsx", ".js", ".mjs", ".c", ".cpp", ".h",
  ".rs", ".go", ".java", ".rb", ".swift", ".kt", ".sh",
];

const failures = [];
const warnings = [];
// repair = { expected, actual, fix } — every failure must state not just
// what is wrong, but what state was expected and the minimal change that
// resolves the drift.
const fail = (code, node, msg, repair) =>
  failures.push({ code, node, msg, repair });
const warn = (code, node, msg) => warnings.push({ code, node, msg });

async function gh(path) {
  const headers = { accept: "application/vnd.github+json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${API}${path}`, { headers });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

function parseRepoUrl(url) {
  const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return m ? { owner: m[1], repo: m[2] } : null;
}

function declaredLanguage(type) {
  const m = /\(([^)]+)\)/.exec(type ?? "");
  return m ? m[1].trim().toLowerCase() : null;
}

// ---- Stage 0: registry schema ------------------------------------------
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fail("REGISTRY_MISSING", REGISTRY_PATH, "registry file not found");
    return null;
  }
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  } catch (e) {
    fail("REGISTRY_UNPARSEABLE", REGISTRY_PATH, e.message);
    return null;
  }
  if (!reg.studio_name) fail("SCHEMA", "studio_name", "missing");
  if (!reg.owner) fail("SCHEMA", "owner", "missing");
  if (!Array.isArray(reg.active_projects) || reg.active_projects.length === 0) {
    fail("SCHEMA", "active_projects", "missing or empty");
    return reg;
  }
  for (const p of reg.active_projects) {
    if (!p.name) fail("SCHEMA", JSON.stringify(p), "project missing name");
    if (!parseRepoUrl(p.repo)) {
      fail("SCHEMA", p.name ?? "?", `repo is not a valid GitHub URL: ${p.repo}`);
    }
    if (!p.type) warn("SCHEMA", p.name ?? "?", "project has no declared type");
  }
  return reg;
}

// ---- Stages 1-3: reality checks per declared node ----------------------
async function checkProject(project) {
  const id = project.name;
  const loc = parseRepoUrl(project.repo);
  if (!loc) return; // already failed in schema stage

  // Stage 1: declared node must exist as a repo.
  const repoRes = await gh(`/repos/${loc.owner}/${loc.repo}`);
  if (repoRes.status === 404) {
    fail(
      "MISSING_NODE",
      id,
      `repo ${loc.owner}/${loc.repo} not found (404)`,
      {
        expected: `${loc.owner}/${loc.repo} exists and is readable`,
        actual: "GitHub reports the repo does not exist (or token cannot see it)",
        fix:
          "create the repo, remove this registry entry, or set RDD_TOKEN " +
          "to a PAT that can read it if the repo is private",
      }
    );
    return;
  }
  if (repoRes.status !== 200) {
    fail(
      "UNVERIFIABLE_NODE",
      id,
      `GitHub API returned ${repoRes.status} for ${loc.owner}/${loc.repo}`,
      {
        expected: "GitHub API confirms the repo exists (HTTP 200)",
        actual: `HTTP ${repoRes.status} — existence cannot be proven`,
        fix: "check token permissions / API rate limits and re-run",
      }
    );
    return;
  }

  // Stage 2: ghost detection — the repo must contain actual code.
  const branch = repoRes.body.default_branch;
  const treeRes = await gh(
    `/repos/${loc.owner}/${loc.repo}/git/trees/${branch}?recursive=1`
  );
  if (treeRes.status !== 200) {
    fail(
      "GHOST_NODE",
      id,
      `default branch ${branch} has no readable tree (empty repo?)`,
      {
        expected: `a populated default branch implementing "${project.type}"`,
        actual: "repo exists but its default branch has no file tree",
        fix: `push an initial implementation to ${loc.owner}/${loc.repo} or remove the registry entry`,
      }
    );
    return;
  }
  const files = treeRes.body.tree
    .filter((t) => t.type === "blob")
    .map((t) => t.path.toLowerCase());
  const codeFiles = files.filter((f) =>
    CODE_EXTENSIONS.some((ext) => f.endsWith(ext))
  );
  if (codeFiles.length === 0) {
    const lang = declaredLanguage(project.type) ?? "code";
    fail(
      "GHOST_NODE",
      id,
      `declared as "${project.type}" but contains no code ` +
        `(${files.length} file(s), all metadata/config)`,
      {
        expected: `repo contains ${lang} sources implementing "${project.type}"`,
        actual: `${files.length} file(s), none are code`,
        fix:
          `initialize a ${lang} scaffold with a real entrypoint in ` +
          `${loc.owner}/${loc.repo}, or mark this registry entry as planned/inactive`,
      }
    );
    return;
  }
  if (treeRes.body.truncated) {
    warn("TREE_TRUNCATED", id, "file tree truncated by API; checks ran on a partial listing");
  }

  // Stage 3: role consistency — code must match the declared language.
  const lang = declaredLanguage(project.type);
  const sigs = lang ? LANG_SIGNATURES[lang] : null;
  if (sigs) {
    const hit = files.some((f) => sigs.some((s) => f.endsWith(s)));
    if (!hit) {
      fail(
        "ROLE_MISMATCH",
        id,
        `declared "${project.type}" but no ${lang} signature files found ` +
          `(looked for ${sigs.join(", ")})`,
        {
          expected: `${lang} signature files (${sigs.join(", ")}) present`,
          actual: `${codeFiles.length} code file(s) found, none matching ${lang}`,
          fix:
            "correct the declared type in the registry to match the actual " +
            "implementation, or port the implementation to the declared language",
        }
      );
    }
  } else if (lang) {
    warn("UNKNOWN_LANGUAGE", id, `no signature list for declared language "${lang}"`);
  }
}

// ---- Report -------------------------------------------------------------
function report(registry) {
  const n = registry?.active_projects?.length ?? 0;
  console.log(`\nRegistry Drift Detector — ${REGISTRY_PATH} (${n} declared node(s))`);
  console.log(OFFLINE ? "mode: offline (schema only)\n" : "mode: full reality check\n");

  for (const w of warnings) console.log(`⚠️  [${w.code}] ${w.node}: ${w.msg}`);
  for (const f of failures) {
    console.log(`❌ [${f.code}] ${f.node}: ${f.msg}`);
    if (f.repair) {
      console.log(`   EXPECTED_STATE: ${f.repair.expected}`);
      console.log(`   ACTUAL_STATE:   ${f.repair.actual}`);
      console.log(`   MINIMAL_FIX:    ${f.repair.fix}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n❌ REGISTRY DRIFT DETECTED — ${failures.length} violation(s).`);
    console.log("The registry describes systems that cannot be observed. Fix the");
    console.log("registry (remove/annotate ghost nodes) or make the systems real.");
    process.exit(1);
  }
  console.log(
    OFFLINE
      ? "✅ Registry schema valid (offline mode — reality not verified)."
      : "✅ Registry aligned with observable reality."
  );
}

const registry = loadRegistry();
if (registry && !OFFLINE && failures.length === 0) {
  for (const p of registry.active_projects) {
    await checkProject(p);
  }
}
report(registry);
