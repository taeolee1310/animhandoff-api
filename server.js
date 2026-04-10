const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// FFmpeg 경로 설정
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3001;

// 1. 미들웨어 설정
app.use(cors());
app.use(express.json());

// 2. Multer 설정 (임시 저장소 및 파일 필터)
const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB 제한
});

// 3. S3(R2) 클라이언트 설정
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * [POST] /api/convert
 * 비디오를 WebM으로 변환 후 R2에 업로드
 */
app.post('/api/convert', upload.single('video'), async (req, res) => {
  // 프론트엔드와 합의한 video 필드 하나만 받습니다.
  const file = req.file;
  
  if (!file) {
    return res.status(400).json({ success: false, message: '파일이 업로드되지 않았습니다.' });
  }

  const inputPath = file.path;
  const outputFileName = `conv_${Date.now()}.webm`;
  const outputPath = path.join('/tmp', outputFileName);

  console.log(`[시작] 변환 처리: ${file.originalname}`);

  try {
    // FFmpeg 변환 실행
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libvpx-vp9',
          '-crf 30',
          '-b:v 0',
          '-deadline realtime',
          '-cpu-used 4'
        ])
        .toFormat('webm')
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    // R2 업로드
    const fileContent = fs.readFileSync(outputPath);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `outputs/${outputFileName}`,
      Body: fileContent,
      ContentType: 'video/webm',
    }));

    const finalUrl = `${process.env.R2_PUBLIC_URL}/outputs/${outputFileName}`;
    res.json({ success: true, url: finalUrl });

  } catch (error) {
    console.error('[오류] 처리 실패:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // 임시 파일 삭제 (서버 용량 관리)
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
