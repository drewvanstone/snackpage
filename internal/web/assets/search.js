// Shared bookmark-search relevance rules for the picker and manage view.

const FIELD_WEIGHTS = {
  title: 4,
  aliases: 3,
  tags: 2,
  url: 1,
};
const HUMAN_FIELDS = ["title", "aliases", "tags"];

// fzf considers any ordered subsequence a match, even when the characters are
// scattered across a long opaque URL. Literal substrings always qualify; a
// non-contiguous match must retain most of the query's ideal contiguous score.
const MIN_FUZZY_SCORE_RATIO = 0.7;
const MIN_METADATA_FUZZY_QUERY_LENGTH = 3;
const FZF_OPTIONS = { casing: "case-insensitive" };

function fieldText(item, field) {
  const value = item[field];
  return Array.isArray(value) ? value.join(" ") : String(value ?? "");
}

function folded(value) {
  return String(value).normalize().toLowerCase();
}

function isUppercaseLetter(character) {
  return (
    character.toUpperCase() === character &&
    character.toLowerCase() !== character
  );
}

function acronymCharacters(value) {
  const words = String(value).normalize().match(/[\p{L}\p{N}]+/gu) || [];
  const characters = [];
  for (const word of words) {
    for (const [index, character] of [...word].entries()) {
      if (index === 0 || isUppercaseLetter(character)) {
        characters.push(character);
      }
    }
  }
  return folded(characters.join(""));
}

function isOrderedSubsequence(query, candidate) {
  let queryIndex = 0;
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function isAcronymMatch(query, value) {
  const compactQuery = folded(query).replace(/[^\p{L}\p{N}]/gu, "");
  if (compactQuery.length < 2) return false;
  return isOrderedSubsequence(compactQuery, acronymCharacters(value));
}

function urlHostnameLabels(value) {
  const raw = String(value).trim();
  const candidates = raw.includes("://") ? [raw] : [`https://${raw}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.match(/[\p{L}\p{N}]+/gu) || [];
    } catch {
      // A partially edited manage-row URL can be invalid; literal matching
      // still works, but it has no safe hostname-only fuzzy representation.
    }
  }
  return [];
}

function literalScore(query, item) {
  const foldedQuery = folded(query);
  let score = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    if (folded(fieldText(item, field)).includes(foldedQuery)) score += weight;
  }
  return score;
}

// Literal results lead and may be joined by strong alias/tag matches for
// queries of 3+ characters. Without literals, prefer acronyms, then compact
// fuzzy matches. Field weights rank results within the selected result set.
export function scoreBookmarkMatches(query, items, fzfNamespace) {
  const q = String(query).trim();
  if (q === "" || items.length === 0) return [];

  const F = fzfNamespace;
  if (!F?.Fzf) {
    return items.flatMap((item) => {
      const score = literalScore(q, item);
      return score > 0 ? [{ item, score }] : [];
    });
  }

  const idealMatch = new F.Fzf([q], FZF_OPTIONS).find(q)[0];
  const minimumFuzzyScore = Number.isFinite(idealMatch?.score)
    ? idealMatch.score * MIN_FUZZY_SCORE_RATIO
    : Number.POSITIVE_INFINITY;
  const foldedQuery = folded(q);
  const metadataFuzzyAllowed =
    [...foldedQuery].length >= MIN_METADATA_FUZZY_QUERY_LENGTH;
  const literalScores = new Map();
  const metadataFuzzyScores = new Map();
  const acronymScores = new Map();
  const fuzzyScores = new Map();

  function addScore(scoreMap, item, score) {
    scoreMap.set(item, (scoreMap.get(item) || 0) + score);
  }

  for (const field of HUMAN_FIELDS) {
    const weight = FIELD_WEIGHTS[field];
    const selector = (item) => fieldText(item, field);
    const finder = new F.Fzf(items, { ...FZF_OPTIONS, selector });
    for (const match of finder.find(q)) {
      const value = selector(match.item);
      const literal = folded(value).includes(foldedQuery);
      const acronym = isAcronymMatch(q, value);
      if (literal) {
        addScore(literalScores, match.item, weight * match.score);
      }
      if (acronym) {
        addScore(acronymScores, match.item, weight * match.score);
      }
      if (match.score >= minimumFuzzyScore) {
        addScore(fuzzyScores, match.item, weight * match.score);
        if (!literal && field !== "title" && metadataFuzzyAllowed) {
          addScore(metadataFuzzyScores, match.item, weight * match.score);
        }
      }
    }
  }

  // A URL substring is intentional regardless of boundaries. Non-literal URL
  // fuzziness is limited to one hostname label; opaque paths and query strings
  // cannot create matches or combine with hostname characters.
  const urlSelector = (item) => fieldText(item, "url");
  const bestURLScores = new Map();
  const fullURLFinder = new F.Fzf(items, {
    ...FZF_OPTIONS,
    selector: urlSelector,
  });
  for (const match of fullURLFinder.find(q)) {
    if (folded(urlSelector(match.item)).includes(foldedQuery)) {
      addScore(
        literalScores,
        match.item,
        FIELD_WEIGHTS.url * match.score,
      );
    }
  }

  const tokenRecords = items.flatMap((item) =>
    urlHostnameLabels(urlSelector(item)).map((token) => ({ item, token })),
  );
  const tokenFinder = new F.Fzf(tokenRecords, {
    ...FZF_OPTIONS,
    selector: (record) => record.token,
  });
  for (const match of tokenFinder.find(q)) {
    if (match.score < minimumFuzzyScore) continue;
    const current = bestURLScores.get(match.item.item) || 0;
    bestURLScores.set(match.item.item, Math.max(current, match.score));
  }
  for (const [item, score] of bestURLScores) {
    addScore(fuzzyScores, item, FIELD_WEIGHTS.url * score);
  }

  let selectedScores;
  if (literalScores.size > 0) {
    selectedScores = new Map(literalScores);
    for (const [item, score] of metadataFuzzyScores) {
      addScore(selectedScores, item, score);
    }
  } else {
    selectedScores = acronymScores.size > 0 ? acronymScores : fuzzyScores;
  }
  return [...selectedScores].map(([item, score]) => ({ item, score }));
}
