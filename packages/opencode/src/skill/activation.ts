// Deterministic skill activation scoring for Overcode.
//
// The model sees skill names + descriptions in guidance; this module answers
// "which skill does this request want?" WITHOUT an LLM round-trip so skill
// routing stays testable and cheap. Token-overlap with light weighting:
// name hits count more than description hits, exact-phrase hits most.
//
// This is the regression-test foundation for the skill ecosystem: if a new
// skill's description doesn't activate on its own trigger phrases, the eval
// fails and the author fixes the description (not the router).

export type ScoredSkill = {
  name: string
  score: number
}

export type SkillListing = {
  name: string
  description?: string
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,for,with,from,that,this,these,those,are,was,were,be,been,being,have,has,had,do,does,did,will,would,should,could,can,may,might,must,shall,of,to,in,on,at,by,as,is,it,its,into,over,under,when,what,which,who,whom,how,why,not,no,yes,if,then,than,too,very,just,also,only,use,using,used,me,my,you,your,please".split(
    ",",
  ),
)

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function phrases(value: string): string[] {
  const tokens = tokenize(value);
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function scoreSkill(skill: SkillListing, query: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const nameTokens = new Set(tokenize(skill.name.replaceAll("-", " ")));
  const descriptionTokens = new Set(tokenize(skill.description ?? ""));
  const descriptionPhrases = new Set(phrases(skill.description ?? ""));
  const queryPhrases = new Set(phrases(query));

  let score = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 3;
    else if (descriptionTokens.has(token)) score += 1;
  }
  for (const phrase of queryPhrases) {
    if (descriptionPhrases.has(phrase)) score += 2;
  }
  return score;
}

// Rank skills for a query, highest score first. Ties keep input order
// (stable), so guidance order is deterministic. Zero-score skills are
// dropped unless `includeZero` is set.
export function suggestSkills(skills: SkillListing[], query: string, limit = 5, includeZero = false): ScoredSkill[] {
  return skills
    .map((skill, index) => ({ name: skill.name, score: scoreSkill(skill, query), index }))
    .filter((item) => includeZero || item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ name, score }) => ({ name, score }));
}
