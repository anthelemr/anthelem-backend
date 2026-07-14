import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// ---- GET /notifications — own + broadcast ----
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ notifications: result.rows });
});

// ---- POST /notifications/read-all ----
router.post('/read-all', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE notifications SET read_at = now() WHERE (user_id = $1 OR user_id IS NULL) AND read_at IS NULL`,
    [req.user.id]
  );
  res.json({ ok: true });
});

// ---- POST /notifications/broadcast — founder only, platform announcement ----
router.post('/broadcast', requireAuth, requireRole('founder'), async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required.' });
  await pool.query(
    `INSERT INTO notifications (user_id, title, body, type) VALUES (NULL, $1, $2, 'announcement')`,
    [title, body]
  );
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Announcement sent', detail: title });
  res.status(201).json({ ok: true });
});

export default router;
