import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);

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
    const acceptsGzip = (req.headers["accept-encoding"] || "")
      .split(",")
      .some((entry) => {
        const [encoding, quality] = entry.trim().split(";");
        return (
          encoding === "gzip" &&
          (!quality || Number(quality.trim().replace("q=", "")) > 0)
        );
      });
    const useGzip =
      acceptsGzip && body.length > 1024 && extname(file) !== ".png";
    const output = useGzip ? await compress(body) : body;
    res
      .writeHead(200, {
        "Content-Type":
          (types[extname(file)] || "application/octet-stream") +
          (extname(file) === ".png" ? "" : "; charset=utf-8"),
        "Cache-Control": "no-cache",
        Vary: "Accept-Encoding",
        ...(useGzip ? { "Content-Encoding": "gzip" } : {}),
      })
      .end(output);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(
  Number(process.env.PORT || 4173),
  process.env.HOST || "127.0.0.1",
  () => console.log(`Pinward → http://localhost:${process.env.PORT || 4173}`),
);
