const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "us-central1" });

const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html><head><title>Access Denied</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#f8f8f8}
.box{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{color:#d32f2f;margin:0 0 .5rem}p{color:#666}</style></head>
<body><div class="box"><h1>Access Denied</h1><p>Invalid or missing access token.</p></div></body></html>`;

// Path pattern: /pages/<namespaceToken>/<deployId>/  or  /pages/<namespaceToken>/latest/
const PATH_RE = /^\/pages\/([a-f0-9]{12})\/([\w-]+)\/?(?:index\.html)?$/;

function validateToken(namespaceToken, accessToken, salt) {
  const expected = crypto
    .createHmac("sha256", salt)
    .update(namespaceToken)
    .digest("hex")
    .slice(0, 16);
  if (expected.length !== accessToken.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(accessToken, "utf8")
  );
}
module.exports.validateToken = validateToken;

exports.servePage = onRequest(
  { timeoutSeconds: 10, memory: "128MiB" },
  async (req, res) => {
    const match = req.path.match(PATH_RE);
    if (!match) { res.status(404).send("Not found"); return; }

    const [, namespaceToken, deployId] = match;
    const token = req.query.t || "";
    const salt = process.env.TOKEN_SALT;
    if (!salt) { res.status(500).send("Server configuration error"); return; }

    if (!validateToken(namespaceToken, token, salt)) {
      res.status(403).send(ACCESS_DENIED_HTML);
      return;
    }

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) { res.status(500).send("Server configuration error"); return; }

    const filePath = `pages/${namespaceToken}/${deployId}/index.html`;
    try {
      const [content] = await admin.storage().bucket(bucketName).file(filePath).download();
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("X-Robots-Tag", "noindex, nofollow");
      res.set("Cache-Control", "private, no-cache");
      res.set("Referrer-Policy", "no-referrer");
      res.send(content);
    } catch (err) {
      res.status(err.code === 404 ? 404 : 500).send(err.code === 404 ? "Page not found" : "Failed to load page");
    }
  }
);
