const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_CRF = 30;
const MIN_CRF = 0;
const MAX_CRF = 63;
const ALLOWED_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "image/gif"]);
const RESOLUTION_WIDTH_MAP = {
  "1080p": 1920,
  "720p": 1280,
  "480p": 854,
  "360p": 640,
};

app.use(cors());
app.use(express.json());

const createError = (code, message, details) => {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
};

const formatErrorDetails = (error) => {
  if (error == null) return null;

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    field: error.field,
  };
};

const cleanupFile = (filePath) => {
  if (filePath == null) return;
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

const parseCrf = (value) => {
  if (value == null || String(value).trim() === "") {
    return DEFAULT_CRF;
  }

  const parsedValue = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsedValue) || parsedValue < MIN_CRF || parsedValue > MAX_CRF) {
    throw createError(
      "validation.invalid_crf",
      "crf 값은 " + MIN_CRF + "부터 " + MAX_CRF + " 사이 숫자여야 합니다.",
      { received: value },
    );
  }

  return parsedValue;
};

const parseResolution = (value) => {
  if (value == null || String(value).trim() === "") {
    return null;
  }

  const normalizedValue = String(value).trim().toLowerCase();
  if (Object.hasOwn(RESOLUTION_WIDTH_MAP, normalizedValue) === false) {
    throw createError("validation.invalid_resolution", "해상도 값이 올바르지 않습니다.", {
      received: value,
      allowed: Object.keys(RESOLUTION_WIDTH_MAP),
    });
  }

  return normalizedValue;
};

const buildOutputOptions = ({ crf, resolution }) => {
  const options = [
    "-c:v libvpx-vp9",
    "-crf " + crf,
    "-b:v 0",
    "-deadline realtime",
    "-cpu-used 4",
  ];

  if (resolution != null) {
    const targetWidth = RESOLUTION_WIDTH_MAP[resolution];
    options.push("-vf scale='min(" + targetWidth + ",iw)':-2");
  }

  return options;
};

const upload = multer({
  dest: "/tmp/",
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype) === false) {
      callback(createError("upload.invalid_type", "허용되지 않는 파일 형식입니다.", {
        mimetype: file.mimetype,
        originalname: file.originalname,
      }));
      return;
    }

    callback(null, true);
  },
});

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/convert", (req, res, next) => {
  upload.single("video")(req, res, (error) => {
    if (error == null) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "25MB 이하 파일만 올릴 수 있습니다."
        : "허용되지 않는 파일 형식입니다.";

      res.status(400).json({
        success: false,
        code: "upload." + error.code.toLowerCase(),
        message,
        details: formatErrorDetails(error),
      });
      return;
    }

    if (error.code === "upload.invalid_type") {
      res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
        details: error.details ?? formatErrorDetails(error),
      });
      return;
    }

    next(error);
  });
}, async (req, res, next) => {
  const file = req.file;

  if (file == null) {
    res.status(400).json({
      success: false,
      code: "upload.missing_file",
      message: "video 파일이 전송되지 않았습니다.",
    });
    return;
  }

  const inputPath = file.path;
  const outputFileName = "conv_" + Date.now() + ".webm";
  const outputPath = path.join("/tmp", outputFileName);
  const objectKey = "outputs/" + outputFileName;

  try {
    const sourceName = typeof req.body.sourceName === "string" && req.body.sourceName.trim() !== ""
      ? req.body.sourceName.trim()
      : file.originalname;
    const crf = parseCrf(req.body.crf);
    const resolution = parseResolution(req.body.resolution);
    const outputOptions = buildOutputOptions({ crf, resolution });

    console.log("[시작] 변환 처리:", {
      sourceName,
      mimetype: file.mimetype,
      size: file.size,
      crf,
      resolution,
    });

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(outputOptions)
        .toFormat("webm")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    const fileContent = fs.readFileSync(outputPath);

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: fileContent,
      ContentType: "video/webm",
    }));

    const finalUrl = String(process.env.R2_PUBLIC_URL || "").replace(/\/$/, "") + "/" + objectKey;
    res.json({ success: true, url: finalUrl, objectKey });
  } catch (error) {
    if (error != null && typeof error.code === "string" && error.code.startsWith("validation.")) {
      res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
        details: error.details ?? formatErrorDetails(error),
      });
      return;
    }

    next(createError("conversion.failed", "파일 변환 또는 저장 중 문제가 발생했습니다.", error != null && error.details ? error.details : formatErrorDetails(error)));
  } finally {
    cleanupFile(inputPath);
    cleanupFile(outputPath);
  }
});

app.use((error, _req, res, _next) => {
  console.error("[오류] 처리 실패:", error);

  res.status(500).json({
    success: false,
    code: error.code || "server.internal_error",
    message: error.message || "서버에서 요청을 처리하지 못했습니다.",
    details: error.details ?? formatErrorDetails(error),
  });
});

app.listen(PORT, () => {
  console.log("서버가 포트 " + PORT + "에서 실행 중입니다.");
});
