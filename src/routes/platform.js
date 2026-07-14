import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// ---- GET /platform/settings — public read (used to e.g. block signups) ----
router.get('/settings', async (req, res) => {
  const result = await pool.query('SELECT key, value FROM platform_settings');
  const settings = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
  res.json({ settings });
});

// ---- PATCH /platform/settings/:key — founder only ----
router.patch('/settings/:key', requireAuth, requireRole('founder'), async (req, res) => {
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'Missing value.' });
  const result = await pool.query(
    `UPDATE platform_settings SET value = $1, updated_at = now() WHERE key = $2 RETURNING *`,
    [JSON.stringify(value), req.params.key]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Unknown setting.' });
  await logAudit({
    actorId: req.user.id,
    actorName: req.user.email,
    action: 'Platform toggle changed',
    detail: `${req.params.key} = ${JSON.stringify(value)}`,
  });
  res.json({ setting: result.rows[0] });
});

export default router;
