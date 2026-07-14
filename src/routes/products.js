import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// ---- GET /products ----
// Customers only see published products; founder/admin see everything.
router.get('/', requireAuth, async (req, res) => {
  const isPriv = req.user.role === 'founder' || req.user.role === 'admin';
  const result = isPriv
    ? await pool.query('SELECT * FROM products ORDER BY created_at DESC')
    : await pool.query("SELECT * FROM products WHERE status = 'published' ORDER BY created_at DESC");
  res.json({ products: result.rows });
});

const productSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  category: z.string().max(100).optional().default(''),
  version: z.string().max(50).optional().default('1.0'),
  status: z.enum(['draft', 'published', 'hidden']).optional().default('draft'),
  requiredPlanId: z.string().uuid().nullable().optional(),
});

// ---- POST /products — founder/admin ----
router.post('/', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid product.' });
  const d = parsed.data;
  const result = await pool.query(
    `INSERT INTO products (name, description, category, version, status, required_plan_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [d.name, d.description, d.category, d.version, d.status, d.requiredPlanId || null, req.user.id]
  );
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Product created', detail: d.name });
  res.status(201).json({ product: result.rows[0] });
});

// ---- PATCH /products/:id — founder/admin ----
router.patch('/:id', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid update.' });
  const existing = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Product not found.' });
  const d = { ...existing.rows[0], ...parsed.data };
  const result = await pool.query(
    `UPDATE products SET name=$1, description=$2, category=$3, version=$4, status=$5,
     required_plan_id=$6, updated_at=now() WHERE id=$7 RETURNING *`,
    [d.name, d.description, d.category, d.version, d.status, d.required_plan_id, req.params.id]
  );
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Product updated', detail: d.name });
  res.json({ product: result.rows[0] });
});

// ---- DELETE /products/:id — founder/admin ----
router.delete('/:id', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  const existing = await pool.query('SELECT name FROM products WHERE id = $1', [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Product not found.' });
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  await logAudit({
    actorId: req.user.id,
    actorName: req.user.email,
    action: 'Product removed',
    detail: existing.rows[0].name,
  });
  res.json({ ok: true });
});

export default router;
