'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  CircleGauge,
  Clipboard,
  FileVideo2,
  Film,
  Info,
  LoaderCircle,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Target,
  UploadCloud,
  Users,
  WandSparkles,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { analyzeLocally, type AnalysisResult, type Platform, type TitleCandidate, type Tone } from '@/lib/analyzer';

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: {
        name: string;
        title?: string;
        description: string;
        inputSchema: object;
        annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
        execute: (input: unknown) => unknown;
      }, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
  }
}

type Frame = { src: string; at: number };
type VideoMeta = {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  frames: Frame[];
};

type AnalysisState = 'idle' | 'analyzing' | 'done' | 'error';

const toneOptions: Array<{ value: Tone; label: string; hint: string }> = [
  { value: 'credible', label: '克制可信', hint: '清楚，不冒进' },
  { value: 'conflict', label: '冲突更强', hint: '突出反差' },
  { value: 'knowledge', label: '知识密度', hint: '强调信息增量' },
  { value: 'emotion', label: '情绪共鸣', hint: '保留真实情绪' },
];

const exampleTranscript = `很多人以为，做内容最难的是剪辑，其实真正卡住创作者的，往往是没有在开头说清楚“为什么值得看”。我曾经花三个小时改一条片子，数据还是没有变化。后来我把前十五秒拆开看，发现开场只有背景，没有问题；只有过程，没有结果预告。于是我做了一个调整：先给出观众正在经历的具体场景，再点出一个反常识的判断，最后明确这条视频会给出什么答案。需要注意的是，这不是一个保证流量的公式，也不是所谓平台算法内幕。它更像是帮助观众降低理解成本。中段最重要的转折，是要把开头提出的问题用证据接回来，而不是不断增加新的悬念。结尾也不能只说“关注我”，要把前面的冲突收束成一个能被带走的结论。对创作者来说，标题的任务不是夸大，而是让合适的人在一秒内看懂：这条内容和我有什么关系，我能得到什么。`;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function durationMessage(duration: number) {
  if (duration >= 150 && duration <= 270) return { text: '接近 3–4 分钟，处于建议分析区间', tone: 'good' as const };
  if (duration < 90) return { text: '视频偏短，仍可分析，但结构节点会更密集', tone: 'warn' as const };
  if (duration > 480) return { text: '视频较长，本工具仍会抽帧，但标题策略按短中视频处理', tone: 'warn' as const };
  return { text: '时长接近建议区间，可正常分析', tone: 'good' as const };
}

async function waitForEvent(target: HTMLVideoElement, event: 'loadedmetadata' | 'seeked', timeout = 8000) {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('读取视频超时'));
    }, timeout);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('浏览器无法读取此视频编码'));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onDone);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onDone, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function inspectVideo(file: File): Promise<VideoMeta> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForEvent(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const points = [0.06, 0.27, 0.5, 0.73, 0.94];
    const canvas = document.createElement('canvas');
    const maxWidth = 360;
    const ratio = Math.min(1, maxWidth / Math.max(video.videoWidth, 1));
    canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
    const context = canvas.getContext('2d');
    const frames: Frame[] = [];

    if (context && duration > 0) {
      for (const point of points) {
        const at = Math.min(Math.max(duration * point, 0), Math.max(duration - 0.08, 0));
        video.currentTime = at;
        await waitForEvent(video, 'seeked');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({ src: canvas.toDataURL('image/jpeg', 0.68), at });
      }
    }

    return {
      name: file.name,
      size: file.size,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      frames,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function Metric({ label, value, risk = false }: { label: string; value: number; risk?: boolean }) {
  const indicatorClass = risk
    ? value >= 40
      ? '[&_[data-slot=progress-indicator]]:bg-orange-400'
      : '[&_[data-slot=progress-indicator]]:bg-emerald-400'
    : '[&_[data-slot=progress-indicator]]:bg-cyan-300';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
        <span>{label}</span>
        <span className={risk && value >= 40 ? 'font-semibold text-orange-300' : 'font-mono text-slate-300'}>{value}</span>
      </div>
      <Progress value={value} aria-label={`${label} ${value} 分`} className={indicatorClass} />
    </div>
  );
}

function TitleCard({ item, featured, onCopy, copied }: { item: TitleCandidate; featured?: boolean; onCopy: () => void; copied: boolean }) {
  return (
    <article className={`relative overflow-hidden rounded-2xl border p-5 transition-colors ${featured ? 'border-cyan-300/45 bg-cyan-300/[0.055]' : 'border-slate-700/80 bg-slate-900/45 hover:border-slate-600'}`}>
      {featured && <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />}
      <div className="flex items-start gap-3">
        <Badge variant="outline" className={featured ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-200' : 'border-slate-600 text-slate-300'}>{item.pair}</Badge>
        <div className="min-w-0 flex-1">
          <h4 className="text-[1.05rem] font-semibold leading-7 tracking-tight text-white">{item.title}</h4>
          <p className="mt-2 text-sm leading-6 text-slate-400">{item.rationale}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onCopy} aria-label={`复制标题：${item.title}`} className="text-slate-400 hover:bg-slate-800 hover:text-white">
          {copied ? <Check className="text-emerald-300" /> : <Clipboard />}
        </Button>
      </div>
      <div className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="钩子强度" value={item.scores.hook} />
        <Metric label="清晰度" value={item.scores.clarity} />
        <Metric label="内容匹配" value={item.scores.match} />
        <Metric label="搜索 / 发现" value={item.scores.discovery} />
        <Metric label="好奇心" value={item.scores.curiosity} />
        <Metric label="夸大错配风险" value={item.scores.risk} risk />
      </div>
    </article>
  );
}

function PlatformResults({ platform, items, copiedId, onCopy }: { platform: Platform; items: TitleCandidate[]; copiedId: string | null; onCopy: (item: TitleCandidate) => void }) {
  if (!items.length) return null;
  const isDouyin = platform === 'douyin';
  return (
    <section aria-labelledby={`${platform}-heading`} className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className={`grid size-8 place-items-center rounded-lg ${isDouyin ? 'bg-white text-black' : 'bg-[#00aeec] text-white'}`} aria-hidden="true">
              {isDouyin ? <Zap className="size-4" /> : <Film className="size-4" />}
            </span>
            <h3 id={`${platform}-heading`} className="text-xl font-semibold text-white">{isDouyin ? '抖音标题' : '哔哩哔哩标题'}</h3>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            {isDouyin
              ? '编辑策略：更短、更口语化，用一个明确冲突或收益点完成快速理解。'
              : '编辑策略：保留主题词、信息范围和观看价值，兼顾站内搜索与长期发现。'}
            <span className="text-slate-500"> 这是创作方法，不是平台算法事实。</span>
          </p>
        </div>
        <Badge variant="outline" className="border-slate-700 bg-slate-900/60 text-slate-400">3 组 A/B · 分数为编辑评估</Badge>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {items.map((item, index) => (
          <TitleCard key={item.id} item={item} featured={index === 0} copied={copiedId === item.id} onCopy={() => onCopy(item)} />
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const [transcript, setTranscript] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>(['douyin', 'bilibili']);
  const [tone, setTone] = useState<Tone>('credible');
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [videoState, setVideoState] = useState<'idle' | 'reading' | 'ready' | 'error'>('idle');
  const [videoError, setVideoError] = useState('');
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle');
  const [analysisError, setAnalysisError] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [iteration, setIteration] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const transcriptCount = transcript.replace(/\s/g, '').length;
  const canAnalyze = transcriptCount >= 80 && platforms.length > 0 && analysisState !== 'analyzing';
  const durationInfo = videoMeta ? durationMessage(videoMeta.duration) : null;

  const togglePlatform = (platform: Platform) => {
    setPlatforms((current) => current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform]);
  };

  const performAnalysis = useCallback(async (params: {
    transcriptValue: string;
    platformValues: Platform[];
    toneValue: Tone;
    duration?: number | null;
    nextIteration?: number;
    scroll?: boolean;
  }) => {
    const count = params.transcriptValue.replace(/\s/g, '').length;
    if (count < 80) throw new Error('转写至少需要 80 个有效字符，才能形成可靠的结构分析。');
    if (!params.platformValues.length) throw new Error('请至少选择一个发布平台。');

    setAnalysisState('analyzing');
    setAnalysisError('');
    const fallback = analyzeLocally({
      transcript: params.transcriptValue,
      tone: params.toneValue,
      platforms: params.platformValues,
      duration: params.duration,
      iteration: params.nextIteration ?? 0,
    });

    let nextResult = fallback;
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: params.transcriptValue,
          platforms: params.platformValues,
          tone: params.toneValue,
          duration: params.duration,
        }),
      });
      if (response.ok) {
        nextResult = await response.json() as AnalysisResult;
      } else {
        const detail = await response.json().catch(() => null) as { message?: string } | null;
        nextResult = { ...fallback, note: detail?.message ? `${detail.message} ${fallback.note}` : fallback.note };
      }
    } catch {
      nextResult = { ...fallback, note: `网络或服务端暂不可用，已自动使用本地规则分析。${fallback.note}` };
    }

    setResult(nextResult);
    setAnalysisState('done');
    if (params.scroll !== false) {
      window.setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    }
    return nextResult;
  }, []);

  const handleAnalyze = async (nextIteration = iteration) => {
    try {
      await performAnalysis({
        transcriptValue: transcript,
        platformValues: platforms,
        toneValue: tone,
        duration: videoMeta?.duration,
        nextIteration,
      });
    } catch (error) {
      setAnalysisState('error');
      setAnalysisError(error instanceof Error ? error.message : '无法开始分析，请检查输入。');
    }
  };

  const handleVideo = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setVideoState('error');
      setVideoError('请选择常见视频文件（MP4、WebM 或 MOV）。');
      return;
    }
    setVideoState('reading');
    setVideoError('');
    setVideoMeta(null);
    try {
      const meta = await inspectVideo(file);
      setVideoMeta(meta);
      setVideoState('ready');
    } catch (error) {
      setVideoState('error');
      setVideoError(error instanceof Error ? error.message : '无法读取视频。你仍可直接粘贴转写继续分析。');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const regenerate = () => {
    const next = iteration + 1;
    setIteration(next);
    void handleAnalyze(next);
  };

  const copyTitle = async (item: TitleCandidate) => {
    await navigator.clipboard.writeText(item.title);
    setCopiedId(item.id);
    window.setTimeout(() => setCopiedId(null), 1600);
  };

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const isValidTone = (value: unknown): value is Tone => toneOptions.some((option) => option.value === value);
    const isValidPlatform = (value: unknown): value is Platform => value === 'douyin' || value === 'bilibili';

    void Promise.resolve(context.registerTool({
      name: 'analyze_video_transcript',
      title: '分析视频转写并生成标题',
      description: '使用页面的真实分析流程，分析中文视频转写并为抖音和/或哔哩哔哩生成标题建议。',
      inputSchema: {
        type: 'object',
        properties: {
          transcript: { type: 'string', minLength: 80, description: '视频中文转写，至少80字。' },
          platforms: { type: 'array', items: { type: 'string', enum: ['douyin', 'bilibili'] }, minItems: 1, uniqueItems: true },
          tone: { type: 'string', enum: toneOptions.map((option) => option.value) },
          duration_seconds: { type: 'number', minimum: 1 },
        },
        required: ['transcript', 'platforms', 'tone'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        const value = input as { transcript?: unknown; platforms?: unknown; tone?: unknown; duration_seconds?: unknown };
        const nextTranscript = typeof value.transcript === 'string' ? value.transcript.trim() : '';
        const nextPlatforms = Array.isArray(value.platforms) ? value.platforms.filter(isValidPlatform) : [];
        const nextTone = isValidTone(value.tone) ? value.tone : null;
        if (nextTranscript.length < 80 || !nextPlatforms.length || !nextTone) throw new Error('输入无效：需要至少80字转写、一个平台和有效语气。');
        const nextDuration = typeof value.duration_seconds === 'number' && Number.isFinite(value.duration_seconds) ? value.duration_seconds : null;
        setTranscript(nextTranscript);
        setPlatforms(nextPlatforms);
        setTone(nextTone);
        const analysis = await performAnalysis({ transcriptValue: nextTranscript, platformValues: nextPlatforms, toneValue: nextTone, duration: nextDuration, scroll: true });
        return {
          source: analysis.source,
          subject: analysis.overview.subject,
          title_counts: { douyin: analysis.titles.douyin.length, bilibili: analysis.titles.bilibili.length },
          caution_count: analysis.overview.cautionClaims.length,
        };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);

    return () => lifecycle.abort();
  }, [performAnalysis]);

  const overviewCards = useMemo(() => result ? [
    { label: '主题摘要', value: result.overview.subject, icon: ScanSearch },
    { label: '目标观众', value: result.overview.audience, icon: Users },
    { label: '最强钩子', value: result.overview.hook, icon: Zap },
    { label: '核心冲突 / 信息增量', value: result.overview.conflict, icon: Target },
    { label: '中段转折', value: result.overview.turn, icon: RefreshCw },
    { label: '结尾回报', value: result.overview.payoff, icon: Check },
  ] : [], [result]);

  return (
    <main className="min-h-screen pb-16">
      <header className="border-b border-slate-800/80 bg-[#101727]/88 backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-[1480px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="relative grid size-9 place-items-center overflow-hidden rounded-xl border border-cyan-300/35 bg-cyan-300/10 text-cyan-200">
              <CircleGauge className="size-5" />
              <span className="scanline absolute inset-y-0 w-8" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-[0.08em] text-white">标题雷达</h1>
              <p className="text-xs text-slate-500">双平台内容信号分析</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
            <ShieldCheck className="size-4 text-emerald-300" />
            视频在本机浏览器读取，不上传、不保存
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1480px] px-4 pt-5 sm:px-6 lg:px-8 lg:pt-7">
        <section aria-labelledby="workspace-title" className="focus-panel overflow-hidden rounded-3xl border border-slate-700/85 bg-[#121b2e]/92">
          <div className="border-b border-slate-700/80 px-5 py-4 sm:px-6">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <Badge className="bg-cyan-300/12 text-cyan-200">01 / 输入内容</Badge>
                  <span className="font-mono text-xs text-slate-600">3–4 MIN TUNED</span>
                </div>
                <h2 id="workspace-title" className="mt-2 text-xl font-semibold tracking-tight text-white sm:text-2xl">把视频和真实转写放进同一张工作台</h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-slate-400">没有自动听写时，请粘贴或校对转写。分析只基于你真实提供的信息。</p>
            </div>
          </div>

          <div className="grid lg:grid-cols-[0.86fr_1.14fr]">
            <div className="border-b border-slate-700/80 p-5 sm:p-6 lg:border-b-0 lg:border-r">
              <div className="mb-3 flex items-center justify-between">
                <label className="text-sm font-semibold text-slate-200" htmlFor="video-file">视频文件 <span className="font-normal text-slate-500">可选但建议</span></label>
                {videoState === 'ready' && <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">已读取</Badge>}
              </div>
              <label htmlFor="video-file" className="group flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-slate-600 bg-slate-950/35 px-5 text-center transition-colors hover:border-cyan-300/55 hover:bg-cyan-300/[0.035] focus-within:ring-2 focus-within:ring-cyan-300/70">
                <input ref={fileInputRef} id="video-file" type="file" accept="video/mp4,video/webm,video/quicktime,video/*" className="sr-only" onChange={(event) => void handleVideo(event.target.files?.[0])} />
                {videoState === 'reading' ? (
                  <>
                    <LoaderCircle className="size-8 animate-spin text-cyan-300" />
                    <p className="mt-3 font-medium text-slate-200">正在读取时长并抽取 5 个画面节点…</p>
                  </>
                ) : videoMeta ? (
                  <>
                    <FileVideo2 className="size-8 text-cyan-300" />
                    <p className="mt-3 max-w-full truncate font-medium text-white">{videoMeta.name}</p>
                    <p className="mt-1 text-sm text-slate-400">{formatTime(videoMeta.duration)} · {videoMeta.width}×{videoMeta.height} · {formatBytes(videoMeta.size)}</p>
                    <span className="mt-3 text-xs text-cyan-200">点击可更换文件</span>
                  </>
                ) : (
                  <>
                    <UploadCloud className="size-9 text-slate-400 transition-colors group-hover:text-cyan-300" />
                    <p className="mt-3 font-medium text-slate-200">选择 MP4、WebM 或 MOV</p>
                    <p className="mt-1 text-sm text-slate-500">默认针对约 3–4 分钟，附近时长也可用</p>
                  </>
                )}
              </label>

              {durationInfo && (
                <div className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${durationInfo.tone === 'good' ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : 'border-orange-400/20 bg-orange-400/[0.06] text-orange-200'}`}>
                  <Info className="mt-0.5 size-4 shrink-0" />
                  {durationInfo.text}
                </div>
              )}
              {videoError && <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-orange-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{videoError}</p>}

              {videoMeta?.frames.length ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-500"><span>本地画面节点</span><span>仅辅助你核对叙事节奏</span></div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {videoMeta.frames.map((frame) => (
                      <figure key={frame.at} className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
                        <Image src={frame.src} alt={`视频 ${formatTime(frame.at)} 的本地抽帧`} width={360} height={203} unoptimized className="aspect-video w-full object-cover" />
                        <figcaption className="px-1 py-1 text-center font-mono text-[11px] text-slate-500">{formatTime(frame.at)}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="p-5 sm:p-6">
              <div className="mb-3 flex items-end justify-between gap-3">
                <label htmlFor="transcript" className="text-sm font-semibold text-slate-200">视频转写 <span className="font-normal text-orange-200">必填</span></label>
                <span className={`font-mono text-xs ${transcriptCount >= 80 ? 'text-emerald-300' : 'text-slate-500'}`}>{transcriptCount} 字</span>
              </div>
              <Textarea
                id="transcript"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder="粘贴自动字幕、口播稿或人工转写。建议保留原始措辞、数字、转折和结尾，不要只写摘要。"
                className="min-h-56 resize-y border-slate-600 bg-slate-950/40 px-4 py-3 text-base leading-7 text-slate-100 placeholder:text-slate-600 focus-visible:border-cyan-300/65 focus-visible:ring-cyan-300/20 md:text-base"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs leading-5 text-slate-500">当前版本不会假装自动听写；少于 80 字无法开始。</p>
                <Button variant="ghost" size="sm" onClick={() => setTranscript(exampleTranscript)} className="text-cyan-200 hover:bg-cyan-300/10 hover:text-cyan-100">
                  <Sparkles data-icon="inline-start" />填入示例转写
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-5 border-t border-slate-700/80 bg-slate-950/25 p-5 sm:p-6 xl:grid-cols-[0.72fr_1.38fr_auto] xl:items-end">
            <fieldset>
              <legend className="mb-3 text-sm font-semibold text-slate-200">发布平台</legend>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['douyin', '抖音', '短钩子'],
                  ['bilibili', '哔哩哔哩', '信息与搜索'],
                ] as const).map(([value, label, hint]) => {
                  const checked = platforms.includes(value);
                  return (
                    <label key={value} htmlFor={`platform-${value}`} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${checked ? 'border-cyan-300/45 bg-cyan-300/[0.07]' : 'border-slate-700 bg-slate-900/45'}`}>
                      <Checkbox id={`platform-${value}`} checked={checked} onCheckedChange={() => togglePlatform(value)} aria-label={label} />
                      <span><span className="block text-sm font-medium text-slate-100">{label}</span><span className="text-xs text-slate-500">{hint}</span></span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-3 text-sm font-semibold text-slate-200">标题语气</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {toneOptions.map((option) => (
                  <button key={option.value} type="button" aria-pressed={tone === option.value} onClick={() => setTone(option.value)} className={`rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${tone === option.value ? 'border-cyan-300/50 bg-cyan-300/10 text-white' : 'border-slate-700 bg-slate-900/40 text-slate-400 hover:border-slate-600'}`}>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="text-xs text-slate-500">{option.hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="xl:min-w-52">
              <Button size="lg" disabled={!canAnalyze} onClick={() => void handleAnalyze()} className="h-12 w-full rounded-xl bg-cyan-300 px-5 text-base font-semibold text-slate-950 shadow-[0_0_32px_rgb(103_232_249/16%)] hover:bg-cyan-200">
                {analysisState === 'analyzing' ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <WandSparkles data-icon="inline-start" />}
                {analysisState === 'analyzing' ? '正在分析…' : '分析并生成标题'}
              </Button>
              {!canAnalyze && analysisState !== 'analyzing' && <p className="mt-2 text-center text-xs text-slate-500">补足转写并选择平台后可用</p>}
            </div>
          </div>
        </section>

        <div ref={resultsRef} className="scroll-mt-5 pt-6" aria-live="polite">
          {analysisState === 'analyzing' && (
            <section className="focus-panel relative overflow-hidden rounded-3xl border border-slate-700/80 bg-[#121b2e]/92 p-8 text-center">
              <div className="scanline absolute inset-y-0 w-36" />
              <LoaderCircle className="mx-auto size-8 animate-spin text-cyan-300" />
              <h2 className="mt-4 text-lg font-semibold text-white">正在拆解内容结构与标题风险</h2>
              <p className="mt-2 text-sm text-slate-400">会先尝试安全的服务端 AI；不可用时自动转为本地规则分析。</p>
            </section>
          )}

          {analysisState === 'error' && (
            <section role="alert" className="rounded-2xl border border-orange-400/25 bg-orange-400/[0.07] p-5 text-orange-100">
              <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0" /><div><h2 className="font-semibold">暂时无法分析</h2><p className="mt-1 text-sm text-orange-200/80">{analysisError}</p></div></div>
            </section>
          )}

          {result && analysisState === 'done' ? (
            <div className="space-y-8">
              <section aria-labelledby="analysis-heading" className="focus-panel rounded-3xl border border-slate-700/80 bg-[#121b2e]/92 p-5 sm:p-6">
                <div className="flex flex-col justify-between gap-4 border-b border-slate-700/80 pb-5 sm:flex-row sm:items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge className="bg-cyan-300/12 text-cyan-200">02 / 内容画像</Badge>
                      <Badge variant="outline" className={result.source === 'ai' ? 'border-violet-400/35 text-violet-200' : 'border-slate-600 text-slate-400'}>
                        {result.source === 'ai' ? '服务端 AI 分析' : '本地规则分析'}
                      </Badge>
                    </div>
                    <h2 id="analysis-heading" className="mt-3 text-2xl font-semibold tracking-tight text-white">内容骨架先于标题</h2>
                    {result.note && <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">{result.note}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {result.overview.keywords.map((keyword) => <Badge key={keyword} variant="outline" className="border-slate-600 bg-slate-900/60 text-slate-300">{keyword}</Badge>)}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {overviewCards.map((card) => (
                    <article key={card.label} className="rounded-2xl border border-slate-700/75 bg-slate-950/30 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-cyan-200"><card.icon className="size-4" />{card.label}</div>
                      <p className="mt-2 text-sm leading-6 text-slate-300">{card.value}</p>
                    </article>
                  ))}
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <article className="rounded-2xl border border-violet-400/20 bg-violet-400/[0.045] p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-violet-200"><Sparkles className="size-4" />情绪共鸣语句</h3>
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">{result.overview.emotionalPhrases.map((phrase) => <li key={phrase} className="flex gap-2"><span className="text-violet-300">“</span><span>{phrase}</span><span className="text-violet-300">”</span></li>)}</ul>
                  </article>
                  <article className="rounded-2xl border border-orange-400/20 bg-orange-400/[0.045] p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-orange-200"><AlertTriangle className="size-4" />发布前需核验</h3>
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">{result.overview.cautionClaims.map((claim) => <li key={claim} className="flex gap-2"><span className="text-orange-300">•</span><span>{claim}</span></li>)}</ul>
                  </article>
                </div>
              </section>

              <section aria-labelledby="titles-heading" className="space-y-7">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                  <div>
                    <Badge className="bg-cyan-300/12 text-cyan-200">03 / 标题候选</Badge>
                    <h2 id="titles-heading" className="mt-3 text-2xl font-semibold tracking-tight text-white">同一内容，两种平台表达</h2>
                  </div>
                  <Button variant="outline" onClick={regenerate} className="border-slate-600 bg-slate-900/60 text-slate-200 hover:bg-slate-800">
                    <RefreshCw data-icon="inline-start" />按当前语气重生成
                  </Button>
                </div>
                <PlatformResults platform="douyin" items={result.titles.douyin} copiedId={copiedId} onCopy={(item) => void copyTitle(item)} />
                <PlatformResults platform="bilibili" items={result.titles.bilibili} copiedId={copiedId} onCopy={(item) => void copyTitle(item)} />
              </section>
            </div>
          ) : analysisState === 'idle' ? (
            <section className="rounded-3xl border border-dashed border-slate-700 bg-slate-900/25 px-5 py-10 text-center">
              <BarChart3 className="mx-auto size-8 text-slate-600" />
              <h2 className="mt-3 font-medium text-slate-300">分析结果会出现在这里</h2>
              <p className="mt-1 text-sm text-slate-500">先得到内容骨架，再分别生成抖音和哔哩哔哩标题。</p>
            </section>
          ) : null}
        </div>

        <section className="mt-8 rounded-2xl border border-slate-700/70 bg-slate-950/35 p-5 text-sm leading-6 text-slate-400">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" />
            <div>
              <h2 className="font-semibold text-slate-200">边界说明</h2>
              <p className="mt-1">标题分数是可解释的编辑评估，不是平台官方评分，也无法保证流量。视频文件只在当前浏览器里读取元数据和抽帧；服务端分析只接收你提交的转写，不接收视频。请在发布前核对事实、数字、资质与引用来源。</p>
            </div>
          </div>
          <details className="mt-4 border-t border-slate-800 pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"><ChevronDown className="size-4" />平台依据与方法来源</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <p>抖音侧只把“真实、专业、可信、避免夸大虚假”等官方内容原则作为合规底线；短标题与单钩子属于本工具的编辑策略。</p>
              <p>哔哩哔哩侧依据官方投稿与推广规范检查题文一致、无诱导性标题和不相关标签；搜索友好度属于本工具的编辑策略。</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              <a href="https://www.douyin.com/shipin/7308985412423403531" target="_blank" rel="noreferrer" className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-100">抖音内容创作规范相关官方页面</a>
              <a href="https://www.bilibili.com/blackboard/activity-Zwl3skTcLf.html" target="_blank" rel="noreferrer" className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-100">哔哩哔哩官方投稿规范</a>
              <a href="https://www.bilibili.com/blackboard/activity-N31LnCpku5.html" target="_blank" rel="noreferrer" className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-100">哔哩哔哩创作推广规范</a>
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}
