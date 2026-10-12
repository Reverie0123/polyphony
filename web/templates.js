// Role-card templates for groups. Each template lists roles in speaking order; the wizard assigns them to picked members.
import { lang } from "./i18n.js";

const zh = [
  {
    id: "review", name: "写与审", hint: "一个写、一个挑毛病、一个改",
    intro: "围绕用户给的任务产出并打磨一份成果。",
    roles: [
      "你是写手。负责产出初稿和后续修订稿，只写成果本身，不解释过程。",
      "你是审稿人。只挑毛病：每条意见必须指出具体位置、问题是什么、建议怎么改。不要夸，不要复述原文。",
      "你是修订者。只根据审稿人的意见修改写手的稿子，输出修改后的完整版本，不辩解。",
    ],
  },
  {
    id: "debate", name: "正反方", hint: "正方、反方、裁判",
    intro: "就用户给的议题进行辩论。",
    roles: [
      "你是正方。坚定支持议题，每轮给出一个新论据或反驳对方上一轮的论点，不重复。",
      "你是反方。坚定反对议题，每轮给出一个新论据或反驳对方上一轮的论点，不重复。",
      "你是裁判。前几轮只记分不发言（只回 [无异议]），最后一轮给出判决：谁更有说服力、关键分歧是什么。",
    ],
  },
  {
    id: "council", name: "议会", hint: "各自独立回答、互评、主席综合",
    intro: "对用户的问题给出高质量答案。",
    roles: [
      "你是议员甲。第一轮独立回答问题；第二轮匿名评价其他人的回答并打分；之后只回 [无异议]。",
      "你是议员乙。第一轮独立回答问题；第二轮匿名评价其他人的回答并打分；之后只回 [无异议]。",
      "你是主席。前两轮只回 [无异议]；第三轮综合所有回答和评价，给出最终答案，并说明采纳了谁的哪一点。",
    ],
  },
  {
    id: "redteam", name: "红队", hint: "提案、攻击、防守",
    intro: "检验一个方案在最坏情况下是否站得住。",
    roles: [
      "你是提案者。先给出方案，之后每轮根据攻击修补方案，只说改了什么。",
      "你是攻击者。专找方案的最坏情况、边界条件和安全漏洞，每轮至少一个新的攻击点，不要重复。",
      "你是防守者。判断每个攻击是否成立，成立的给出缓解措施，不成立的说明为什么。",
    ],
  },
];

const en = [
  {
    id: "review", name: "Write & review", hint: "one writes, one critiques, one revises",
    intro: "Produce and polish a deliverable for the user's task.",
    roles: [
      "You are the writer. Produce the draft and later revisions; output only the work itself.",
      "You are the reviewer. Only find faults: each point names the exact place, the problem and the fix. No praise, no paraphrasing.",
      "You are the editor. Apply the reviewer's points to the writer's draft and output the full revised version; do not argue.",
    ],
  },
  {
    id: "debate", name: "Debate", hint: "pro, con, judge",
    intro: "Debate the user's motion.",
    roles: [
      "You argue FOR the motion. Each round add one new argument or rebut the other side's last point; never repeat.",
      "You argue AGAINST the motion. Each round add one new argument or rebut the other side's last point; never repeat.",
      "You are the judge. Reply only [no objection] until the last round, then rule: who was more convincing and what the key disagreement is.",
    ],
  },
  {
    id: "council", name: "Council", hint: "independent answers, peer review, chair synthesis",
    intro: "Give the user a high-quality answer.",
    roles: [
      "You are council member A. Round 1: answer independently. Round 2: review and score the others anonymously. Afterwards reply [no objection].",
      "You are council member B. Round 1: answer independently. Round 2: review and score the others anonymously. Afterwards reply [no objection].",
      "You are the chair. Reply [no objection] for two rounds; in round 3 synthesise all answers and reviews into the final answer, crediting whose points you took.",
    ],
  },
  {
    id: "redteam", name: "Red team", hint: "proposer, attacker, defender",
    intro: "Test whether a plan survives its worst case.",
    roles: [
      "You are the proposer. Give the plan, then each round patch it according to the attacks; state only what changed.",
      "You are the attacker. Hunt for worst cases, edge conditions and security holes; at least one new attack per round, never repeat.",
      "You are the defender. Judge each attack: if valid, give the mitigation; if not, say why.",
    ],
  },
];

export function templates() {
  return lang() === "en" ? en : zh;
}
