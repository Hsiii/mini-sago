type InstagramLinkTransform = {
  changed: boolean;
  content: string;
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION = /[),.!?:;]+$/;

function splitTrailingPunctuation(candidate: string) {
  const match = candidate.match(TRAILING_URL_PUNCTUATION);

  if (!match) {
    return {
      urlText: candidate,
      trailing: "",
    };
  }

  return {
    urlText: candidate.slice(0, -match[0].length),
    trailing: match[0],
  };
}

function isInstagramHost(hostname: string) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "instagram.com" || normalized.endsWith(".instagram.com")
  );
}

function isKkInstagramHost(hostname: string) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "kkinstagram.com" || normalized.endsWith(".kkinstagram.com")
  );
}

function toKkInstagramUrl(rawUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  if (!isInstagramHost(parsed.hostname) || isKkInstagramHost(parsed.hostname)) {
    return null;
  }

  parsed.hostname = parsed.hostname.replace(
    /instagram\.com$/i,
    "kkinstagram.com",
  );

  return parsed.toString();
}

export function transformInstagramLinks(
  content: string,
): InstagramLinkTransform {
  let changed = false;
  const transformed = content.replace(URL_PATTERN, (candidate) => {
    const { urlText, trailing } = splitTrailingPunctuation(candidate);
    const nextUrl = toKkInstagramUrl(urlText);

    if (!nextUrl) {
      return candidate;
    }

    changed = true;
    return `${nextUrl}${trailing}`;
  });

  return {
    changed,
    content: transformed,
  };
}
