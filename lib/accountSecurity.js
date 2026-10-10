// 密码变更统一递增会话版本，下一次请求即撤销其它旧登录。
function updateUserPassword(db, id, passwordHash) {
  return db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?')
    .run(passwordHash, id);
}

function sessionUser(row) {
  return { id: row.id, username: row.username, name: row.name, role: row.role, authVersion: row.auth_version };
}

module.exports = { updateUserPassword, sessionUser };
