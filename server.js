import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.endsWith('.vercel.app') || origin.endsWith('.railway.app')) {
      return callback(null, true);
    }
    if (origin.includes('localhost')) return callback(null, true);
    callback(null, true); // Allow all origins for now
  },
  exposedHeaders: ['X-Original-Size', 'X-Compressed-Size', 'X-Compression-Ratio'],
}));

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'kss-pdf-compress-api' });
});

// Detect image format from bytes magic numbers
function detectImageFormat(bytes) {
  if (!bytes || bytes.length < 4) return null;
  
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  
  // GIF: 47 49 46
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  
  // TIFF: 49 49 or 4D 4D
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4D && bytes[1] === 0x4D)) return 'tiff';
  
  // WebP: 52 49 46 46
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
  
  return null;
}

// Build a proper image buffer from PDF image stream + metadata
function buildImageBuffer(bytes, dict, pdfDoc) {
  const format = detectImageFormat(bytes);
  
  // If we can detect a known format, use it directly
  if (format) return { buffer: Buffer.from(bytes), format };
  
  // Otherwise treat as raw pixel data and construct metadata from PDF dict
  try {
    const widthObj = dict.get(PDFName.of('Width'));
    const heightObj = dict.get(PDFName.of('Height'));
    const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
    const csObj = dict.get(PDFName.of('ColorSpace'));

    const width = widthObj?.numberValue ?? widthObj?.asNumber?.() ?? 0;
    const height = heightObj?.numberValue ?? heightObj?.asNumber?.() ?? 0;
    const bpc = bpcObj?.numberValue ?? bpcObj?.asNumber?.() ?? 8;
    
    if (!width || !height) return null;

    // Determine channels from ColorSpace
    let channels = 3; // default RGB
    if (csObj) {
      const cs = csObj.toString();
      if (cs.includes('Gray') || cs.includes('grey')) channels = 1;
      else if (cs.includes('CMYK')) channels = 4;
      else if (cs.includes('RGB')) channels = 3;
    }

    // Validate byte length matches expected raw pixel data
    const expectedBytes = width * height * channels * (bpc / 8);
    if (Math.abs(bytes.length - expectedBytes) < expectedBytes * 0.1) {
      // Looks like raw pixel data — wrap it with sharp's raw input
      return {
        buffer: Buffer.from(bytes),
        format: 'raw',
        raw: { width, height, channels }
      };
    }
  } catch {
    // ignore
  }
  
  return null;
}

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
    let imagesSkipped = 0;

    for (const [, obj] of objects) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;

      try {
        const widthObj = dict.get(PDFName.of('Width'));
        const heightObj = dict.get(PDFName.of('Height'));
        const width = widthObj?.numberValue ?? widthObj?.asNumber?.() ?? 0;
        const height = heightObj?.numberValue ?? heightObj?.asNumber?.() ?? 0;

        // Skip tiny images
        if (width < 50 || height < 50) continue;

        const imageInfo = buildImageBuffer(obj.contents, dict, pdfDoc);
        if (!imageInfo) { imagesSkipped++; continue; }

        let sharpImg;
        if (imageInfo.format === 'raw' && imageInfo.raw) {
          // Raw pixel data — tell Sharp the exact format
          sharpImg = sharp(imageInfo.buffer, {
            raw: {
              width: imageInfo.raw.width,
              height: imageInfo.raw.height,
              channels: imageInfo.raw.channels,
            },
            failOnError: false,
          });
        } else {
          // Known format (JPEG, PNG, etc.)
          sharpImg = sharp(imageInfo.buffer, { failOnError: false });
        }

        const meta = await sharpImg.metadata().catch(() => null);
        if (!meta?.width || !meta?.height) { imagesSkipped++; continue; }

        // Resize if needed
        if (settings.scale < 1.0) {
          const newWidth = Math.max(1, Math.floor(meta.width * settings.scale));
          sharpImg = sharpImg.resize(newWidth, null, { kernel: sharp.kernel.lanczos3 });
        }

        // Recompress as JPEG
        const compressed = await sharpImg
          .jpeg({ quality: settings.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
          .toBuffer();

        // Only replace if smaller
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
      } catch (imgErr) {
        imagesSkipped++;
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

    console.log(`[compress] Done. Processed: ${imagesProcessed} | Skipped: ${imagesSkipped} | ${(originalSize/1024/1024).toFixed(2)}MB → ${(compressedSize/1024/1024).toFixed(2)}MB | ${ratio}% reduction`);

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
