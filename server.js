import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: (origin, callback) => callback(null, true),
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

app.post('/compress', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const level = req.body.level || 'medium';
  const originalSize = req.file.size;

  console.log(`[compress] ${req.file.originalname} | ${(originalSize / 1024 / 1024).toFixed(2)}MB | level: ${level}`);

  const settings = {
    low:     { quality: 82, scale: 0.9 },
    medium:  { quality: 45, scale: 0.6 },
    extreme: { quality: 18, scale: 0.3 },
  }[level] ?? { quality: 45, scale: 0.6 };

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
        const width  = widthObj?.numberValue  ?? widthObj?.asNumber?.()  ?? 0;
        const height = heightObj?.numberValue ?? heightObj?.asNumber?.() ?? 0;
        if (width < 50 || height < 50) continue;

        const originalBytes = obj.contents;

        // Verify Sharp can read the image
        let sharpInput = sharp(Buffer.from(originalBytes), { failOnError: false });
        const meta = await sharpInput.metadata().catch(() => null);
        if (!meta?.width || !meta?.height) { imagesSkipped++; continue; }

        // Resize if needed
        if (settings.scale < 1.0) {
          const newWidth = Math.max(32, Math.floor(meta.width * settings.scale));
          sharpInput = sharpInput.resize(newWidth, null, {
            kernel: sharp.kernel.lanczos3,
            withoutEnlargement: true,
          });
        }

        // KEY FIX: Force full decode to raw RGB pixels first.
        // This breaks the JPEG->JPEG recompression cycle that caps savings at ~25%.
        // By decoding to raw first, we then re-encode from scratch at target quality.
        const rawPixels = await sharpInput
          .removeAlpha()
          .toColorspace('srgb')
          .raw()
          .toBuffer({ resolveWithObject: true });

        // Re-encode from raw pixels to JPEG at target quality
        const compressed = await sharp(rawPixels.data, {
          raw: {
            width:    rawPixels.info.width,
            height:   rawPixels.info.height,
            channels: rawPixels.info.channels,
          },
        })
          .jpeg({
            quality:             settings.quality,
            mozjpeg:             true,
            chromaSubsampling:   '4:2:0',
            trellisQuantisation: true,
            overshootDeringing:  true,
          })
          .toBuffer();

        // Only replace if it got smaller
        if (compressed.length < originalBytes.length) {
          const newMeta = await sharp(compressed).metadata();
          obj.contents = compressed;
          dict.set(PDFName.of('Filter'),           PDFName.of('DCTDecode'));
          dict.set(PDFName.of('Length'),           pdfDoc.context.obj(compressed.length));
          dict.set(PDFName.of('ColorSpace'),       PDFName.of('DeviceRGB'));
          dict.set(PDFName.of('BitsPerComponent'), pdfDoc.context.obj(8));
          if (newMeta.width)  dict.set(PDFName.of('Width'),  pdfDoc.context.obj(newMeta.width));
          if (newMeta.height) dict.set(PDFName.of('Height'), pdfDoc.context.obj(newMeta.height));
          dict.delete(PDFName.of('SMask'));
          dict.delete(PDFName.of('Mask'));
          dict.delete(PDFName.of('DecodeParms'));
          imagesProcessed++;
        } else {
          imagesSkipped++;
        }
      } catch {
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
    res.setHeader('Content-Disposition', 'attachment; filename="compressed.pdf"');
    res.setHeader('X-Original-Size',     originalSize.toString());
    res.setHeader('X-Compressed-Size',   compressedSize.toString());
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
