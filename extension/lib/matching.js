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

// Пометки, которые означают другую запись (живое исполнение, ремикс...).
// Всё остальное в скобках — «Remastered», «Soundtrack Version», «feat. …»,
// «From "…"» — на запись не влияет и при сравнении не учитывается.
const VERSION_MARKERS = {
  live: /\blive\b|концерт|живое исполнение/,
  remix: /\bremix|ремикс/,
  acoustic: /\bacoustic\b|акустик/,
  instrumental: /\binstrumental\b|инструментал|минусовка/,
  karaoke: /\bkaraoke\b|караоке/,
  demo: /\bdemo\b|демо/,
  unplugged: /\bunplugged\b/,
  slowed: /\bslowed\b|\bsped up\b|\bnightcore\b/,
};

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
// Если название состоит из одних символов (например, «∞»), оставляем как есть.
export function baseTitle(title) {
  const stripped = (title || "").replace(BRACKETS_RE, " ").replace(DASH_SUFFIX_RE, "");
  return normalize(stripped) || normalize(title) || (title || "").trim().toLowerCase();
}

// Значимые пометки версии из названия и поля version.
export function versionTags(track) {
  const chunks = [...(track.title || "").matchAll(BRACKETS_RE)].map((m) => m[0]);
  const dash = (track.title || "").match(DASH_SUFFIX_RE);
  if (dash) chunks.push(dash[0]);
  if (track.version) chunks.push(track.version);
  const tags = new Set();
  for (const chunk of chunks) {
    const text = chunk.toLowerCase();
    for (const [tag, re] of Object.entries(VERSION_MARKERS)) if (re.test(text)) tags.add(tag);
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

// Доля слов короткого названия, которые есть в длинном. Нужна для названий
// вроде «Le Cygne, R. 125» ↔ «Le carnaval des animaux, R. 125: XIII. Le cygne».
function wordContainment(a, b) {
  const left = new Set(transliterate(a).split(" ").filter(Boolean));
  const right = new Set(transliterate(b).split(" ").filter(Boolean));
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  if (small.size < 2) return 0;
  return [...small].filter((word) => large.has(word)).length / small.size;
}

export function titleSimilarity(a, b) {
  const left = baseTitle(a.title);
  const right = baseTitle(b.title);
  const direct = similarity(left, right);
  // Совпадение по словам учитываем, только если и длительность близка:
  // иначе «Love Me» совпало бы с «Love Me Do».
  const contained = durationSimilarity(a, b) > 0 ? 0.9 * wordContainment(left, right) : 0;
  return Math.max(direct, contained);
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
  const title = titleSimilarity(source, candidate);
  const artist = artistSimilarity(source, candidate);
  if (title < 0.6 || artist < 0.5) return 0;

  const duration = durationSimilarity(source, candidate);
  let result = 0.5 * title + 0.35 * artist + 0.15 * duration;
  // Караоке, концертная запись или ремикс — это другой трек, даже если всё остальное совпадает.
  if (versionTags(source) !== versionTags(candidate)) result -= 0.3;
  // Разница в длительности больше полуминуты — почти наверняка другая песня или версия.
  if (duration === 0) result -= 0.1;
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
