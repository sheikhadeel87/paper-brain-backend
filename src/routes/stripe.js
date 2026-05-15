import express from 'express';
import Stripe from 'stripe';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/requireAuth.js';
import { User } from '../models/User.js';

const router = express.Router();

const PRO_PRICE_ID = (
  process.env.STRIPE_PRO_PRICE_ID ||
  process.env.STRIPE_PRICE_ID ||
  process.env.STRIPE_PRICE_PRO_MONTHLY ||
  ''
).trim();
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
let stripeClient = null;

function stripe() {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function appUrlFromRequest(req) {
  const configured =
    process.env.APP_URL ||
    process.env.CLIENT_URL ||
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    '';
  if (configured.trim()) return configured.replace(/\/+$/, '').trim();

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) return origin.replace(/\/+$/, '');

  return 'http://localhost:5173';
}

function requireStripeConfig(res, { needsPrice = false, needsWebhook = false } = {}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ success: false, error: 'Stripe secret key is not configured.' });
    return false;
  }
  if (needsPrice && !PRO_PRICE_ID) {
    res.status(500).json({ success: false, error: 'Stripe Pro price ID is not configured.' });
    return false;
  }
  if (needsWebhook && !WEBHOOK_SECRET) {
    res.status(500).json({ success: false, error: 'Stripe webhook secret is not configured.' });
    return false;
  }
  return true;
}

async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe().customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: String(user._id) },
  });

  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

function subscriptionUserFilter(subscription, overrideUserId = '') {
  const filters = [];
  const userId = overrideUserId || subscription.metadata?.userId || '';
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id || '';

  if (mongoose.Types.ObjectId.isValid(userId)) filters.push({ _id: userId });
  if (customerId) filters.push({ stripeCustomerId: customerId });

  return filters.length > 0 ? { $or: filters } : null;
}

/** Basil+ API: `current_period_end` is on subscription items, not the root subscription. */
function subscriptionPeriodEndUnix(subscription) {
  if (typeof subscription?.current_period_end === 'number') {
    return subscription.current_period_end;
  }
  const items = subscription?.items?.data;
  if (!Array.isArray(items)) return null;
  let maxEnd = null;
  for (const item of items) {
    const end = item?.current_period_end;
    if (typeof end === 'number' && (maxEnd === null || end > maxEnd)) {
      maxEnd = end;
    }
  }
  return maxEnd;
}

function subscriptionPeriodEndDate(subscription) {
  const unix = subscriptionPeriodEndUnix(subscription);
  return unix ? new Date(unix * 1000) : null;
}

async function retrieveSubscription(subscriptionId) {
  return stripe().subscriptions.retrieve(subscriptionId, {
    expand: ['items.data'],
  });
}

async function syncSubscription(subscription, { userId = '', customerId = '' } = {}) {
  const resolvedUserId = userId || subscription.metadata?.userId || '';
  const resolvedCustomerId =
    customerId ||
    (typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id || '');

  const filter = subscriptionUserFilter(
    {
      ...subscription,
      customer: resolvedCustomerId || subscription.customer,
    },
    resolvedUserId,
  );

  if (!filter) {
    console.error('[stripe:sync] no user filter', {
      userId: resolvedUserId,
      customerId: resolvedCustomerId,
      subscriptionId: subscription.id,
    });
    return null;
  }

  const status = subscription.status || 'unknown';
  const isPaid = status === 'active' || status === 'trialing';
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);

  const updated = await User.findOneAndUpdate(
    filter,
    {
      $set: {
        plan: isPaid ? 'pro' : 'free',
        stripeCustomerId: resolvedCustomerId,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: status,
        subscriptionCurrentPeriodEnd: subscriptionPeriodEndDate(subscription),
        subscriptionCancelAtPeriodEnd: isPaid && cancelAtPeriodEnd,
      },
    },
    { new: true },
  );

  if (!updated) {
    console.error('[stripe:sync] no user matched', filter);
    return null;
  }

  console.log('[stripe:sync] updated user', {
    userId: String(updated._id),
    plan: updated.plan,
    subscriptionStatus: updated.subscriptionStatus,
    stripeSubscriptionId: updated.stripeSubscriptionId,
    subscriptionCurrentPeriodEnd: updated.subscriptionCurrentPeriodEnd,
  });
  return updated;
}

/** Backfill period end for users synced before Basil API item-level periods. */
export async function repairUserSubscriptionPeriodEnd(userId) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const user = await User.findById(userId).select(
    'stripeSubscriptionId stripeCustomerId plan subscriptionCurrentPeriodEnd',
  );
  if (!user?.stripeSubscriptionId) return null;
  if (user.subscriptionCurrentPeriodEnd) return user;

  try {
    const subscription = await retrieveSubscription(user.stripeSubscriptionId);
    return syncSubscription(subscription, {
      userId: String(user._id),
      customerId: user.stripeCustomerId || '',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe:repair] period end backfill failed:', message);
    return null;
  }
}

router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    if (!requireStripeConfig(res, { needsPrice: true })) return;

    const user = await User.findById(req.auth.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const customerId = await ensureStripeCustomer(user);
    const appUrl = appUrlFromRequest(req);

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(user._id),
      line_items: [{ price: PRO_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/?checkout=cancelled#pricing`,
      metadata: {
        userId: String(user._id),
        plan: 'pro',
      },
      subscription_data: {
        metadata: {
          userId: String(user._id),
          plan: 'pro',
        },
      },
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    return next(err);
  }
});

router.post('/portal', requireAuth, async (req, res, next) => {
  try {
    if (!requireStripeConfig(res)) return;

    const user = await User.findById(req.auth.userId).select('stripeCustomerId');
    if (!user?.stripeCustomerId) {
      return res.status(404).json({
        success: false,
        error: 'No billing account exists for this user yet.',
      });
    }

    const session = await stripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${appUrlFromRequest(req)}/dashboard?billing=1`,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    return next(err);
  }
});

router.post('/webhook', async (req, res) => {
  if (!requireStripeConfig(res, { needsWebhook: true })) return;

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing Stripe signature.');
  }

  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, signature, WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid webhook payload.';
    console.error('[stripe:webhook] signature verification failed:', message);
    return res.status(400).send(`Webhook Error: ${message}`);
  }

  try {
    console.log('[stripe:webhook] event', event.type, event.id);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const sessionUserId =
        session.metadata?.userId || session.client_reference_id || '';
      const sessionCustomerId =
        typeof session.customer === 'string' ? session.customer : session.customer?.id || '';

      console.log('[stripe:webhook] checkout.session.completed', {
        sessionId: session.id,
        metadata: session.metadata,
        userId: sessionUserId,
        customerId: sessionCustomerId,
      });

      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id || '';

      if (!subscriptionId) {
        console.warn('[stripe:webhook] checkout completed without subscription id', session.id);
      } else {
        const subscription = await retrieveSubscription(subscriptionId);
        await syncSubscription(subscription, {
          userId: sessionUserId,
          customerId: sessionCustomerId,
        });
      }
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const subscription = event.data.object;
      console.log('[stripe:webhook] subscription event', {
        type: event.type,
        subscriptionId: subscription.id,
        metadata: subscription.metadata,
        status: subscription.status,
      });
      await syncSubscription(subscription);
    }

    return res.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook processing failed.';
    console.error('[stripe:webhook]', message);
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;
