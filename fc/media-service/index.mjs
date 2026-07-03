/**
 * 阿里云 FC 媒体处理服务 (Node.js 20 runtime - Event handler)
 * 
 * Routes:
 *   POST /sign-upload   — 生成 OSS 上传签名 URL
 *   POST /sign-download  — 生成 OSS 下载签名 URL
 *   POST /batch-sign     — 批量签名
 */

import crypto from 'crypto';

const BUCKET = process.env.OSS_BUCKET || 'pubhtml-files';
const REGION = process.env.OSS_REGION || 'oss-cn-hangzhou';
const AK_ID = process.env.OSS_ACCESS_KEY_ID;
const AK_SECRET = process.env.OSS_ACCESS_KEY_SECRET;

// --- OSS V1 签名 (兼容性更好) ---

function generatePresignedUrl(method, objectKey, expiresSeconds = 900) {
  const host = `${BUCKET}.${REGION}.aliyuncs.com`;
  const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  
  const stringToSign = `${method}\n\n\n${expires}\n/${BUCKET}/${objectKey}`;
  const signature = crypto.createHmac('sha1', AK_SECRET).update(stringToSign).digest('base64');
  
  const params = new URLSearchParams({
    OSSAccessKeyId: AK_ID,
    Expires: String(expires),
    Signature: signature
  });
  
  return `https://${host}/${encodedKey}?${params.toString()}`;
}

// --- CORS ---
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// --- Handler (FC Event format) ---
export async function handler(event, context) {
  let req;
  try {
    req = typeof event === 'string' ? JSON.parse(event) : 
          event instanceof Buffer ? JSON.parse(event.toString()) : event;
  } catch {
    req = {};
  }

  const method = req.httpMethod || req.method || req.requestContext?.http?.method || 'POST';
  // FC HTTP trigger puts path in multiple possible locations
  const path = req.rawPath || req.path || req.requestURI || 
               req.requestContext?.http?.path || req.headers?.['x-fc-request-url'] || '/';
  const origin = (req.headers || {})['origin'] || (req.headers || {})['Origin'] || '*';

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  let body;
  try {
    const rawBody = req.body || '{}';
    // FC may base64 encode the body
    if (req.isBase64Encoded && typeof rawBody === 'string') {
      body = JSON.parse(Buffer.from(rawBody, 'base64').toString());
    } else {
      body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    }
  } catch {
    body = {};
  }

  const respond = (code, data) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    body: JSON.stringify(data),
  });

  // --- Route: POST /sign-upload ---
  if (path.includes('sign-upload')) {
    const { fileName, contentType, sessionId, mediaType } = body;
    if (!fileName || !contentType) {
      return respond(400, { error: 'fileName and contentType required' });
    }
    
    const ts = Date.now();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
    const prefix = sessionId ? `gym-media/${sessionId}` : 'gym-media/unsorted';
    const subDir = mediaType || 'misc';
    const objectKey = `${prefix}/${subDir}/${ts}_${safeFileName}`;
    
    const uploadUrl = generatePresignedUrl('PUT', objectKey, 900);
    const accessUrl = `https://${BUCKET}.${REGION}.aliyuncs.com/${objectKey}`;
    
    return respond(200, { uploadUrl, objectKey, accessUrl, expiresIn: 900 });
  }

  // --- Route: POST /sign-download ---
  if (path.includes('sign-download')) {
    const { objectKey, expiresIn } = body;
    if (!objectKey) return respond(400, { error: 'objectKey required' });
    
    const downloadUrl = generatePresignedUrl('GET', objectKey, expiresIn || 3600);
    return respond(200, { downloadUrl, expiresIn: expiresIn || 3600 });
  }

  // --- Route: POST /batch-sign ---
  if (path.includes('batch-sign')) {
    const { keys, expiresIn } = body;
    if (!Array.isArray(keys) || keys.length === 0) {
      return respond(400, { error: 'keys array required' });
    }
    const urls = keys.map(key => ({
      objectKey: key,
      url: generatePresignedUrl('GET', key, expiresIn || 3600)
    }));
    return respond(200, { urls });
  }

  // --- Route: POST /dp-sync — Proxy to DP (digpotency) API ---
  if (path.includes('dp-sync')) {
    const { token, shop_id, page, page_size, date } = body;
    if (!token) return respond(400, { error: 'token required' });

    const params = new URLSearchParams({
      shop_id: String(shop_id || 55),
      page: String(page || 1),
      page_size: String(page_size || 50),
    });
    if (date) params.set('date', date);

    try {
      const { default: https } = await import('https');
      const dpData = await new Promise((resolve, reject) => {
        const url = `https://www.digpotency.com/api/train/myTrainRecord?${params.toString()}`;
        const reqOpts = {
          headers: { 'token': token, 'Accept': 'application/json', 'Accept-Encoding': 'identity' },
        };
        https.get(url, reqOpts, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 200))); }
          });
        }).on('error', reject);
      });
      return respond(200, dpData);
    } catch (err) {
      return respond(502, { error: 'DP API proxy failed', message: err.message });
    }
  }

  // --- Route: GET / (health check) ---
  if (method === 'GET' || path === '/' || path === '') {
    return respond(200, { 
      status: 'ok', 
      service: 'gym-media-service',
      routes: ['/sign-upload', '/sign-download', '/batch-sign', '/dp-sync'],
      debug: { path, method, hasBody: !!req.body }
    });
  }

  return respond(404, { error: `Unknown path: ${path}`, debug: { rawPath: req.rawPath, path: req.path, uri: req.requestURI } });
}
