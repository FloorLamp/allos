// The initials an avatar falls back to when a profile has no photo (#2615 item 1).
//
// The old rule was "first character of the first two whitespace-split words", which
// is only correct while every word starts with a letter. Caregiver households do not
// name people that way: the seed itself ships "Riley (child)", whose second "word"
// begins with "(" — so the avatar rendered "R(", a parenthesis presented as somebody's
// initial. Quoted nicknames ('Bob "Bo" Smith'), a leading emoji, and a hyphen used as
// a separator all fail the same way.
//
// So a token only CONTRIBUTES an initial when it starts with a letter or a digit,
// after any leading punctuation is stripped. A parenthetical qualifier is a
// qualifier, not a name — "Riley (child)" is Riley, initial "R" — while "Riley
// (Chen)" still yields "RC" once the bracket is off the front, because the word
// inside it is a real word. Two is still the cap.
//
// The fallbacks are deliberate and ordered. A name made ENTIRELY of punctuation or
// symbols ("🙂", "???") has no letter to take, so rather than render an empty circle
// the first non-space character stands in — it is at least the name the user chose.
// Only a blank name reaches "?".
//
// Unicode-aware throughout (`\p{L}`/`\p{N}` with the `u` flag): "Ünal" initials as
// "Ü" and "Мария" as "М", neither of which an ASCII range would have matched.

// Leading characters that are decoration around a name rather than part of it.
const LEADING_JUNK = /^[^\p{L}\p{N}]+/u;

// Whether a token, once its leading decoration is off, begins with a letter or digit.
function initialOf(token: string): string | null {
  const trimmed = token.replace(LEADING_JUNK, "");
  const first = [...trimmed][0];
  return first != null && /[\p{L}\p{N}]/u.test(first) ? first : null;
}

export function avatarInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const letters: string[] = [];
  for (const token of tokens) {
    const initial = initialOf(token);
    if (initial == null) continue;
    letters.push(initial);
    if (letters.length === 2) break;
  }
  if (letters.length > 0) return letters.join("").toLocaleUpperCase();
  // Nothing alphanumeric anywhere: show the first real character rather than an
  // empty circle. `[...]` iterates by code point, so an emoji survives intact.
  const firstChar = [...name.trim()][0];
  return firstChar ?? "?";
}
