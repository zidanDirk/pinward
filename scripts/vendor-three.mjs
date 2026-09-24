import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { transform } from "esbuild";
const root = new URL("../", import.meta.url);
await mkdir(new URL("vendor/three/", root), { recursive: true });
for (const file of ["three.module.js", "three.core.js"]) {
  const source = await readFile(
    new URL(`node_modules/three/build/${file}`, root),
    "utf8",
  );
  const { code } = await transform(source, {
    minify: true,
    format: "esm",
    target: "es2022",
    legalComments: "inline",
  });
  await writeFile(new URL(`vendor/three/${file}`, root), code);
}
await copyFile(
  new URL("node_modules/three/LICENSE", root),
  new URL("vendor/three/LICENSE", root),
);
const pkg = JSON.parse(
  await readFile(new URL("node_modules/three/package.json", root), "utf8"),
);
await writeFile(
  new URL("vendor/three/README.md", root),
  `# Three.js ${pkg.version}\n\nOfficial ES modules minified with esbuild, vendored for static hosting and offline play. MIT license: see LICENSE.\n\nRegenerate with \`npm ci && npm run vendor\`. Source: https://github.com/mrdoob/three.js/tree/r${pkg.version.split(".")[1]}\n`,
);
