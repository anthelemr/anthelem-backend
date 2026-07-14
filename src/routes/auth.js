import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { pool } from '../db.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  refreshTtlMs,
  requireAuth,
} from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { sendEmail } from '../lib/email.js';

const router = Router();

const signupSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---- POST /auth/signup ----
router.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid signup details.' });
  const { name, email, password } = parsed.data;

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const userCount = await client.query('SELECT COUNT(*)::int AS n FROM users');
    const isFirstUser = userCount.rows[0].n === 0;
    const role = isFirstUser ? 'founder' : 'customer';

    const passwordHash = await bcrypt.hash(password, 12);
    const freePlan = await client.query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");

    const result = await client.query(
      `INSERT INTO users (name, email, password_hash, role, plan_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, status, plan_id, created_at`,
      [name, email, passwordHash, role, freePlan.rows[0]?.id || null]
    );
    const user = result.rows[0];

    // Email verification token — send via sendEmail() once a provider is configured.
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '24 hours')`,
      [user.id, hashToken(verifyToken)]
    );
    await sendEmail({
      to: user.email,
      subject: 'Verify your ANTHEON account',
      text: `Verify your email: ${process.env.APP_BASE_URL}/verify-email?token=${verifyToken}`,
    });

    await logAudit({
      actorId: user.id,
      actorName: user.name,
      action: isFirstUser ? 'Founder account created' : 'Account created',
      detail: user.email,
    });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await client.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
      [user.id, hashToken(refreshToken), req.headers['user-agent'] || null, req.ip]
    );

    res.status(201).json({ user, accessToken, refreshToken });
  } finally {
    client.release();
  }
});

// ---- POST /auth/login ----
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials.' });
  const { email, password } = parsed.data;

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  // Constant-shape response whether or not the user exists, to avoid
  // leaking which emails are registered.
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended.' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await pool.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
    [user.id, hashToken(refreshToken), req.headers['user-agent'] || null, req.ip]
  );
  await logAudit({ actorId: user.id, actorName: user.name, action: 'Signed in', detail: user.email });

  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser, accessToken, refreshToken });
});

// ---- POST /auth/refresh ----
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(401).json({ error: 'Missing refresh token.' });
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: 'Refresh token invalid or expired.' });
  }
  const tokenHash = hashToken(refreshToken);
  const session = await pool.query(
    `SELECT * FROM sessions WHERE user_id = $1 AND refresh_token_hash = $2
     AND revoked_at IS NULL AND expires_at > now()`,
    [payload.sub, tokenHash]
  );
  if (session.rowCount === 0) return res.status(401).json({ error: 'Session no longer valid.' });

  const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
  const user = userResult.rows[0];
  if (!user || user.status === 'suspended') {
    return res.status(401).json({ error: 'Account unavailable.' });
  }
  const accessToken = signAccessToken(user);
  res.json({ accessToken });
});

// ---- POST /auth/logout ----
router.post('/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    await pool.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = $1 AND refresh_token_hash = $2`,
      [req.user.id, hashToken(refreshToken)]
    );
  }
  await logAudit({ actorId: req.user.id, actorName: req.user.email, action: 'Signed out' });
  res.json({ ok: true });
});

// ---- POST /auth/forgot-password ----
router.post('/forgot-password', async (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  // Always respond the same way regardless of whether the account exists.
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [user.id, hashToken(token)]
    );
    await sendEmail({
      to: email,
      subject: 'Reset your ANTHEON password',
      text: `Reset your password: ${process.env.APP_BASE_URL}/reset-password?token=${token}`,
    });
  }
  res.json({ message: 'If that account exists, a recovery link has been sent.' });
});

// ---- POST /auth/reset-password ----
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  const record = result.rows[0];
  if (!record) return res.status(400).json({ error: 'Reset link is invalid or has expired.' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
    passwordHash,
    record.user_id,
  ]);
  await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [record.id]);
  // Revoke all existing sessions on password reset.
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [record.user_id]);
  await logAudit({ actorId: record.user_id, action: 'Password reset via recovery link' });

  res.json({ message: 'Password updated. Please sign in again.' });
});

// ---- POST /auth/change-password — for a signed-in user who knows their current password ----
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = result.rows[0];
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
    passwordHash,
    user.id,
  ]);
  await logAudit({ actorId: user.id, actorName: user.name, action: 'Password changed', detail: user.email });
  res.json({ message: 'Password updated.' });
});

export default router;
