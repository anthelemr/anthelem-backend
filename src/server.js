import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import productRoutes from './routes/products.js';
import planRoutes from './routes/plans.js';
import paymentRoutes, { stripeWebhookHandler } from './routes/payments.js';
import notificationRoutes from './routes/notifications.js';
import auditRoutes from './routes/audit.js';
import platformRoutes from './routes/platform.js';

const app = express();

app.set('trust proxy', 1); // needed for correct req.ip behind a load balancer/proxy

app.use(helmet());
const rawOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowAllOrigins = rawOrigins.length === 0 || rawOrigins.includes('*');
app.use(cors({ origin: allowAllOrigins ? true : rawOrigins }));

// Stripe requires the RAW body for signature verification, so this route
// is mounted BEFORE express.json() and given its own raw parser.
app.post('/payments/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json({ limit: '1mb' }));

// Broad rate limit as a baseline; auth routes get a tighter one below.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600 }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

app.get('/health', (req, res) => res.json({ ok: true, service: 'antheon-api' }));

app.use('/auth', authLimiter, authRoutes);
app.use('/users', userRoutes);
app.use('/products', productRoutes);
app.use('/plans', planRoutes);
app.use('/payments', paymentRoutes);
app.use('/notifications', notificationRoutes);
app.use('/audit', auditRoutes);
app.use('/platform', platformRoutes);

// Central error handler — never leak stack traces to clients.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`ANTHEON API listening on :${port}`);
});
