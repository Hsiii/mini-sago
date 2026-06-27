import { describe, expect, test } from "bun:test";

import {
  formatToeflVocabMessage,
  selectDailyToeflVocabEntry,
  type ToeflVocabEntry,
} from "./toefl-vocab";

const entries: ToeflVocabEntry[] = [
  {
    word: "abate",
    partOfSpeech: "verb",
    definition: "To lessen in force or intensity.",
    sourceUrl: "https://en.wiktionary.org/wiki/abate",
  },
  {
    word: "adapt",
    partOfSpeech: "verb",
    definition: "To make suitable.",
    sourceUrl: "https://en.wiktionary.org/wiki/adapt",
  },
];

describe("selectDailyToeflVocabEntry", () => {
  test("selects the same entry for the same date", () => {
    expect(selectDailyToeflVocabEntry(entries, "2026-06-27")).toEqual(
      selectDailyToeflVocabEntry(entries, "2026-06-27"),
    );
  });

  test("rotates entries by date", () => {
    expect(selectDailyToeflVocabEntry(entries, "2026-06-27").word).not.toBe(
      selectDailyToeflVocabEntry(entries, "2026-06-28").word,
    );
  });
});

describe("formatToeflVocabMessage", () => {
  test("includes source and license attribution", () => {
    const message = formatToeflVocabMessage({
      entry: {
        ...entries[0],
        zhTw: "減弱；緩和",
        example: "The storm began to abate after midnight.",
        synonyms: ["lessen", "subside"],
      },
      attribution: {
        sourceName: "Wiktionary",
        sourceUrl: "https://en.wiktionary.org/wiki/Wiktionary:Main_Page",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
    });

    expect(message).toContain("TOEFL Word of the Day");
    expect(message).toContain(
      "## [abate](<https://en.wiktionary.org/wiki/abate>)",
    );
    expect(message).toContain("*verb* · 減弱；緩和");
    expect(message).toContain("> The storm began to abate after midnight.");
    expect(message).toContain(
      "[Wiktionary](<https://en.wiktionary.org/wiki/Wiktionary:Main_Page>) · [CC BY-SA 4.0](<https://creativecommons.org/licenses/by-sa/4.0/>)",
    );
    expect(message).not.toContain("Example:");
    expect(message).not.toContain("Source:");
    expect(message).not.toContain("License:");
  });
});
