import { expect, test } from "bun:test";

const dockerfile = await Bun.file(
  new URL("./Dockerfile.worker", import.meta.url),
).text();

test("worker image includes conservative media processing tools", () => {
  for (const packageName of [
    "ffmpeg",
    "file",
    "jpegoptim",
    "jq",
    "libimage-exiftool-perl",
    "optipng",
    "webp",
  ]) {
    expect(dockerfile).toContain(`    ${packageName} \\\n`);
  }
});
