import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import vocabData from "../../data/toefl-vocab.json";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_DAILY_TIME = "08:00";
const DEFAULT_TIMEZONE = "Asia/Taipei";
const DEFAULT_STATE_FILE = ".data/toefl-vocab-state.json";
const MESSAGE_LIMIT = 2_000;
const DAILY_CHECK_INTERVAL_MS = 60_000;

type ToeflVocabAttribution = {
  sourceName: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
};

export type ToeflVocabEntry = {
  word: string;
  partOfSpeech: string;
  definition: string;
  zhTw?: string;
  example?: string;
  synonyms?: string[];
  sourceUrl: string;
};

type ToeflVocabDataset = {
  attribution: ToeflVocabAttribution;
  entries: ToeflVocabEntry[];
};

type ToeflVocabSchedulerConfig = {
  botToken: string;
  channelId: string;
  dailyTime: string;
  timezone: string;
  stateFile: string;
};

type ToeflVocabState = {
  lastSentDate?: string;
  lastSentWord?: string;
};

type TimeParts = {
  dateKey: string;
  minutesSinceMidnight: number;
};

function getToeflVocabConfig(): ToeflVocabSchedulerConfig | null {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const channelId = process.env.TOEFL_VOCAB_CHANNEL_ID?.trim();

  if (!channelId) {
    return null;
  }

  if (!botToken) {
    console.warn(
      "TOEFL vocab scheduler disabled: DISCORD_BOT_TOKEN is missing.",
    );
    return null;
  }

  return {
    botToken,
    channelId,
    dailyTime: process.env.TOEFL_VOCAB_TIME?.trim() || DEFAULT_DAILY_TIME,
    timezone: process.env.TOEFL_VOCAB_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    stateFile: process.env.TOEFL_VOCAB_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
  };
}

function assertDataset(dataset: ToeflVocabDataset) {
  if (!dataset.entries.length) {
    throw new Error("TOEFL vocab dataset has no entries.");
  }
}

function getDataset() {
  const dataset = vocabData as ToeflVocabDataset;
  assertDataset(dataset);

  return dataset;
}

function parseDailyTime(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);

  if (!match) {
    throw new Error(`TOEFL_VOCAB_TIME must use HH:MM format: ${value}`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function getTimeParts(date: Date, timezone: string): TimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutesSinceMidnight: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function daysSinceEpochDate(dateKey: string) {
  return Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / 86_400_000);
}

export function selectDailyToeflVocabEntry(
  entries: ToeflVocabEntry[],
  dateKey: string,
) {
  if (!entries.length) {
    throw new Error("Cannot select a TOEFL vocab entry from an empty list.");
  }

  return entries[daysSinceEpochDate(dateKey) % entries.length];
}

export function formatToeflVocabMessage({
  entry,
  attribution,
}: {
  entry: ToeflVocabEntry;
  attribution: ToeflVocabAttribution;
}) {
  const lines = [
    "📘 TOEFL Word of the Day",
    "",
    `**${entry.word}**`,
    entry.partOfSpeech,
    "",
    `Meaning: ${entry.definition}`,
  ];

  if (entry.zhTw) {
    lines.push(`中文：${entry.zhTw}`);
  }

  if (entry.example) {
    lines.push("", `Example: ${entry.example}`);
  }

  if (entry.synonyms?.length) {
    lines.push("", `Synonyms: ${entry.synonyms.join(", ")}`);
  }

  lines.push(
    "",
    `Source: ${attribution.sourceName} (${entry.sourceUrl})`,
    `License: ${attribution.license} (${attribution.licenseUrl})`,
  );

  return lines.join("\n").slice(0, MESSAGE_LIMIT);
}

async function readState(stateFile: string): Promise<ToeflVocabState> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as ToeflVocabState;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: string }).code;

      if (code === "ENOENT") {
        return {};
      }
    }

    throw error;
  }
}

async function writeState(stateFile: string, state: ToeflVocabState) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${stateFile}.tmp`, stateFile);
}

async function sendDiscordChannelMessage({
  botToken,
  channelId,
  content,
}: {
  botToken: string;
  channelId: string;
  content: string;
}) {
  const response = await fetch(
    `${DISCORD_API_BASE_URL}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: [],
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
}

async function sendDailyToeflVocabIfDue(
  config: ToeflVocabSchedulerConfig,
  now = new Date(),
) {
  const scheduledMinutes = parseDailyTime(config.dailyTime);
  const timeParts = getTimeParts(now, config.timezone);

  if (timeParts.minutesSinceMidnight < scheduledMinutes) {
    return;
  }

  const state = await readState(config.stateFile);

  if (state.lastSentDate === timeParts.dateKey) {
    return;
  }

  const dataset = getDataset();
  const entry = selectDailyToeflVocabEntry(dataset.entries, timeParts.dateKey);
  const content = formatToeflVocabMessage({
    entry,
    attribution: dataset.attribution,
  });

  await sendDiscordChannelMessage({
    botToken: config.botToken,
    channelId: config.channelId,
    content,
  });
  await writeState(config.stateFile, {
    lastSentDate: timeParts.dateKey,
    lastSentWord: entry.word,
  });

  console.log(`Sent TOEFL vocab word for ${timeParts.dateKey}: ${entry.word}.`);
}

export function startToeflVocabScheduler() {
  const config = getToeflVocabConfig();

  if (!config) {
    return null;
  }

  const tick = async () => {
    try {
      await sendDailyToeflVocabIfDue(config);
    } catch (error) {
      console.error("Failed to send daily TOEFL vocab word:", error);
    }
  };

  void tick();

  const timer = setInterval(() => {
    void tick();
  }, DAILY_CHECK_INTERVAL_MS);

  console.log(
    `TOEFL vocab scheduler enabled for ${config.dailyTime} ${config.timezone}.`,
  );

  return timer;
}
