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
  required: ['id', 'pair', 'title', 'rationale', 'scores'],
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
    titles: {
      type: 'object',
      additionalProperties: false,
      properties: {
        douyin: { type: 'array', items: titleSchema, maxItems: 6 },
        bilibili: { type: 'array', items: titleSchema, maxItems: 6 },
      },
      required: ['douyin', 'bilibili'],
    },
  },
  required: ['source', 'note', 'overview', 'titles'],
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

export async function POST(request: Request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      { code: 'AI_NOT_CONFIGURED', message: '当前站点未配置 DeepSeek 服务端密钥，将使用本地规则分析。' },
      { status: 503 },
    );
  }

  let body: { transcript?: unknown; platforms?: unknown; tone?: unknown; duration?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: 'INVALID_JSON', message: '请求格式无效。' }, { status: 400 });
  }

  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  const platforms = Array.isArray(body.platforms) ? body.platforms.filter(isPlatform) : [];
  const tone: Tone = isTone(body.tone) ? body.tone : 'credible';
  const duration = typeof body.duration === 'number' && Number.isFinite(body.duration) ? body.duration : null;

  if (transcript.length < 80 || transcript.length > 24000 || platforms.length === 0) {
    return Response.json(
      { code: 'INVALID_INPUT', message: '请提供 80–24000 字的转写，并至少选择一个平台。' },
      { status: 400 },
    );
  }

  const instructions = `你是中文视频标题分析编辑。只能根据用户提供的转写得出结论，不能假装看过未提供的视频或听过音频。
分别为抖音和哔哩哔哩产出标题，不得套用同一公式：抖音版本更短、更口语化、单一钩子更明确；哔哩哔哩版本应保留主题词、信息范围和可搜索性，帮助用户判断完整观看价值。这些是编辑策略，不是平台算法事实。
平台合规底线优先：标题必须与转写内容相符，不得编造数字、权威背书、保证性效果、绝对化排名或剧情；对医疗、财经、法律等专业主张和无法从转写验证的确定性说法明确提示核验。
所有分数为0到100的编辑评估，不代表平台官方评分或流量预测。risk越高表示夸大或错配风险越高。每个平台产出6个标题，按1A/1B、2A/2B、3A/3B组成三组可测试替代。理由要具体且简短。未选择的平台返回空数组。`;

  try {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
        store: false,
        instructions,
        input: JSON.stringify({ transcript, platforms, tone, duration }),
        reasoning: { effort: 'none' },
        max_output_tokens: 5000,
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

    return Response.json(JSON.parse(outputText));
  } catch (error) {
    console.error('AI analysis error', error);
    return Response.json({ code: 'AI_ERROR', message: 'AI 分析遇到错误，将回退到本地规则分析。' }, { status: 502 });
  }
}
