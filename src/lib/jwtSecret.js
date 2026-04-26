const fromEnv = process.env.JWT_SECRET?.trim();

if (!fromEnv && process.env.NODE_ENV !== 'production') {
  console.warn(
    'JWT_SECRET is not set; using insecure development default.',
  );
}

/** Signing / verification secret. Set JWT_SECRET in production. */
export const JWT_SECRET = fromEnv || 'dev-only-change-in-production';
