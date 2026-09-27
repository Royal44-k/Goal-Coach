import type { GoalCategory } from "@/core/domain/contracts";

export type LifecycleScenario = {
  id: "learning" | "light_work";
  category: GoalCategory;
  intake: string;
  contractPrompt: string;
  planPrompt: string;
  blockerPrompt: string;
  replanPrompt: string;
  contract: {
    title: string; category: GoalCategory; desiredOutcome: string; definitionOfDone: string;
    deadline: string; weeklyMinutes: number; constraints: string[]; motivation: string;
  };
  tasks: readonly { title: string; action: string; doneCriteria: string; estimateMinutes: number }[];
};

function dateAfter(now: Date, days: number) {
  const value = new Date(now);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function lifecycleScenarios(now: Date): LifecycleScenario[] {
  return [
    {
      id: "learning", category: "learning",
      intake: `我想在四周内学习 TypeScript，每周有 4 小时。截止 ${dateAfter(now, 28)}，交付一个可运行的待办网页，支持新增、完成、删除和刷新后保留数据。`,
      contractPrompt: "请根据上面的目标、每周时间和验收标准提出完整目标契约草案。",
      planPrompt: "请为已批准的目标提出可执行计划草案。",
      blockerPrompt: "我已经记录了卡点，请分析原因并建议一个最小下一步。",
      replanPrompt: "请根据已记录的卡点和每周时间变化提出计划调整草案，保留已完成的证据。",
      contract: {
        title: "四周完成 TypeScript 待办网页", category: "learning",
        desiredOutcome: "在四周内学会 TypeScript 并做出可运行的待办网页",
        definitionOfDone: "待办网页支持新增、完成、删除，刷新后仍保留数据，并记录验证结果",
        deadline: dateAfter(now, 28), weeklyMinutes: 240,
        constraints: ["每周最多四小时", "仅使用合成示例数据"], motivation: "形成可展示的学习作品",
      },
      tasks: [
        { title: "练习 TypeScript 类型", action: "用合成待办数据编写 Todo 类型和类型检查示例。", doneCriteria: "示例通过类型检查并记录运行结果。", estimateMinutes: 60 },
        { title: "实现待办交互", action: "实现新增、完成和删除待办项的交互。", doneCriteria: "合成待办项可新增、完成和删除。", estimateMinutes: 90 },
        { title: "验证刷新后保留", action: "保存待办数据并刷新页面验证。", doneCriteria: "刷新后合成待办项和完成状态保留。", estimateMinutes: 90 },
      ],
    },
    {
      id: "light_work", category: "light_work",
      intake: `我想在两周内用合成的团队会议样本完成整理演练，每周可投入 3 小时。截止 ${dateAfter(now, 14)}，交付可检索的演练目录，包含决议、负责人和待办项，并用合成样本验证。`,
      contractPrompt: "请根据上面的交付物、期限和时间容量提出完整目标契约草案。",
      planPrompt: "请为已批准的轻工作目标提出可执行计划草案。",
      blockerPrompt: "我已经记录了资料整理卡点，请分析并建议一个最小下一步。",
      replanPrompt: "请依据已记录的阻碍和可用时间变化调整计划，保留已完成的整理证据。",
      contract: {
        title: "两周整理会议摘要目录", category: "light_work",
        desiredOutcome: "两周内交付可检索的团队会议摘要目录",
        definitionOfDone: "目录覆盖合成会议记录的决议、负责人和待办项，能按主题查找",
        deadline: dateAfter(now, 14), weeklyMinutes: 180,
        constraints: ["每周最多三小时", "只使用合成会议记录"], motivation: "减少查找行动项的时间",
      },
      tasks: [
        { title: "整理记录样本", action: "归集合成会议记录并标记主题。", doneCriteria: "每份合成记录都有主题和日期。", estimateMinutes: 45 },
        { title: "提取决议与负责人", action: "从合成记录提取决议、负责人和行动项。", doneCriteria: "目录中的每项决议都有负责人和行动项。", estimateMinutes: 75 },
        { title: "验证目录检索", action: "按主题搜索合成目录并核对结果。", doneCriteria: "能按主题找回相应决议和行动项。", estimateMinutes: 60 },
      ],
    },
  ];
}
