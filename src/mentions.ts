// "@nickname" detection shared by the server (user text) and the orchestrator (model replies).

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds mentioned members. Longest nicknames first and consumed, so "小" does not also match inside "小 C"; the "@" must
 * not sit inside a word or an e-mail address ("x@Ann.com"), and a nickname ending in a letter or digit must not be
 * followed by more of them ("@Alice" never hits a member called "A").
 */
export function parseMentionsIn(text: string, members: { contactId: string; nickname: string }[]): string[] {
  const out: string[] = [];
  const sorted = [...members].filter((m) => m.nickname).sort((a, b) => b.nickname.length - a.nickname.length);
  let rest = text;
  for (const m of sorted) {
    const tail = /[A-Za-z0-9_]$/.test(m.nickname) ? "(?![A-Za-z0-9_])" : "";
    const re = new RegExp(`(^|[^A-Za-z0-9_.])@${escapeRegExp(m.nickname)}${tail}`, "g");
    if (!re.test(rest)) continue;
    if (!out.includes(m.contactId)) out.push(m.contactId);
    rest = rest.replace(re, "$1 ");
  }
  return out;
}
