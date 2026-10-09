const { getLang } = require("../lib/utils/language");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

/**
 * PDF Plugin
 * Create PDF from text or images
 */

module.exports = {
  command: {
    pattern: "pdf",
    desc: "Create PDF from text or image",
    type: "utility",
  },

  async execute(message, args) {
    if (!args && !message.quoted) {
      return await message.reply(
        `*📄 PDF Creator*

*Usage:*
• .pdf <text> - Create PDF from text
• Reply to image with .pdf - Convert image to PDF

*Example:*
.pdf This is my document content`
      );
    }

    try {
      await message.react("📄");

      const tempDir = "/tmp";
      const fileName = `pdf_${Date.now()}.pdf`;
      const filePath = path.join(tempDir, fileName);

      // Check if replying to an image
      if (message.quoted && message.quoted.message) {
        const quotedType = message.getMediaType();

        if (quotedType === "image") {
          // Download image
          const buffer = await message.downloadMedia();

          if (!buffer) {
            return await message.reply("*Failed to download image!*");
          }

          // Create PDF with image
          const doc = new PDFDocument({ autoFirstPage: false });
          const writeStream = fs.createWriteStream(filePath);

          doc.pipe(writeStream);

          // Add image to PDF
          doc.addPage();
          doc.image(buffer, {
            fit: [500, 700],
            align: "center",
            valign: "center",
          });

          doc.end();

          // Wait for file to be written
          await new Promise((resolve) => writeStream.on("finish", resolve));

          // Send PDF
          const pdfBuffer = fs.readFileSync(filePath);
          await message.sendDocument(pdfBuffer, {
            fileName: "image.pdf",
            mimetype: "application/pdf",
            caption: "*Image converted to PDF* 📄",
          });

          // Cleanup
          fs.unlinkSync(filePath);
          await message.react("✅");
          return;
        }
      }

      // Create PDF from text
      const text = args || message.quoted?.body || "No content provided";

      const doc = new PDFDocument();
      const writeStream = fs.createWriteStream(filePath);

      doc.pipe(writeStream);

      // Add title
      doc.fontSize(20).text("Generated Document", { align: "center" });
      doc.moveDown();

      // Add content
      doc.fontSize(12).text(text, {
        align: "justify",
      });

      doc.end();

      // Wait for file to be written
      await new Promise((resolve) => writeStream.on("finish", resolve));

      // Send PDF
      const pdfBuffer = fs.readFileSync(filePath);
      await message.sendDocument(pdfBuffer, {
        fileName: "document.pdf",
        mimetype: "application/pdf",
        caption: "*PDF Created* 📄",
      });

      // Cleanup
      fs.unlinkSync(filePath);
      await message.react("✅");
    } catch (error) {
      console.error("PDF creation error:", error);
      await message.reply("*Error creating PDF!*\n\n" + error.message);
      await message.react("❌");
    }
  },
};
