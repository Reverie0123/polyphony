// "@nickname" detection shared by the server (user text) and the orchestrator (model replies).

/** Finds mentioned members; longest nicknames first and consumed, so "小" does not also match inside "小 C". */
export function parseMentionsIn(text: string, members: { contactId: string; nickname: string }[]): string[] {
  const out: string[] = [];
  const sorted = [...members].filter((m) => m.nickname).sort((a, b) => b.nickname.length - a.nickname.length);
  let rest = text;
  for (const m of sorted) {
    const needle = "@" + m.nickname;
    if (!rest.includes(needle)) continue;
    if (!out.includes(m.contactId)) out.push(m.contactId);
    rest = rest.split(needle).join(" ");
  }
  return out;
}
