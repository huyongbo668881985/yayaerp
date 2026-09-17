function writeAuditLog(db, user, action, entityType, entityId, summary) {
  db.prepare(`INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, summary)
    VALUES (?,?,?,?,?,?)`).run(user.id, user.name, action, entityType, entityId || null, summary || '');
}

module.exports = { writeAuditLog };
