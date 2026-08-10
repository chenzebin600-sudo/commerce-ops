function option(argv, name) {
  const direct = argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function resolveProductKnowledgeImportTarget({ argv = [], configuredDatabase = "" } = {}) {
  const apply = argv.includes("--apply");
  const database = String(option(argv, "--database") || "").trim();
  const confirmedDatabase = String(option(argv, "--confirm-database") || "").trim();
  if (!apply) return Object.freeze({ apply: false, database: database || null });
  const configured = String(configuredDatabase || "").trim();
  if (!configured || !database || database !== configured || confirmedDatabase !== database) {
    throw new Error(
      `Product Knowledge import requires the active database and --database=${configured || "<configured>"} --confirm-database=${configured || "<configured>"}`,
    );
  }
  return Object.freeze({ apply: true, database });
}
