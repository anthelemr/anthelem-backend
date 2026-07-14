import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// ---- GET /plans — everyone signed in can see plan options ----
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM plans ORDER BY price_cents NULLS LAST');
  res.json({ plans: result.rows });
});

const planSchema = z.object({
  name: z.string().min(1).max(100),
  priceCents: z.number().int().nullable().optional(),
  currency: z.string().length(3).optional().default('USD'),
  interval: z.enum(['month', 'year', 'forever', 'custom']).optional().default('month'),
  features: z.array(z.string()).optional().default([]),
  status: z.enum(['active', 'archived']).optional().default('active'),
});

// ---- POST /plans — founder only: pricing is a founder-level decision ----
router.post('/', requireAuth, requireRole('founder'), async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid plan.' });
  const d = parsed.data;
  const result = await pool.query(
    `INSERT INTO plans (name, price_cents, currency, interval, features, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.name, d.priceCents ?? null, d.currency, d.interval, JSON.stringify(d.features), d.status]
  );
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Plan created', detail: d.name });
  res.status(201).json({ plan: result.rows[0] });
});

// ---- PATCH /plans/:id — founder only ----
router.patch('/:id', requireAuth, requireRole('founder'), async (req, res) => {
  const parsed = planSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid update.' });
  const existing = await pool.query('SELECT * FROM plans WHERE id = $1', [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Plan not found.' });
  const d = { ...existing.rows[0], ...parsed.data };
  const features = parsed.data.features ? JSON.stringify(parsed.data.features) : existing.rows[0].features;
  const result = await pool.query(
    `UPDATE plans SET name=$1, price_cents=$2, currency=$3, interval=$4, features=$5, status=$6, updated_at=now()
     WHERE id=$7 RETURNING *`,
    [d.name, d.price_cents, d.currency, d.interval, features, d.status, req.params.id]
  );
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Plan updated', detail: d.name });
  res.json({ plan: result.rows[0] });
});

// ---- DELETE /plans/:id — founder only ----
router.delete('/:id', requireAuth, requireRole('founder'), async (req, res) => {
  const existing = await pool.query('SELECT name FROM plans WHERE id = $1', [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Plan not found.' });
  await pool.query('DELETE FROM plans WHERE id = $1', [req.params.id]);
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Plan removed', detail: existing.rows[0].name });
  res.json({ ok: true });
});

// ---- POST /plans/:id/subscribe — customer switches plan ----
// NOTE: for a paid plan this must actually go through Stripe Checkout /
// Subscriptions first — this endpoint should be called from the Stripe
// webhook handler on payment success, not directly from the client, once
// real billing is wired in. See routes/payments.js.
router.post('/:id/subscribe', requireAuth, async (req, res) => {
  const plan = await pool.query('SELECT * FROM plans WHERE id = $1', [req.params.id]);
  if (plan.rowCount === 0) return res.status(404).json({ error: 'Plan not found.' });
  await pool.query('UPDATE users SET plan_id = $1, updated_at = now() WHERE id = $2', [
    req.params.id,
    req.user.id,
  ]);
  await logAudit({
    actorId: req.user.id,
    actorName: req.user.email,
    action: 'Subscription changed',
    detail: `→ ${plan.rows[0].name}`,
  });
  await pool.query(
    `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
    [req.user.id, 'Subscription updated', `You're now on the ${plan.rows[0].name} plan.`]
  );
  res.json({ plan: plan.rows[0] });
});

export default router;
