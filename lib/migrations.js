function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function columnExists(db, table, column) {
  return db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1')
    .get(table, column) !== undefined;
}

function addColumnIfMissing(db, table, columnDef) {
  const column = String(columnDef).trim().split(/\s+/)[0].replace(/^["'`\[]|["'`\]]$/g, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`非法迁移标识符: ${table}.${column}`);
  }
  if (columnExists(db, table, column)) return false;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${columnDef}`);
  return true;
}

function applyMigration(db, version, name, up) {
  ensureMigrationTable(db);
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
  if (applied) return false;
  try {
    up();
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
    console.log(`[migration] 已应用 v${version}: ${name}`);
    return true;
  } catch (error) {
    const wrapped = new Error(`数据库迁移失败 v${version} (${name}): ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

module.exports = { ensureMigrationTable, columnExists, addColumnIfMissing, applyMigration };
