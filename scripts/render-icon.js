// One-off helper to rasterize media/icon.svg into the 128x128 PNG the
// Marketplace requires. Run: node scripts/render-icon.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const svg = path.join(__dirname, "..", "media", "icon.svg");
const png = path.join(__dirname, "..", "media", "icon.png");

sharp(svg)
  .resize(128, 128)
  .png()
  .toFile(png)
  .then(() => console.log("Wrote", png))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
