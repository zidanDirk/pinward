import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve(import.meta.dirname);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};
createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (
      path
        .slice(root.length)
        .split(sep)
        .some((part) => part.startsWith("."))
    ) {
      res.writeHead(403).end();
      return;
    }
    const file = path === root ? resolve(root, "index.html") : path;
    const body = await readFile(file);
    res
      .writeHead(200, {
        "Content-Type":
          (types[extname(file)] || "application/octet-stream") +
          (extname(file) === ".png" ? "" : "; charset=utf-8"),
        "Cache-Control": "no-cache",
      })
      .end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(
  Number(process.env.PORT || 4173),
  process.env.HOST || "127.0.0.1",
  () => console.log(`Pinward → http://localhost:${process.env.PORT || 4173}`),
);
