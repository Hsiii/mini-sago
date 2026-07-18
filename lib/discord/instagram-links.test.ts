import { describe, expect, test } from "bun:test";

import { getInstagramReplyUrls } from "./instagram-links";

describe("getInstagramReplyUrls", () => {
  test("returns only the transformed URL from a message", () => {
    expect(
      getInstagramReplyUrls(
        "look at this https://instagram.com/reel/abc/ please!",
      ),
    ).toEqual(["https://kkinstagram.com/reel/abc/"]);
  });

  test("returns each transformed URL without trailing punctuation", () => {
    expect(
      getInstagramReplyUrls(
        "(https://www.instagram.com/reel/a/), https://m.instagram.com/p/b/.",
      ),
    ).toEqual([
      "https://www.kkinstagram.com/reel/a/",
      "https://m.kkinstagram.com/p/b/",
    ]);
  });

  test("ignores links that are already transformed", () => {
    expect(
      getInstagramReplyUrls("https://www.kkinstagram.com/reel/abc/"),
    ).toEqual([]);
  });
});
