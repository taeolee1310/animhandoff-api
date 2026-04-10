const cors = require('cors');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const port = Number(process.env.PORT || 3001);
const TMP_DIR = '/tmp';

const readEnv = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const requireEnv = (...names) => {
  const value = readEnv(...names);
  if (!value) {
    throw new Error(`Missing required environment variable: ${names.join(' or ')}`);
  }
  return value;
};

const sanitizeBaseName = (fileName) => {
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  const normalized = baseName.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalized.replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'converted-file';
};

const safeUnlink = (filePath) => {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn('[cleanup] failed:', filePath, error.message);
  }
};

const createR2Client = () => {
  return new S3Client({
    region: readEnv('R2_REGION', 'OBJECT_STORAGE_REGION') || 'auto',
    endpoint: requireEnv('R2_ENDPOINT', 'OBJECT_STORAGE_ENDPOINT'),
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID', 'OBJECT_STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: (readEnv('R2_FORCE_PATH_STYLE', 'OBJECT_STORAGE_FORCE_PATH_STYLE') || 'false') === 'true',
  });
};

const buildPublicUrl = (objectKey) => {
  const baseUrl = requireEnv('R2_PUBLIC_URL', 'OBJECT_STORAGE_PUBLIC_BASE_URL').replace(/\/+$/, '');
  return `${baseUrl}/${objectKey.replace(/^\/+/, '')}`;
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: {
    fileSize: Number(readEnv('MAX_UPLOAD_MB') || '25') * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/convert', upload.single('file'), async (req, res) => {
  const inputPath = req.file ? req.file.path : null;
  let outputPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: '업로드된 파일이 없습니다.' });
    }

    const baseName = sanitizeBaseName(req.file.originalname || 'input');
    const outputName = `${baseName}-${Date.now()}.webm`;
    outputPath = path.join(TMP_DIR, outputName);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libvpx-vp9',
          '-crf 30',
          '-b:v 0',
          '-deadline realtime',
          '-cpu-used 4',
        ])
        .format('webm')
        .on('start', (command) => {
          console.log('[ffmpeg] start:', command);
        })
        .on('progress', (progress) => {
          console.log('[ffmpeg] progress:', progress.percent || 0);
        })
        .on('stderr', (line) => {
          console.log('[ffmpeg] stderr:', line);
        })
        .on('error', (error) => {
          reject(error);
        })
        .on('end', () => {
          resolve();
        })
        .save(outputPath);
    });

    const objectKey = `outputs/${Date.now()}-${crypto.randomUUID()}-${outputName}`;
    const bucket = requireEnv('R2_BUCKET_NAME', 'OBJECT_STORAGE_BUCKET');
    const client = createR2Client();

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fs.createReadStream(outputPath),
      ContentType: 'video/webm',
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    return res.json({
      success: true,
      objectKey,
      url: buildPublicUrl(objectKey),
    });
  } catch (error) {
    console.error('[convert] failed:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : '변환 또는 업로드에 실패했습니다.',
    });
  } finally {
    safeUnlink(inputPath);
    safeUnlink(outputPath);
  }
});

app.listen(port, () => {
  console.log(`animhandoff-api listening on port ${port}`);
});
