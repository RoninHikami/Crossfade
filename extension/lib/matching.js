// Сопоставление треков между сервисами.
//
// Сначала сравниваем ISRC (если он есть у обоих треков), иначе считаем
// взвешенную похожесть названия, исполнителей и длительности.

export const MATCH_THRESHOLD = 0.75;

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

// Пометки версии, которые делают трек «другим» (живое исполнение, ремикс...).
const VERSION_MARKERS = [
  "live", "remix", "acoustic", "instrumental", "karaoke", "cover",
  "demo", "edit", "mix", "version", "unplugged",
  "концерт", "живое", "ремикс", "акустика", "инструментал",
];
// Пометки, которые можно игнорировать.
const NEUTRAL_MARKERS = ["remaster", "feat", "ft.", "with ", "radio edit", "explicit", "bonus"];

const BRACKETS_RE = /[(\[{].*?[)\]}]/g;
const DASH_SUFFIX_RE = /\s+[-–—]\s+.*$/;

export function transliterate(text) {
  return [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
}

export function normalize(text) {
  return (text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll("&", " and ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Название без скобок и суффиксов вида « - Remastered 2011».
export function baseTitle(title) {
  const stripped = (title || "").replace(BRACKETS_RE, " ").replace(DASH_SUFFIX_RE, "");
  return normalize(stripped) || normalize(title);
}

// Значимые пометки версии из названия и поля version.
export function versionTags(track) {
  const chunks = [...(track.title || "").matchAll(BRACKETS_RE)].map((m) => m[0]);
  const dash = (track.title || "").match(DASH_SUFFIX_RE);
  if (dash) chunks.push(dash[0]);
  if (track.version) chunks.push(track.version);
  const tags = new Set();
  for (let chunk of chunks) {
    chunk = chunk.toLowerCase();
    if (NEUTRAL_MARKERS.some((n) => chunk.includes(n))) continue;
    for (const marker of VERSION_MARKERS) if (chunk.includes(marker)) tags.add(marker);
  }
  return [...tags].sort().join(",");
}

// Аналог difflib.SequenceMatcher.ratio() на основе длины общей подпоследовательности.
function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = up;
    }
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(ratio(a, b), ratio(transliterate(a), transliterate(b)));
}

export function artistSimilarity(a, b) {
  const left = (a.artists || []).map(normalize).filter(Boolean);
  const right = (b.artists || []).map(normalize).filter(Boolean);
  if (!left.length || !right.length) return 0;
  // Лучшее совпадение для каждого исполнителя исходного трека; главный
  // исполнитель весит больше, чем приглашённые.
  const best = left.map((x) => Math.max(...right.map((y) => similarity(x, y))));
  if (best.length === 1) return best[0];
  return 0.7 * best[0] + 0.3 * Math.max(...best);
}

export function durationSimilarity(a, b) {
  if (!a.durationMs || !b.durationMs) return 0.5;
  const diff = Math.abs(a.durationMs - b.durationMs) / 1000;
  if (diff <= 3) return 1;
  if (diff >= 30) return 0;
  return 1 - (diff - 3) / 27;
}

// Похожесть треков от 0 до 1.
export function score(source, candidate) {
  if (source.isrc && candidate.isrc && source.isrc.toUpperCase() === candidate.isrc.toUpperCase()) {
    return 1;
  }
  const title = similarity(baseTitle(source.title), baseTitle(candidate.title));
  const artist = artistSimilarity(source, candidate);
  if (title < 0.6 || artist < 0.5) return 0;

  let result = 0.5 * title + 0.35 * artist + 0.15 * durationSimilarity(source, candidate);
  if (versionTags(source) !== versionTags(candidate)) result -= 0.2;
  return Math.max(result, 0);
}

export function bestMatch(source, candidates, threshold = MATCH_THRESHOLD) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const value = score(source, candidate);
    if (value > bestScore) {
      best = candidate;
      bestScore = value;
    }
  }
  return bestScore < threshold ? { match: null, score: bestScore } : { match: best, score: bestScore };
}

export function displayTrack(track) {
  const title = track.version ? `${track.title} (${track.version})` : track.title;
  return `${(track.artists || []).join(", ")} — ${title}`;
}
