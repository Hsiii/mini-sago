const DEFAULT_WORDS = [
  "abate",
  "abstract",
  "accumulate",
  "accurate",
  "adapt",
  "adequate",
  "adjacent",
  "allocate",
  "alter",
  "analyze",
  "approach",
  "assess",
  "assume",
  "benefit",
  "concept",
  "consistent",
  "derive",
  "establish",
  "evidence",
  "factor",
  "indicate",
  "interpret",
  "method",
  "occur",
  "period",
  "process",
  "require",
  "respond",
  "significant",
  "vary",
];

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getDefinition(entry) {
  const definition = entry.definitions?.find((candidate) =>
    candidate.definition?.trim(),
  );

  return definition ? stripHtml(definition.definition) : null;
}

function getExample(entry) {
  const definition = entry.definitions?.find(
    (candidate) => candidate.examples?.length,
  );
  const example = definition?.examples?.[0];

  return example ? stripHtml(example) : undefined;
}

async function fetchEntry(word) {
  const response = await fetch(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
    {
      headers: {
        "User-Agent": "MiniSago/0.1 vocab importer",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`${word}: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const englishEntries = body.en ?? [];
  const entry = englishEntries.find((candidate) => getDefinition(candidate));

  if (!entry) {
    throw new Error(`${word}: no English definition found`);
  }

  return {
    word,
    partOfSpeech: String(entry.partOfSpeech ?? "").toLowerCase(),
    definition: getDefinition(entry),
    example: getExample(entry),
    synonyms: [],
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
  };
}

const words = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_WORDS;
const entries = [];

for (const word of words) {
  entries.push(await fetchEntry(word));
}

console.log(
  JSON.stringify(
    {
      attribution: {
        sourceName: "Wiktionary",
        sourceUrl: "https://en.wiktionary.org/wiki/Wiktionary:Main_Page",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
      entries,
    },
    null,
    2,
  ),
);
