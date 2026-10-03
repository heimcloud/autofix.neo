# Effective autofix target list (rendered to OPS_TARGETS / targets.json).
# Exactly the configured targets, null fields dropped (the app fills defaults).
# Outside modules/ on purpose (modules/ is import-tree'd).
{
  lib,
  cfg,
}:
map (t: lib.filterAttrs (_: v: v != null) (removeAttrs t ["_module"])) (cfg.targets or [])
