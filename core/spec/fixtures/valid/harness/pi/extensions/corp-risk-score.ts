// 示例业务级增强：把企业风险评分注册成模型可调用的工具。
// 真实实现见 §4.5；此处只需存在且可被渲染器打包，用于验证「声明集合 == 已加载集合」这条硬断言。
export default function corpRiskScore(pi: { registerTool: (t: unknown) => void }) {
  pi.registerTool({
    name: "corp_risk_score",
    description: "按企业规则给一段文本打风险分",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }: { text: string }) => ({ score: text.length % 10 }),
  });
}
