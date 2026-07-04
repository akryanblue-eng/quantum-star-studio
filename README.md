# quantum-star-studio

Registry Plane for Quantum Star LLC. This repo is the system of record for
studio topology — it declares which projects exist and what role each plays.
It contains **no runtime logic** by design.

## Contents

- `studio-registry.json` — declarative map of active projects
  (name, repo, type). Read-only at runtime; never a runtime dependency.
- `scripts/rdd.js` — Registry Drift Detector (RDD v1.0).
- `.github/workflows/registry-drift.yml` — CI gate that runs RDD on every
  push/PR and weekly on a schedule.

## Registry Drift Detector

Core invariant:

> The registry is only valid if every declared system can be proven to
> exist as an observable repository containing real code. If registry
> ≠ reality, CI fails.

Checks, per declared project:

| Stage | Check | Failure code |
|-------|-------|--------------|
| 0 | Registry parses and matches schema | `SCHEMA` / `REGISTRY_UNPARSEABLE` |
| 1 | Declared repo exists on GitHub | `MISSING_NODE` |
| 2 | Repo contains actual code, not just metadata | `GHOST_NODE` |
| 3 | Code matches the declared language/type | `ROLE_MISMATCH` |

Run locally:

```sh
node scripts/rdd.js            # full reality check (needs network)
node scripts/rdd.js --offline  # schema validation only
```

If any project in the registry is a **private** repo, set an `RDD_TOKEN`
repository secret (a PAT with read access to the declared repos). The
default Actions `GITHUB_TOKEN` can only see this repo, so private siblings
would otherwise report `MISSING_NODE`.

A red RDD run is not a bug — it is the registry being caught describing
systems that do not (yet) exist. Fix it by either building the declared
system or removing/annotating the ghost entry.
