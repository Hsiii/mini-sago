import { describe, expect, test } from "bun:test";

import { transformInstagramLinks } from "./instagram-links";

describe("transformInstagramLinks", () => {
  test("adds kk to www Instagram reel links", () => {
    const result = transformInstagramLinks(
      "https://www.instagram.com/reel/DaA34AZs68f/?igsh=MWl0eHduandnaG5lMg==",
    );

    expect(result).toEqual({
      changed: true,
      content:
        "https://www.kkinstagram.com/reel/DaA34AZs68f/?igsh=MWl0eHduandnaG5lMg==",
    });
  });

  test("adds kk to bare Instagram post links", () => {
    const result = transformInstagramLinks("look https://instagram.com/p/abc/");

    expect(result).toEqual({
      changed: true,
      content: "look https://kkinstagram.com/p/abc/",
    });
  });

  test("does not transform links that already use kkinstagram", () => {
    const result = transformInstagramLinks(
      "https://www.kkinstagram.com/reel/abc/",
    );

    expect(result).toEqual({
      changed: false,
      content: "https://www.kkinstagram.com/reel/abc/",
    });
  });

  test("preserves trailing sentence punctuation", () => {
    const result = transformInstagramLinks(
      "(https://instagram.com/reel/abc/).",
    );

    expect(result).toEqual({
      changed: true,
      content: "(https://kkinstagram.com/reel/abc/).",
    });
  });

  test("transforms multiple Instagram subdomain links", () => {
    const result = transformInstagramLinks(
      "https://www.instagram.com/reel/a/ https://m.instagram.com/p/b/",
    );

    expect(result).toEqual({
      changed: true,
      content:
        "https://www.kkinstagram.com/reel/a/ https://m.kkinstagram.com/p/b/",
    });
  });
});
