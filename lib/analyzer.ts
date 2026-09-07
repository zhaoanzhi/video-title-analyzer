export type Platform = 'douyin' | 'bilibili';
export type Tone = 'credible' | 'conflict' | 'knowledge' | 'emotion';

export type TitleScores = {
  hook: number;
  clarity: number;
  match: number;
  discovery: number;
  curiosity: number;
  risk: number;
};

export type TitleCandidate = {
  id: string;
  pair: string;
  title: string;
  rationale: string;
  scores: TitleScores;
  overall: number;
};

export type PublishingPack = {
  coverText: string[];
  description: string;
  tags: string[];
  pinnedComment: string;
  timing: string;
};

export type AnalysisResult = {
  source: 'local' | 'ai';
  note?: string;
  overview: {
    subject: string;
    audience: string;
    hook: string;
    conflict: string;
    turn: string;
    payoff: string;
    emotionalPhrases: string[];
    cautionClaims: string[];
    keywords: string[];
  };
  sellingPoints: Array<{
    claim: string;
    evidence: string;
    angle: string;
  }>;
  titles: Record<Platform, TitleCandidate[]>;
  publishing: Record<Platform, PublishingPack>;
};

type AnalyzeInput = {
  transcript: string;
  tone: Tone;
  platforms: Platform[];
  duration?: number | null;
  iteration?: number;
};

const stopWords = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '一种', '其实', '就是', '因为', '所以',
  '然后', '但是', '如果', '还是', '可以', '可能', '已经', '没有', '不是', '这样', '现在',
  '时候', '什么', '怎么', '为什么', '今天', '大家', '自己', '非常', '真的', '觉得', '进行',
  '视频', '内容', '事情', '问题', '最后', '这里', '一下', '那么', '很多', '比较', '需要',
]);

const contrastPattern = /但是|却|反而|没想到|真正|关键|结果|直到|原来|问题在于|区别|误区|代价/;
const emotionPattern = /惊讶|意外|焦虑|后悔|遗憾|开心|激动|崩溃|难受|害怕|希望|治愈|感动|真相|终于|值得/;
const cautionPattern = /\d+(?:\.\d+)?%|百分之|保证|一定|必然|绝对|唯一|第一|最强|永久|彻底|根治|暴涨|稳赚|人人|所有人|零风险|无副作用|官方认证|权威证明/;
const domainCautionPattern = /医疗|药物|疾病|治疗|投资|股票|基金|收益|法律|诉讼|保险|贷款|减肥|功效/;

function cleanText(value: string) {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function splitSentences(text: string) {
  return cleanText(text)
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim().replace(/^[，、,:：\s]+|[，、,:：\s]+$/g, ''))
    .filter((sentence) => sentence.length >= 4);
}

function trimPhrase(text: string, max = 30) {
  const value = text.replace(/[“”"'《》【】]/g, '').replace(/\s+/g, '').replace(/[。！？!?；;]+$/g, '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function extractKeywords(text: string, sentences: string[]) {
  const scores = new Map<string, number>();
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  let index = 0;

  for (const segment of segmenter.segment(text)) {
    const token = segment.segment.trim();
    if (!segment.isWordLike || token.length < 2 || token.length > 12 || stopWords.has(token) || /^\d+$/.test(token)) continue;
    const base = /^[A-Za-z]/.test(token) ? 4 : 2;
    const firstThirdBonus = index < text.length / 3 ? 2 : 0;
    scores.set(token, (scores.get(token) ?? 0) + base + firstThirdBonus);
    index += token.length;
  }

  for (const sentence of sentences.slice(0, 3)) {
    for (const phrase of sentence.match(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9+.-]{2,}/g) ?? []) {
      if (!stopWords.has(phrase)) scores.set(phrase, (scores.get(phrase) ?? 0) + 1);
    }
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([token]) => token)
    .filter((token, position, all) => !all.slice(0, position).some((picked) => picked.includes(token) || token.includes(picked)));

  return ranked.slice(0, 6).length ? ranked.slice(0, 6) : [trimPhrase(sentences[0] || '这段内容', 8)];
}

function sentenceScore(sentence: string, position: number, total: number, kind: 'hook' | 'conflict' | 'emotion') {
  let score = Math.min(sentence.length, 42);
  if (/\d/.test(sentence)) score += 8;
  if (/[？?]/.test(sentence)) score += 12;
  if (contrastPattern.test(sentence)) score += kind === 'conflict' ? 22 : 10;
  if (emotionPattern.test(sentence)) score += kind === 'emotion' ? 24 : 8;
  if (kind === 'hook' && position / Math.max(total, 1) < 0.28) score += 16;
  if (kind === 'conflict' && position / Math.max(total, 1) > 0.15 && position / Math.max(total, 1) < 0.76) score += 10;
  return score;
}

function pickBest(sentences: string[], kind: 'hook' | 'conflict' | 'emotion', range?: [number, number]) {
  const start = range ? Math.floor(sentences.length * range[0]) : 0;
  const end = range ? Math.max(start + 1, Math.ceil(sentences.length * range[1])) : sentences.length;
  const slice = sentences.slice(start, end);
  return slice
    .map((sentence, localIndex) => ({ sentence, score: sentenceScore(sentence, start + localIndex, sentences.length, kind) }))
    .sort((a, b) => b.score - a.score)[0]?.sentence || sentences[0] || '转写信息不足';
}

function inferAudience(text: string) {
  const matches: Array<[RegExp, string]> = [
    [/职场|面试|老板|同事|加班|工作|管理/, '职场从业者与管理者'],
    [/创业|生意|客户|营销|品牌|运营|销售/, '创业者、经营者与内容运营者'],
    [/学习|考试|课程|知识|方法|教程|技巧/, '希望快速学会一套方法的人'],
    [/科技|AI|软件|产品|代码|工具/, '关注科技与效率工具的用户'],
    [/健身|饮食|减肥|健康|睡眠|运动/, '关注健康与生活方式的人'],
    [/旅行|城市|景点|酒店|美食/, '正在做出行或消费决策的人'],
    [/情感|关系|婚姻|恋爱|朋友|家庭/, '关注关系与情绪议题的用户'],
    [/财经|投资|股票|基金|市场/, '关注财经信息的用户（需核验资质与依据）'],
  ];
  return matches.find(([pattern]) => pattern.test(text))?.[1] ?? '对该主题有现实问题、希望快速获得结论的用户';
}

function safeTitlePart(value: string, max = 18) {
  return trimPhrase(value, max).replace(/[，。！？!?：:；;]/g, '、').replace(/…$/, '');
}

function scoreTitle(title: string, platform: Platform, keywords: string[], sourceSentences: string[]): TitleScores {
  const keywordHits = keywords.filter((keyword) => title.includes(keyword)).length;
  const risky = cautionPattern.test(title);
  const supported = sourceSentences.some((sentence) => {
    const core = title.replace(/[，。！？!?：:；;、]/g, '');
    return core.length >= 6 && (sentence.includes(core.slice(0, 6)) || keywords.some((keyword) => title.includes(keyword) && sentence.includes(keyword)));
  });
  const idealLength = platform === 'douyin' ? [12, 28] : [18, 42];
  const lengthFit = title.length >= idealLength[0] && title.length <= idealLength[1];

  return {
    hook: clamp(58 + (/为什么|别急|真正|原来|没想到|？/.test(title) ? 19 : 7) + (lengthFit ? 8 : 0)),
    clarity: clamp(61 + keywordHits * 8 + (/[：，]/.test(title) ? 6 : 0) - (title.length > idealLength[1] ? 14 : 0)),
    match: clamp(56 + keywordHits * 13 + (supported ? 12 : 0)),
    discovery: clamp(platform === 'bilibili' ? 58 + keywordHits * 12 + (/[：]/.test(title) ? 7 : 0) : 48 + keywordHits * 8),
    curiosity: clamp(55 + (/为什么|别急|原来|没想到|真正|？/.test(title) ? 22 : 6) + (contrastPattern.test(title) ? 7 : 0)),
    risk: clamp(8 + (risky ? 42 : 0) + (!supported ? 12 : 0)),
  };
}

function titleRationale(title: string, platform: Platform, keywords: string[], scores: TitleScores) {
  const hit = keywords.find((keyword) => title.includes(keyword));
  const shape = platform === 'douyin'
    ? '用单一冲突或结论切入，适合快速扫读'
    : '保留主题词和信息范围，便于用户判断是否值得完整观看';
  const caution = scores.risk >= 35 ? '；发布前需核对其中的确定性表达' : '；未加入无法从转写验证的承诺';
  return `${shape}${hit ? `，核心词是“${hit}”` : ''}${caution}。`;
}

function overallScore(scores: TitleScores, platform: Platform) {
  const positive = platform === 'douyin'
    ? scores.hook * 0.24 + scores.curiosity * 0.18 + scores.clarity * 0.16 + scores.match * 0.27 + scores.discovery * 0.15
    : scores.hook * 0.12 + scores.curiosity * 0.14 + scores.clarity * 0.22 + scores.match * 0.3 + scores.discovery * 0.22;
  return clamp(positive - scores.risk * 0.22);
}

function buildTitleTexts(platform: Platform, tone: Tone, iteration: number, parts: {
  topic: string;
  keyword2: string;
  hook: string;
  conflict: string;
  payoff: string;
  minutes: string;
}) {
  const { topic, keyword2, hook, conflict, payoff, minutes } = parts;
  const toneLead: Record<Tone, string> = {
    credible: '真正值得注意的',
    conflict: '别再只看表面',
    knowledge: '一次讲清',
    emotion: '直到最后才明白',
  };
  const lead = toneLead[tone];

  const douyinSets = [
    [
      `${topic}，真正关键的是${payoff}`,
      `别急着下结论：${hook}`,
      `${minutes}分钟讲清${topic}，重点在${keyword2}`,
      `为什么${topic}总被误解？${conflict}`,
      `原来${topic}的转折，藏在${payoff}`,
      `${lead}${topic}：${keyword2}`,
      `${topic}最容易忽略的，其实是${keyword2}`,
      `做${topic}之前，先看懂${conflict}`,
      `${hook}？真正的答案是${payoff}`,
      `${topic}别讲复杂，抓住${keyword2}就够了`,
    ],
    [
      `关于${topic}，先记住${payoff}`,
      `${hook}，答案和想象的不一样`,
      `${topic}别只看开头，关键是${conflict}`,
      `想看懂${topic}，先分清${keyword2}`,
      `${minutes}分钟后，我对${topic}改观了`,
      `${lead}，其实是${payoff}`,
      `${topic}卡住你的，不一定是${keyword2}`,
      `先别照搬方法：${conflict}`,
      `${topic}做到最后，拼的是${payoff}`,
      `如果你也在做${topic}，记住${keyword2}`,
    ],
  ];

  const biliSets = [
    [
      `${topic}完整拆解：从${hook}到${payoff}`,
      `${minutes}分钟讲清${topic}：${keyword2}、关键转折与结论`,
      `${topic}为什么会这样？一次讲透${conflict}`,
      `复盘${topic}：最强开场、关键转折与最后结论`,
      `关于${topic}，真正需要看懂的是${payoff}`,
      `${lead}${topic}：一份有依据的内容梳理`,
      `${topic}实操复盘：${keyword2}为什么比想象中更重要`,
      `从${hook}到${payoff}：${topic}的完整逻辑`,
      `${topic}常见误区：问题不只在${keyword2}`,
      `${topic}方法论：如何找到关键冲突并完成收束`,
    ],
    [
      `${topic}到底在讲什么？从${keyword2}到最终结论的完整梳理`,
      `看完再判断：${topic}中的${conflict}`,
      `${topic}深度复盘：开场问题、过程转折与${payoff}`,
      `${minutes}分钟看懂${topic}，以及它为什么与${keyword2}有关`,
      `拆解${topic}：哪些信息重要，哪些说法需要谨慎`,
      `${lead}${topic}，结论并不是一句口号`,
      `${topic}案例分析：从开场问题到最终回报`,
      `为什么${topic}容易失效？关键环节完整拆解`,
      `${topic}的判断框架：${keyword2}、转折与结论`,
      `认真聊聊${topic}：方法、边界和可验证的结论`,
    ],
  ];

  const sets = platform === 'douyin' ? douyinSets : biliSets;
  return sets[iteration % sets.length].map((title) => trimPhrase(title, platform === 'douyin' ? 31 : 48));
}

function makeTitles(platform: Platform, tone: Tone, iteration: number, parts: Parameters<typeof buildTitleTexts>[3], keywords: string[], sentences: string[]) {
  return buildTitleTexts(platform, tone, iteration, parts).map((title, index) => {
    const scores = scoreTitle(title, platform, keywords, sentences);
    return {
      id: `${platform}-${iteration}-${index}`,
      pair: `${Math.floor(index / 2) + 1}${index % 2 === 0 ? 'A' : 'B'}`,
      title,
      rationale: titleRationale(title, platform, keywords, scores),
      scores,
      overall: overallScore(scores, platform),
    };
  })
    .sort((a, b) => b.overall - a.overall)
    .map((candidate, index) => ({ ...candidate, pair: `${index + 1}` }));
}

export function analyzeLocally(input: AnalyzeInput): AnalysisResult {
  const text = cleanText(input.transcript);
  const sentences = splitSentences(text);
  const keywords = extractKeywords(text, sentences);
  const hook = pickBest(sentences, 'hook', [0, 0.32]);
  const conflict = pickBest(sentences, 'conflict', [0.12, 0.74]);
  const turn = pickBest(sentences, 'conflict', [0.38, 0.68]);
  const payoff = sentences.slice(-3).sort((a, b) => sentenceScore(b, 1, 1, 'conflict') - sentenceScore(a, 1, 1, 'conflict'))[0] || sentences.at(-1) || hook;
  const emotionalPhrases = [...sentences]
    .map((sentence, index) => ({ sentence, score: sentenceScore(sentence, index, sentences.length, 'emotion') }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ sentence }) => trimPhrase(sentence, 42));
  const cautionClaims = sentences
    .filter((sentence) => cautionPattern.test(sentence) || domainCautionPattern.test(sentence))
    .slice(0, 5)
    .map((sentence) => trimPhrase(sentence, 52));

  const topic = safeTitlePart(keywords[0] || hook, 12);
  const keyword2 = safeTitlePart(keywords[1] || conflict, 13);
  const titleParts = {
    topic,
    keyword2,
    hook: safeTitlePart(hook, 15),
    conflict: safeTitlePart(conflict, 16),
    payoff: safeTitlePart(payoff, 16),
    minutes: input.duration && input.duration > 0 ? `${Math.max(1, Math.round(input.duration / 60))}` : '3',
  };
  const description = `${trimPhrase(hook, 54)}。${trimPhrase(conflict, 54)}。${trimPhrase(payoff, 54)}。`;
  const tags = keywords.slice(0, 5);
  const sellingPoints = [
    { claim: trimPhrase(hook, 48), evidence: '来自转写开头与前段的高信息密度表述。', angle: '开场问题' },
    { claim: trimPhrase(conflict, 48), evidence: '来自转写中出现反差、误区或关键判断的位置。', angle: '核心冲突' },
    { claim: trimPhrase(payoff, 48), evidence: '来自转写结尾附近能够收束全文的结论。', angle: '观看回报' },
  ];

  return {
    source: 'local',
    note: '基于你提供的转写做本地结构与词面分析；没有声称理解未提供的音频，也没有上传视频。',
    overview: {
      subject: `围绕“${topic}”展开，主要涉及${keywords.slice(1, 4).map((item) => `“${item}”`).join('、') || '转写中的核心信息'}。`,
      audience: inferAudience(text),
      hook: trimPhrase(hook, 58),
      conflict: trimPhrase(conflict, 58),
      turn: trimPhrase(turn, 58),
      payoff: trimPhrase(payoff, 58),
      emotionalPhrases,
      cautionClaims: cautionClaims.length ? cautionClaims : ['未检测到明显的绝对化、效果承诺或高风险专业领域表述。'],
      keywords,
    },
    sellingPoints,
    titles: {
      douyin: input.platforms.includes('douyin') ? makeTitles('douyin', input.tone, input.iteration ?? 0, titleParts, keywords, sentences) : [],
      bilibili: input.platforms.includes('bilibili') ? makeTitles('bilibili', input.tone, input.iteration ?? 0, titleParts, keywords, sentences) : [],
    },
    publishing: {
      douyin: {
        coverText: [trimPhrase(hook, 12), trimPhrase(payoff, 12)],
        description,
        tags,
        pinnedComment: `你在“${topic}”这件事上，最容易卡在哪一步？`,
        timing: '优先参考你账号后台的粉丝活跃时段；暂无数据时，可先测试午间与晚间两个固定时段。',
      },
      bilibili: {
        coverText: [trimPhrase(topic, 10), trimPhrase(keyword2, 12)],
        description: `${description}\n本期围绕${topic}，梳理关键问题、过程转折与最终结论。`,
        tags,
        pinnedComment: `这期关于“${topic}”的哪个判断最值得继续展开？欢迎留下你的具体问题。`,
        timing: '优先参考创作中心的观众活跃数据；保持栏目更新时间稳定，比套用通用“最佳时间”更可靠。',
      },
    },
  };
}
