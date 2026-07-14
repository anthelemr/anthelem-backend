import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// ---- GET /audit — founder/admin only ----
router.get('/', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json({ auditLog: result.rows });
});

// ---- GET /audit/me — own security events, any signed-in user ----
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM audit_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 20',
    [req.user.id]
  );
  res.json({ auditLog: result.rows });
});

// ---- GET /audit/analytics — founder/admin business-intelligence summary ----
router.get('/analytics', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const [users, products, revenue, byPlan] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active FROM users`),
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='published')::int AS published FROM products`),
    pool.query(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS total FROM payments WHERE status='succeeded'`),
    pool.query(`SELECT p.name, COUNT(u.id)::int AS count FROM plans p LEFT JOIN users u ON u.plan_id = p.id GROUP BY p.name`),
  ]);
  res.json({
    users: users.rows[0],
    products: products.rows[0],
    revenueCents: revenue.rows[0].total,
    planDistribution: byPlan.rows,
  });
});

export default router;
