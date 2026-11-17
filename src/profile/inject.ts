/**
 * 用户画像注入
 * 将画像以简洁的形式注入到 S2，作为"我对你的理解"
 */

import type { UserProfile, ProfileItem, ProfileConfig } from "./types";

/**
 * 格式化单个画像项
 */
function formatProfileItem(item: ProfileItem, showConfidence: boolean = false): string {
  const confidenceStr = showConfidence ? ` (置信度: ${(item.confidence * 100).toFixed(0)}%)` : '';
  return `- ${item.content}${confidenceStr}`;
}

/**
 * 生成画像的 S2 注入文本
 */
export function generateProfileInjection(
  profile: UserProfile,
  config: ProfileConfig
): string {
  if (!config.enabled || !config.injectToS2) {
    return '';
  }
  
  const sections: string[] = [];
  
  // 标题
  sections.push('## 我对你的理解\n');
  
  // 总体摘要
  if (profile.summary && profile.summary !== '暂无画像信息。') {
    sections.push(profile.summary + '\n');
  }
  
  // 详细分类（按置信度选择 top items）
  const addSection = (title: string, items: ProfileItem[], maxItems: number = 3) => {
    if (items.length === 0) return;
    
    // 只显示高置信度的项
    const topItems = items
      .filter(item => item.confidence >= 0.6)
      .slice(0, maxItems);
    
    if (topItems.length > 0) {
      sections.push(`**${title}**`);
      sections.push(topItems.map(item => formatProfileItem(item)).join('\n'));
      sections.push('');
    }
  };
  
  addSection('偏好', profile.preferences, 3);
  addSection('目标', profile.goals, 2);
  addSection('沟通风格', profile.communicationStyle, 2);
  addSection('边界', profile.boundaries, 2);
  addSection('关系', profile.relationship, 1);
  
  // 组装最终文本
  let text = sections.join('\n').trim();
  
  // 控制预算
  if (text.length > config.s2Budget.max) {
    // 截断到最大预算
    text = text.substring(0, config.s2Budget.max - 3) + '...';
  }
  
  // 确保至少达到最小预算（如果有内容）
  if (text.length > 0 && text.length < config.s2Budget.min) {
    // 已经是最精简版本，不需要填充
  }
  
  return text;
}

/**
 * 生成详细的画像文本（用于 UI 展示）
 */
export function generateDetailedProfile(profile: UserProfile): string {
  const sections: string[] = [];
  
  sections.push('# 用户画像\n');
  sections.push(`生成时间：${new Date(profile.generatedAt).toLocaleString()}`);
  sections.push(`基于记忆数：${profile.baseMemoryCount}\n`);
  
  sections.push('## 总体摘要\n');
  sections.push(profile.summary + '\n');
  
  const addDetailedSection = (title: string, items: ProfileItem[]) => {
    if (items.length === 0) return;
    
    sections.push(`## ${title}\n`);
    for (const item of items) {
      sections.push(`### ${item.content}\n`);
      sections.push(`- **来源**: ${item.source}`);
      sections.push(`- **置信度**: ${(item.confidence * 100).toFixed(0)}%`);
      sections.push(`- **证据数**: ${item.evidenceIds.length}`);
      sections.push(`- **最后确认**: ${new Date(item.lastConfirmedAt).toLocaleString()}`);
      if (item.expiresAt) {
        sections.push(`- **过期时间**: ${new Date(item.expiresAt).toLocaleString()}`);
      }
      sections.push('');
    }
  };
  
  addDetailedSection('偏好', profile.preferences);
  addDetailedSection('目标', profile.goals);
  addDetailedSection('沟通风格', profile.communicationStyle);
  addDetailedSection('边界', profile.boundaries);
  addDetailedSection('关系', profile.relationship);
  
  return sections.join('\n');
}

/**
 * 生成简洁的画像文本（用于快速查看）
 */
export function generateBriefProfile(profile: UserProfile): string {
  const sections: string[] = [];
  
  const addBriefSection = (emoji: string, title: string, items: ProfileItem[], maxItems: number = 5) => {
    if (items.length === 0) return;
    
    sections.push(`${emoji} **${title}**`);
    const topItems = items.slice(0, maxItems);
    for (const item of topItems) {
      sections.push(`  • ${item.content}`);
    }
    sections.push('');
  };
  
  addBriefSection('💭', '偏好', profile.preferences);
  addBriefSection('🎯', '目标', profile.goals);
  addBriefSection('💬', '沟通风格', profile.communicationStyle);
  addBriefSection('🚫', '边界', profile.boundaries);
  addBriefSection('🤝', '关系', profile.relationship);
  
  return sections.join('\n');
}
