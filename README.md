# KSS PDF Compress API

Standalone Express.js compression API for KSS PDF.
Runs on Railway. Uses Sharp + pdf-lib for server-side PDF image recompression.

## Endpoints

GET  /health     — Health check
POST /compress   — Compress a PDF (multipart/form-data: file, level)

## Environment Variables

None required. PORT is set automatically by Railway.

## Deploy

Push to GitHub, connect to Railway, deploy.
