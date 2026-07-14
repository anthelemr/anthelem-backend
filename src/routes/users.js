import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();
const safeCols = 'id, name, email, role, status, plan_id, created_at, updated_at';

// ---- GET /users/me ----
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT ${safeCols} FROM users WHERE id = $1`, [req.user.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: result.rows[0] });
});

// ---- PATCH /users/me ----
const updateMeSchema = z.object({ name: z.string().min(1).max(200) });
router.patch('/me', requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid update.' });
  const result = await pool.query(
    `UPDATE users SET name = $1, updated_at = now() WHERE id = $2 RETURNING ${safeCols}`,
    [parsed.data.name, req.user.id]
  );
  await logAudit({ actorId: req.user.id, actorName: parsed.data.name, action: 'Profile updated' });
  res.json({ user: result.rows[0] });
});

// ---- GET /users — founder/admin only, lists everyone ----
router.get('/', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const search = (req.query.q || '').toString().trim();
  const result = search
    ? await pool.query(
        `SELECT ${safeCols} FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY created_at DESC`,
        [`%${search}%`]
      )
    : await pool.query(`SELECT ${safeCols} FROM users ORDER BY created_at DESC`);
  res.json({ users: result.rows });
});

// ---- PATCH /users/:id — founder/admin manage another user ----
const manageSchema = z.object({
  role: z.enum(['founder', 'admin', 'customer']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  planId: z.string().uuid().nullable().optional(),
});
router.patch('/:id', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const parsed = manageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid update.' });
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't manage your own account from this endpoint." });
  }
  // Only a founder may change roles — admins can manage status/plan only.
  if (parsed.data.role && req.user.role !== 'founder') {
    return res.status(403).json({ error: 'Only the founder can change roles.' });
  }

  const target = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (target.rowCount === 0) return res.status(404).json({ error: 'User not found.' });

  const merged = { ...target.rows[0], ...parsed.data, plan_id: parsed.data.planId ?? target.rows[0].plan_id };
  const result = await pool.query(
    `UPDATE users SET role = $1, status = $2, plan_id = $3, updated_at = now()
     WHERE id = $4 RETURNING ${safeCols}`,
    [merged.role, merged.status, merged.plan_id, req.params.id]
  );
  await pool.query(
    `INSERT INTO notifications (user_id, title, body, type) VALUES ($1, $2, $3, 'info')`,
    [req.params.id, 'Account updated', 'An administrator updated your account settings.']
  );
  await logAudit({
    actorId: req.user.id,
    actorName: req.user.email,
    action: 'User updated',
    detail: target.rows[0].email,
  });
  res.json({ user: result.rows[0] });
});

export default router;
