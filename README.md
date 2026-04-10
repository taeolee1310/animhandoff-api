# animhandoff-api

Render.com에 올려서 쓰는 초경량 FFmpeg 변환 API입니다.

## 엔드포인트
- `GET /health`
- `POST /api/convert`

## 요청 형식
`multipart/form-data`로 `file` 필드에 원본 파일을 넣어 보내면 됩니다.

## 응답 형식
성공 시 아래 형태로 응답합니다.

```json
{
  "success": true,
  "objectKey": "outputs/.../example.webm",
  "url": "https://pub-xxxx.r2.dev/outputs/.../example.webm"
}
```

## 로컬 실행
```bash
npm install
npm start
```

## Render 환경 변수
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_URL`
- `MAX_UPLOAD_MB`

## 메모
- 업로드된 원본 파일과 변환 결과 파일은 `/tmp`에 잠깐 저장됩니다.
- 업로드 성공/실패와 상관없이 마지막에 즉시 삭제됩니다.
