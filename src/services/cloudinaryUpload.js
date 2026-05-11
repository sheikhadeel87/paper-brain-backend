import { v2 as cloudinary } from 'cloudinary';

function configureFromEnv() {
  if (String(process.env.CLOUDINARY_URL || '').trim()) {
    cloudinary.config();
    return true;
  }
  const name = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const key = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const secret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (name && key && secret) {
    cloudinary.config({ cloud_name: name, api_key: key, api_secret: secret });
    return true;
  }
  return false;
}

export function isCloudinaryConfigured() {
  return (
    Boolean(String(process.env.CLOUDINARY_URL || '').trim()) ||
    (Boolean(String(process.env.CLOUDINARY_CLOUD_NAME || '').trim()) &&
      Boolean(String(process.env.CLOUDINARY_API_KEY || '').trim()) &&
      Boolean(String(process.env.CLOUDINARY_API_SECRET || '').trim()))
  );
}

/**
 * @param {Buffer} buffer
 * @param {{ userId: string, originalFilename?: string }} meta
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export async function uploadReceiptImageBuffer(buffer, meta) {
  if (!configureFromEnv()) {
    throw new Error('Cloudinary is not configured (CLOUDINARY_URL or CLOUDINARY_*).');
  }
  const userId = String(meta?.userId || 'unknown').replace(/[^\w-]/g, '').slice(0, 64);
  const safeName = String(meta?.originalFilename || 'receipt')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 80);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `paper-brain/receipts/${userId}`,
        resource_type: 'image',
        use_filename: true,
        filename_override: safeName || 'receipt',
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        if (!result?.secure_url || !result.public_id) {
          reject(new Error('Cloudinary upload returned no URL.'));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}
