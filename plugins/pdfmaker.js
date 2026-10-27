const { extractMessageContent, getContentType } = require("baileys");
const PDFDocument = require("pdfkit");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");

const MAX_TEXT_LENGTH = 20000;
// Biggest quoted image, in bytes
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Longest side of the picture embedded in the PDF, in pixels
const MAX_IMAGE_PIXELS = 2480;
const PAGE_MARGIN = 50;

// Besides ASCII (32-126) and Latin-1 (160-255), the standard PDF fonts
// (WinAnsi encoding) render these characters; everything else comes out as garbage
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160,
  0x2039, 0x152, 0x17d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x17e, 0x178,
]);

// Invisible characters (zero-width spaces and joiners, direction marks,
// variation selectors) that are dropped instead of being replaced
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤︀-️﻿]/u;

function isRenderable(codePoint) {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRA.has(codePoint)
  );
}

/**
 * Make a text safe for the standard Helvetica font: unsupported letters fall
 * back to their base letter when they have one (ś -> s), anything else (emoji,
 * other alphabets) becomes a single "?" per run.
 * @returns {{ text: string, replaced: boolean }}
 */
function toPdfText(input) {
  let text = "";
  let replaced = false;
  let inReplacement = false;

  for (const char of String(input).normalize("NFC")) {
    if (char === "\r" || INVISIBLE_RE.test(char)) continue;
    if (char === "\n") {
      text += char;
      inReplacement = false;
      continue;
    }
    if (char === "\t") {
      text += "    ";
      inReplacement = false;
      continue;
    }

    const codePoint = char.codePointAt(0);
    if (isRenderable(codePoint)) {
      text += char;
      inReplacement = false;
      continue;
    }

    const base = char.normalize("NFD").codePointAt(0);
    if (base !== codePoint && isRenderable(base)) {
      text += String.fromCodePoint(base);
      inReplacement = false;
      continue;
    }

    // Combining marks left over from a decomposed letter are silently dropped
    if (/\p{M}/u.test(char)) continue;

    replaced = true;
    if (!inReplacement) text += "?";
    inReplacement = true;
  }

  return { text, replaced };
}

/** Collect the stream of a pdfkit document into a Buffer (nothing touches the disk) */
function renderPdf(draw) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  draw(doc);
  doc.end();
  return done;
}

function textToPdf(text) {
  return renderPdf((doc) => {
    doc.fontSize(12).font("Helvetica").text(text, { align: "left" });
  });
}

/**
 * Picture to a one-page PDF, fitted in the page. It goes through sharp first:
 * pdfkit only reads jpeg and png, and not every png (webp, gif, avif,
 * interlaced and 16-bit png would fail).
 */
async function imageToPdf(buffer) {
  const sharp = require("sharp");
  const png = await sharp(buffer)
    .rotate()
    .resize({
      width: MAX_IMAGE_PIXELS,
      height: MAX_IMAGE_PIXELS,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  return renderPdf((doc) => {
    const width = doc.page.width - PAGE_MARGIN * 2;
    const height = doc.page.height - PAGE_MARGIN * 2;
    doc.image(png, PAGE_MARGIN, PAGE_MARGIN, {
      fit: [width, height],
      align: "center",
      valign: "center",
    });
  });
}

function isQuotedImage(message) {
  if (!message.quoted?.message) return false;
  const content = extractMessageContent(message.quoted.message);
  const type = getContentType(content);
  return type === "imageMessage" || type === "stickerMessage";
}

/**
 * PDF Plugin
 * Create PDF from text or images
 */
module.exports = {
  command: {
    pattern: "pdf",
    desc: getLang("plugins.pdfmaker.desc"),
    type: "utility",
  },

  async execute(message, args, ctx) {
    // Quoted image: the image becomes the PDF
    if (isQuotedImage(message)) {
      const media = await message.getQuotedMedia({ maxBytes: MAX_IMAGE_BYTES });
      if (!media) {
        return await message.reply(getLang("plugins.pdfmaker.download_failed"));
      }
      await message.react("📄");
      try {
        const pdf = await imageToPdf(media.buffer);
        await message.sendDocument(pdf, {
          fileName: "image.pdf",
          mimetype: "application/pdf",
          caption: getLang("plugins.pdfmaker.image_caption"),
        });
        await message.react("✅");
      } catch (error) {
        await fail(message, error);
      }
      return;
    }

    // Otherwise the typed text (line breaks kept), else the quoted text
    const typed = String(ctx?.rawArgs ?? args ?? "").trim();
    const input = typed || message.getQuotedText().trim();

    if (!input) {
      return await message.reply(
        `${getLang("common.usage_prefix")}\n${getLang("plugins.pdfmaker.usage", config.PREFIX)}`,
      );
    }
    if (input.length > MAX_TEXT_LENGTH) {
      return await message.reply(
        getLang("plugins.pdfmaker.text_too_long", MAX_TEXT_LENGTH),
      );
    }

    await message.react("📄");
    try {
      const { text, replaced } = toPdfText(input);
      const pdf = await textToPdf(text);
      await message.sendDocument(pdf, {
        fileName: "document.pdf",
        mimetype: "application/pdf",
        caption: getLang(
          replaced
            ? "plugins.pdfmaker.doc_caption_replaced"
            : "plugins.pdfmaker.doc_caption",
        ),
      });
      await message.react("✅");
    } catch (error) {
      await fail(message, error);
    }
  },
};

async function fail(message, error) {
  console.error("PDF creation error:", safeLog(error));
  await message.react("❌");
  const kind = classifyError(error);
  await message.reply(
    getLang(kind === "error" ? "plugins.pdfmaker.error" : replyKeyFor(kind)),
  );
}
