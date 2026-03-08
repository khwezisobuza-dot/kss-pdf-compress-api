import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

const app = express();
const PORT = process.env.PORT || 3001;

// Allow requests from your Vercel frontend
const allowedOrigins = [
  'https://kss-pdf-studio.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o.replace('https://', '').replace('http://', '')))) {
      return callback(null, true);
    }
    // Also allow any vercel.app subdomain for preview deployments
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  exposedHeaders: ['X-Original-Size', 'X-Compressed-Size', 'X-Compression-Ratio'],
}));

app.use(express.json());

// Multer — store in memory, 200MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'kss-pdf-compress-api' });
});

// Compress endpoint
app.post('/compress', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const level = req.body.level || 'medium';
  const originalSize = req.file.size;

  console.log(`[compress] ${req.file.originalname} | ${(originalSize / 1024 / 1024).toFixed(2)}MB | level: ${level}`);

  const settings = {
    low:     { quality: 85, scale: 1.0 },
    medium:  { quality: 50, scale: 0.65 },
    extreme: { quality: 25, scale: 0.35 },
  }[level] ?? { quality: 50, scale: 0.65 };

  try {
    const pdfDoc = await PDFDocument.load(req.file.buffer, { ignoreEncryption: true });
    const objects = pdfDoc.context.enumerateIndirectObjects();
    let imagesProcessed = 0;

    for (const [, obj] of objects) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;

      try {
        // Get image dimensions
        const widthObj = dict.get(PDFName.of('Width'));
        const heightObj = dict.get(PDFName.of('Height'));
        const width = widthObj?.numberValue ?? widthObj?.asNumber?.() ?? 0;
        const height = heightObj?.numberValue ?? heightObj?.asNumber?.() ?? 0;

        // Skip tiny images
        if (width < 50 || height < 50) continue;

        // Try to process with Sharp
        let sharpImg = sharp(obj.contents, { failOnError: false });
        const meta = await sharpImg.metadata().catch(() => null);
        if (!meta?.width || !meta?.height) continue;

        // Resize if needed
        if (settings.scale < 1.0) {
          const newWidth = Math.max(1, Math.floor(meta.width * settings.scale));
          sharpImg = sharpImg.resize(newWidth, null, { kernel: sharp.kernel.lanczos3 });
        }

        // Recompress as JPEG
        const compressed = await sharpImg
          .jpeg({ quality: settings.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
          .toBuffer();

        // Only replace if it actually got smaller
        if (compressed.length < obj.contents.length) {
          const newMeta = await sharp(compressed).metadata();
          obj.contents = compressed;
          dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          dict.set(PDFName.of('Length'), pdfDoc.context.obj(compressed.length));
          dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          if (newMeta.width)  dict.set(PDFName.of('Width'),  pdfDoc.context.obj(newMeta.width));
          if (newMeta.height) dict.set(PDFName.of('Height'), pdfDoc.context.obj(newMeta.height));
          dict.set(PDFName.of('BitsPerComponent'), pdfDoc.context.obj(8));
          dict.delete(PDFName.of('SMask'));
          dict.delete(PDFName.of('Mask'));
          dict.delete(PDFName.of('DecodeParms'));
          imagesProcessed++;
        }
      } catch {
        continue;
      }
    }

    // Strip page metadata
    for (const index of pdfDoc.getPageIndices()) {
      const node = pdfDoc.getPage(index).node;
      if (node?.delete) {
        ['Thumb', 'PieceInfo', 'Metadata', 'StructParents', 'UserUnit']
          .forEach(k => { try { node.delete(PDFName.of(k)); } catch {} });
      }
    }

    try { pdfDoc.catalog.delete(PDFName.of('Metadata')); } catch {}
    try { pdfDoc.catalog.delete(PDFName.of('AcroForm')); } catch {}

    const compressedPdf = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });

    const compressedSize = compressedPdf.length;
    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`[compress] Done. Images: ${imagesProcessed} | ${(originalSize/1024/1024).toFixed(2)}MB → ${(compressedSize/1024/1024).toFixed(2)}MB | ${ratio}% reduction`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="compressed.pdf"`);
    res.setHeader('X-Original-Size', originalSize.toString());
    res.setHeader('X-Compressed-Size', compressedSize.toString());
    res.setHeader('X-Compression-Ratio', `${ratio}%`);
    res.send(Buffer.from(compressedPdf));

  } catch (err) {
    console.error('[compress] Error:', err?.message || err);
    res.status(500).json({ error: 'Compression failed. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`KSS PDF Compress API running on port ${PORT}`);
});
