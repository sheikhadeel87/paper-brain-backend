import mongoose from 'mongoose';

/**
 * Reuses one Mongoose connection across Vercel serverless invocations (see global) and
 * local monolith. Prevents "buffering timed out" when DB is never connected on cold start.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { promise: null };
}

function getMongoUri() {
  return (
    (typeof process.env.MONGO_URI === 'string' && process.env.MONGO_URI.trim()) ||
    'mongodb://127.0.0.1:27017/paper-brain'
  );
}

export function getMongoUriForLogs() {
  return getMongoUri();
}

/**
 * Await this before any route that uses Mongoose. Safe to call repeatedly.
 */
export async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (cached.promise) {
    await cached.promise;
    return mongoose.connection;
  }

  if (!String(process.env.MONGO_URI || '').trim()) {
    console.warn(
      'MONGO_URI not set; using mongodb://127.0.0.1:27017/paper-brain in connectMongo().',
    );
  }

  const uri = getMongoUri();
  const opts = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 20_000,
  };
  cached.promise = mongoose.connect(uri, opts);
  try {
    await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
  return mongoose.connection;
}
