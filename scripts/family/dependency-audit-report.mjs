import { readFileSync, writeFileSync } from "node:fs";

// Only explicit audit artifacts are read. No environment or application data.
const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath) {
  throw new Error(
    "Usage: dependency-audit-report.mjs before.json after.json report.json",
  );
}

function parseAudit(path) {
  const advisories = new Map();
  const npmAdvisories = new Map();
  let summary = null;
  for (const line of readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (item.type === "auditSummary") summary = item.data;
    if (item.type !== "auditAdvisory") continue;
    const advisory = item.data.advisory;
    npmAdvisories.set(
      `${advisory.module_name}:${advisory.id}`,
      advisory.severity,
    );
    const id = advisory.github_advisory_id || String(advisory.id);
    const key = `${advisory.module_name}:${id}`;
    const existing = advisories.get(key) || {
      id,
      module: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      vulnerable: advisory.vulnerable_versions,
      patched: advisory.patched_versions,
      url: advisory.url,
      npmAdvisoryIds: [],
      installedVersions: [],
      paths: [],
    };
    existing.npmAdvisoryIds = [
      ...new Set([...existing.npmAdvisoryIds, advisory.id]),
    ].sort();
    for (const finding of advisory.findings || []) {
      existing.installedVersions.push(finding.version);
      existing.paths.push(...finding.paths);
    }
    existing.paths.push(item.data.resolution.path);
    existing.paths = [...new Set(existing.paths)].sort();
    existing.installedVersions = [
      ...new Set(existing.installedVersions),
    ].sort();
    advisories.set(key, existing);
  }
  if (!summary) throw new Error(`Incomplete audit artifact: ${path}`);
  const unique = [...advisories.values()];
  const counts = Object.fromEntries(
    ["critical", "high", "moderate", "low", "info"].map((severity) => [
      severity,
      unique.filter((item) => item.severity === severity).length,
    ]),
  );
  const npmCounts = Object.fromEntries(
    ["critical", "high", "moderate", "low", "info"].map((severity) => [
      severity,
      [...npmAdvisories.values()].filter((value) => value === severity).length,
    ]),
  );
  return {
    uniqueCount: unique.length,
    counts,
    npmUniqueCount: npmAdvisories.size,
    npmCounts,
    yarnSummary: summary,
    advisories: unique,
  };
}

const before = parseAudit(beforePath);
const after = parseAudit(afterPath);
const afterKeys = new Set(
  after.advisories.map((item) => `${item.module}:${item.id}`),
);
const report = {
  generatedAt: new Date().toISOString(),
  scope:
    "Yarn Classic production dependency audit; unique module + GHSA ID, independent of duplicated paths",
  before,
  after,
  removed: before.advisories
    .filter((item) => !afterKeys.has(`${item.module}:${item.id}`))
    .map(({ id, module, severity, url }) => ({ id, module, severity, url })),
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify({
    before: before.counts,
    beforeUnique: before.uniqueCount,
    after: after.counts,
    afterUnique: after.uniqueCount,
  }),
);
