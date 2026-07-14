import { pool } from '../db.js';

export async function logAudit({ actorId = null, actorName = null, action, detail = null, ip = null }) {
  await pool.query(
    `INSERT INTO audit_log (actor_id, actor_name, action, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, actorName, action, detail, ip]
  );
}
