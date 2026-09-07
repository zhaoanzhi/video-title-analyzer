import type { Platform, Tone } from '@/lib/analyzer';

export const runtime = 'edge';

const titleSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    pair: { type: 'string' },
    title: { type: 'string' },
    rationale: { type: 'string' },
    overall: { type: 'integer', minimum: 0, maximum: 100 },
    scores: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hook: { type: 'integer', minimum: 0, maximum: 100 },
        clarity: { type: 'integer', minimum: 0, maximum: 100 },
        match: { type: 'integer', minimum: 0, maximum: 100 },
        discovery: { type: 'integer', minimum: 0, maximum: 100 },
        curiosity: { type: 'integer', minimum: 0, maximum: 100 },
        risk: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['hook', 'clarity', 'match', 'discovery', 'curiosity', 'risk'],
    },
  },
  required: ['id', 'pair', 'title', 'rationale', 'scores', 'overall'],
};

const publishingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coverText: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    pinnedComment: { type: 'string' },
    timing: { type: 'string' },
  },
  required: ['coverText', 'description', 'tags', 'pinnedComment', 'timing'],
};

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', enum: ['ai'] },
    note: { type: 'string' },
    overview: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string' },
        audience: { type: 'string' },
        hook: { type: 'string' },
        conflict: { type: 'string' },
        turn: { type: 'string' },
        payoff: { type: 'string' },
        emotionalPhrases: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        cautionClaims: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        keywords: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      },
      required: ['subject', 'audience', 'hook', 'conflict', 'turn', 'payoff', 'emotionalPhrases', 'cautionClaims', 'keywords'],
    },
    sellingPoints: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          angle: { type: 'string' },
        },
        required: ['claim', 'evidence', 'angle'],
      },
    },
    titles: {
      type: 'object',
      additionalProperties: false,
      properties: {
        douyin: { type: 'array', items: titleSchema, maxItems: 10 },
        bilibili: { type: 'array', items: titleSchema, maxItems: 10 },
      },
      required: ['douyin', 'bilibili'],
    },
    publishing: {
      type: 'object',
      additionalProperties: false,
      properties: {
        douyin: publishingSchema,
        bilibili: publishingSchema,
      },
      required: ['douyin', 'bilibili'],
    },
  },
  required: ['source', 'note', 'overview', 'sellingPoints', 'titles', 'publishing'],
};

function isPlatform(value: unknown): value is Platform {
  return value === 'douyin' || value === 'bilibili';
}

function isTone(value: unknown): value is Tone {
  return value === 'credible' || value === 'conflict' || value === 'knowledge' || value === 'emotion';
}

function extractOutputText(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';

  const response = payload as {
    output_text?: unknown;
    output?: Array<{
      type?: unknown;
      content?: Array<{ type?: unknown; text?: unknown }>;
    }>;
  };

  if (typeof response.output_text === 'string') return response.output_text;

  return (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

function parseJsonOutput(outputText: string) {
  const trimmed = outputText.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    const objectStart = candidate.indexOf('{');
    const objectEnd = candidate.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }
    throw new SyntaxError('DeepSeek 返回的内容不是有效 JSON。');
  }
}

function clampScore(value: unknown) {
  const score = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function finalizeAnalysisResult(value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const result = value as { titles?: Record<string, Array<Record<string, unknown>>> };
  if (!result.titles) return value;

  for (const platform of ['douyin', 'bilibili'] as const) {
    const candidates = Array.isArray(result.titles[platform]) ? result.titles[platform] : [];
    result.titles[platform] = candidates
      .map((candidate) => {
        const scores = candidate.scores && typeof candidate.scores === 'object'
          ? candidate.scores as Record<string, unknown>
          : {};
        const hook = clampScore(scores.hook);
        const clarity = clampScore(scores.clarity);
        const match = clampScore(scores.match);
        const discovery = clampScore(scores.discovery);
        const curiosity = clampScore(scores.curiosity);
        const risk = clampScore(scores.risk);
        const positive = platform === 'douyin'
          ? hook * 0.24 + curiosity * 0.18 + clarity * 0.16 + match * 0.27 + discovery * 0.15
          : hook * 0.12 + curiosity * 0.14 + clarity * 0.22 + match * 0.3 + discovery * 0.22;
        return {
          ...candidate,
          scores: { hook, clarity, match, discovery, curiosity, risk },
          overall: clampScore(positive - risk * 0.22),
        };
      })
      .sort((a, b) => Number(b.overall) - Number(a.overall))
      .map((candidate, index) => ({ ...candidate, pair: `${index + 1}` }));
  }

  return result;
}

export async function POST(request: Request) {
  let body: { transcript?: unknown; platforms?: unknown; tone?: unknown; duration?: unknown; apiKey?: unknown; model?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: 'INVALID_JSON', message: '请求格式无效。' }, { status: 400 });
  }

  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  const platforms = Array.isArray(body.platforms) ? body.platforms.filter(isPlatform) : [];
  const tone: Tone = isTone(body.tone) ? body.tone : 'credible';
  const duration = typeof body.duration === 'number' && Number.isFinite(body.duration) ? body.duration : null;
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = body.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';

  if (apiKey.length < 20 || apiKey.length > 512) {
    return Response.json(
      { code: 'AI_NOT_CONFIGURED', message: '请先在网页右上角配置有效的 DeepSeek API 密钥。' },
      { status: 400 },
    );
  }

  if (transcript.length < 80 || transcript.length > 24000 || platforms.length === 0) {
    return Response.json(
      { code: 'INVALID_INPUT', message: '请提供 80–24000 字的转写，并至少选择一个平台。' },
      { status: 400 },
    );
  }

  const instructions = `你是中文视频发布编辑，按“证据提炼→分平台创作→独立审稿评分”的顺序工作。只能根据用户提供的转写得出结论，不能假装看过未提供的视频或听过音频。
第一步提炼3到5个真实内容卖点。每个卖点必须给出转写中的对应依据或忠实概括，并标明适合的传播角度；没有依据的卖点不要生成。
第二步使用两套完全独立的标题策略。抖音：12到30字优先，口语自然，一条标题只突出一个冲突、结果、场景或情绪钩子，避免堆关键词。哔哩哔哩：18到46字优先，明确主题、对象和信息范围，保留可搜索核心词，让用户判断完整观看价值。不得把同一句标题只换平台词后重复使用。
每个已选择的平台生成10个候选。第三步以审稿人视角分别给hook、clarity、match、discovery、curiosity、risk六项0到100分；match必须优先，risk越高表示夸大或错配风险越高。overall由服务端按平台权重重算，用于排序，模型只需给出合理初值。理由必须指出标题使用了哪个卖点、为何适合该平台以及主要风险。
为每个已选择的平台额外生成：2到3条封面大字、一段可直接发布的简介、最多8个标签、一条能引发具体讨论的置顶评论、发布时间建议。发布时间不得声称存在通用最佳时刻，应优先建议参考账号后台活跃数据与稳定更新习惯。未选择的平台标题返回空数组，其他字段仍返回简短占位内容。
平台合规底线优先：标题必须与转写内容相符，不得编造数字、权威背书、保证性效果、绝对化排名或剧情；对医疗、财经、法律等专业主张和无法从转写验证的确定性说法明确提示核验。
所有分数只是可解释的编辑评估，不代表平台官方评分或流量预测。`;

  try {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions,
        input: JSON.stringify({ transcript, platforms, tone, duration }),
        reasoning: { effort: 'none' },
        max_output_tokens: 8000,
        text: {
          format: {
            type: 'json_schema',
            name: 'video_title_analysis',
            schema: resultSchema,
          },
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('DeepSeek response failed', response.status, detail.slice(0, 500));
      return Response.json({ code: 'AI_UNAVAILABLE', message: 'AI 分析暂时不可用，将回退到本地规则分析。' }, { status: 502 });
    }

    const payload = await response.json();
    const outputText = extractOutputText(payload);
    if (!outputText) {
      return Response.json({ code: 'AI_EMPTY', message: 'AI 未返回可用结果，将回退到本地规则分析。' }, { status: 502 });
    }

    return Response.json(finalizeAnalysisResult(parseJsonOutput(outputText)));
  } catch (error) {
    console.error('AI analysis error', error);
    return Response.json({ code: 'AI_ERROR', message: 'AI 分析遇到错误，将回退到本地规则分析。' }, { status: 502 });
  }
}
