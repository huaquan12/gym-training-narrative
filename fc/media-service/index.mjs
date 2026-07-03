/**
 * 阿里云 FC 媒体处理服务
 * 
 * 功能：
 * 1. POST /sign-upload   — 生成 OSS 上传签名 URL
 * 2. POST /sign-download  — 生成 OSS 下载签名 URL（支持缩略图）
 * 3. POST /process-media  — 触发媒体后处理（缩略图、OCR placeholder）
 * 
 * 环境变量：
 *   OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET
 *   OSS_BUCKET=pubhtml-files
 *   OSS_REGION=oss-cn-hangzhou
 *   ALLOWED_ORIGINS=https://pub.cuige.xin,https://gym.cuige.xin
 */

import crypto from 'crypto';

const BUCKET = process.env.OSS_BUCKET || 'pubhtml-files';
const REGION = process.env.OSS_REGION || 'oss-cn-hangzhou';
const AK_ID = process.env.OSS_ACCESS_KEY_ID;
const AK_SECRET = process.env.OSS_ACCESS_KEY_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// --- OSS 签名工具 ---

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmacSha256(`aliyun_v4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aliyun_v4_request');
  return kSigning;
}

/**
 * 生成 OSS V4 签名的预签名 PUT URL
 */
function generatePresignedPutUrl(objectKey, contentType, expiresSeconds = 900) {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const regionId = REGION.replace('oss-', '');
  
  const host = `${BUCKET}.${REGION}.aliyuncs.com`;
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  
  const credential = `${AK_ID}/${dateStamp}/${regionId}/oss/aliyun_v4_request`;
  
  const queryParams = new URLSearchParams({
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
    'x-oss-credential': credential,
    'x-oss-date': amzDate,
    'x-oss-expires': String(expiresSeconds),
    'x-oss-additional-headers': '',
  });
  queryParams.sort();
  
  const canonicalRequest = [
    'PUT',
    `/${encodedKey}`,
    queryParams.toString(),
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n');
  
  const hashedRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const scope = `${dateStamp}/${regionId}/oss/aliyun_v4_request`;
  const stringToSign = `OSS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hashedRequest}`;
  
  const signingKey = getSignatureKey(AK_SECRET, dateStamp, regionId, 'oss');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');
  
  queryParams.set('x-oss-signature', signature);
  
  return `https://${host}/${encodedKey}?${queryParams.toString()}`;
}

/**
 * 生成 OSS 签名的 GET URL
 */
function generatePresignedGetUrl(objectKey, expiresSeconds = 3600) {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const regionId = REGION.replace('oss-', '');
  
  const host = `${BUCKET}.${REGION}.aliyuncs.com`;
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  
  const credential = `${AK_ID}/${dateStamp}/${regionId}/oss/aliyun_v4_request`;
  
  const queryParams = new URLSearchParams({
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
    'x-oss-credential': credential,
    'x-oss-date': amzDate,
    'x-oss-expires': String(expiresSeconds),
    'x-oss-additional-headers': '',
  });
  queryParams.sort();
  
  const canonicalRequest = [
    'GET',
    `/${encodedKey}`,
    queryParams.toString(),
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n');
  
  const hashedRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const scope = `${dateStamp}/${regionId}/oss/aliyun_v4_request`;
  const stringToSign = `OSS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hashedRequest}`;
  
  const signingKey = getSignatureKey(AK_SECRET, dateStamp, regionId, 'oss');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');
  
  queryParams.set('x-oss-signature', signature);
  
  return `https://${host}/${encodedKey}?${queryParams.toString()}`;
}

// --- CORS ---

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    body: JSON.stringify(body),
  };
}

// --- Handler ---

export async function handler(event, context) {
  const req = JSON.parse(event.toString());
  const method = req.httpMethod || req.method || 'POST';
  const path = req.path || req.requestURI || '/';
  const origin = (req.headers || {})['origin'] || (req.headers || {})['Origin'] || '';
  
  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
  }

  // --- POST /sign-upload ---
  if (path.endsWith('/sign-upload')) {
    const { fileName, contentType, sessionId, mediaType, exerciseName } = body;
    if (!fileName || !contentType) {
      return jsonResponse(400, { error: 'fileName and contentType required' }, origin);
    }
    
    // 构建 OSS 路径: gym-media/{sessionId}/{mediaType}/{timestamp}_{fileName}
    const ts = Date.now();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
    const prefix = sessionId ? `gym-media/${sessionId}` : 'gym-media/unsorted';
    const subDir = mediaType || 'misc';
    const objectKey = `${prefix}/${subDir}/${ts}_${safeFileName}`;
    
    const uploadUrl = generatePresignedPutUrl(objectKey, contentType);
    const accessUrl = `https://${BUCKET}.${REGION}.aliyuncs.com/${objectKey}`;
    
    return jsonResponse(200, {
      uploadUrl,
      objectKey,
      accessUrl,
      expiresIn: 900,
      meta: { sessionId, mediaType, exerciseName, fileName: safeFileName }
    }, origin);
  }

  // --- POST /sign-download ---
  if (path.endsWith('/sign-download')) {
    const { objectKey, expiresIn } = body;
    if (!objectKey) {
      return jsonResponse(400, { error: 'objectKey required' }, origin);
    }
    
    const downloadUrl = generatePresignedGetUrl(objectKey, expiresIn || 3600);
    return jsonResponse(200, { downloadUrl, expiresIn: expiresIn || 3600 }, origin);
  }

  // --- POST /batch-sign ---
  if (path.endsWith('/batch-sign')) {
    const { keys, expiresIn } = body;
    if (!Array.isArray(keys) || keys.length === 0) {
      return jsonResponse(400, { error: 'keys array required' }, origin);
    }
    
    const urls = keys.map(key => ({
      objectKey: key,
      url: generatePresignedGetUrl(key, expiresIn || 3600)
    }));
    
    return jsonResponse(200, { urls }, origin);
  }

  return jsonResponse(404, { error: `Unknown path: ${path}` }, origin);
}
