import { Router } from 'express';
import Stripe from 'stripe';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();
const stripeReady = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('replace_me');
const stripe = stripeReady ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ---- GET /payments — own history, or all for founder/admin ----
router.get('/', requireAuth, async (req, res) => {
  const isPriv = req.user.role === 'founder' || req.user.role === 'admin';
  const result = isPriv
    ? await pool.query('SELECT * FROM payments ORDER BY created_at DESC LIMIT 500')
    : await pool.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ payments: result.rows });
});

// ---- POST /payments/checkout-session ----
// Creates a real Stripe Checkout session for a paid plan. The client
// redirects the browser to session.url — card data never touches this
// server, which is what keeps PCI scope minimal.
router.post('/checkout-session', requireAuth, async (req, res) => {
  if (!stripeReady) {
    return res.status(503).json({
      error: 'Payments are not configured yet. Add a real STRIPE_SECRET_KEY to enable checkout.',
    });
  }
  const { planId } = req.body || {};
  const planResult = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
  const plan = planResult.rows[0];
  if (!plan || !plan.stripe_price_id) {
    return res.status(400).json({ error: 'This plan is not connected to a Stripe price yet.' });
  }

  const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, name: user.name });
    customerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: `${process.env.APP_BASE_URL}/subscriptions?checkout=success`,
    cancel_url: `${process.env.APP_BASE_URL}/subscriptions?checkout=cancelled`,
    metadata: { userId: user.id, planId: plan.id },
  });

  res.json({ url: session.url });
});

// ---- POST /payments/webhook ----
// Must be mounted with express.raw({type: 'application/json'}) in
// server.js — Stripe's signature check needs the exact raw request body.
export async function stripeWebhookHandler(req, res) {
  if (!stripeReady) return res.status(503).send('Stripe not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, planId } = session.metadata || {};
    if (userId && planId) {
      await pool.query('UPDATE users SET plan_id = $1, updated_at = now() WHERE id = $2', [planId, userId]);
      await pool.query(
        `INSERT INTO payments (user_id, amount_cents, currency, provider, provider_reference, status, memo)
         VALUES ($1, $2, $3, 'stripe', $4, 'succeeded', 'Subscription checkout')`,
        [userId, session.amount_total || 0, (session.currency || 'usd').toUpperCase(), session.id]
      );
      await pool.query(
        `INSERT INTO notifications (user_id, title, body) VALUES ($1, 'Payment received', 'Your subscription is now active.')`,
        [userId]
      );
      await logAudit({ actorId: userId, action: 'Payment succeeded (Stripe checkout)' });
    }
  }
  // Handle other event types as needed: invoice.payment_failed, customer.subscription.deleted, etc.
  // Each should update `payments` / `users.plan_id` accordingly, same pattern as above.

  res.json({ received: true });
}

// ---- GET /payments/providers — founder view of provider config state ----
router.get('/providers', requireAuth, requireRole('founder', 'admin'), async (req, res) => {
  res.json({
    providers: [
      { name: 'Stripe', connected: stripeReady },
      { name: 'Regional / local payment methods', connected: false },
    ],
  });
});

export default router;
