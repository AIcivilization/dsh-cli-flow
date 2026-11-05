// scenes/launch-kit.js — 场景：开源项目发布包
//
// 输入一段产品介绍，产出讲解视频、封面、发布文章、英文版和社交文案。
// 选它做第一个测试场景，是因为它能用免费工具跑通，又覆盖了流程的所有难点：
//
//   多种能力   写文字、渲染图片、语音、视频合成、质检
//   比稿       卖点提炼（云端和本地模型）、封面（Blender 和网页）
//   换家       讲稿第一个候选故意不合格，要自动换下一家
//   并行       文章、讲稿、社交文案同时写；每个镜头的图、音、片段并发做
//   产物传递   讲稿决定镜头数，配音时长决定字幕和片段长度
//   重做       换一家重写文章，只有下游跟着重跑

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const WRITERS = ['opencode-deepseek', 'opencode-glm', 'opencode-pickle']

const opencode = (model, label) => ({
  kind: 'agent',
  command: 'opencode',
  label,
  capabilities: ['text'],
  run: ['run', '--format', 'json', '--agent', 'plan', '-m', model, '--', '{prompt}'],
  parser: 'opencode',
  // 所有 OpenCode 共用一个本地数据库，同时跑会报 database is locked（实测）
  exclusive: 'opencode',
})

/** 这个场景要用到、桥里没有内置的工具 */
export const TARGETS = {
  'opencode-deepseek': opencode('opencode/deepseek-v4.1-flash-free', 'DeepSeek（免费）'),
  'opencode-glm': opencode('opencode/glm-5.3-flash-free', 'GLM（免费）'),
  'opencode-pickle': opencode('opencode/big-pickle', 'Big Pickle（免费）'),
  'lmstudio-local': { kind: 'agent', command: 'lms', label: '本地模型（约 7GB，较慢）', capabilities: ['text'], run: ['chat', 'huihui-qwythos-9b-claude-mythos-5-1m-abliterated', '-p', '{prompt}'], parser: 'lmstudio' },
}

export const LABELS = {
  ...Object.fromEntries(Object.entries(TARGETS).map(([id, t]) => [id, t.label])),
  blender: 'Blender（3D）',
  chrome: 'Chrome（网页）',
  'say-tingting': '系统语音 Tingting',
  'say-meijia': '系统语音 Meijia',
  ffmpeg: 'ffmpeg',
  local: '本地处理',
  manual: '手动填入',
  dsh: 'dsh 的 AI',
}
const CHROME_SIZE = '--window-size=1280,720'

/** 一次最多做 limit 个 */
async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }))
  return results
}

const needText = (min) => async (ctx, file) => {
  const text = await readFile(join(ctx.dir, file), 'utf8')
  if (text.trim().length < min) throw new Error(`${file} 只有 ${text.trim().length} 字，太短`)
  checkCleanText(text, file)
}

/** 工具的进度条、思考过程混进产物时要拦下，否则会一路传到下游（实测踩过） */
export function checkCleanText(text, label = '内容') {
  if (/Loading \S+ \d+%|[\u2800-\u28ff]|<think>|\u001b\[/.test(text)) throw new Error(`${label} 里混进了工具输出`)
}

// 正常语速每秒约 3 到 8 个字。低于下限说明声音没有真的读出来
const MAX_CHARS_PER_SECOND = 9

/** macOS 的 Flo、Eddy 等声音会直接跳过中文，文件能生成，退出码也是 0，只有时长能发现（实测踩过） */
export function checkSpeechLength(text, seconds, label = '旁白') {
  const chars = text.replace(/\s/g, '').length
  const minimum = chars / MAX_CHARS_PER_SECOND
  if (seconds < minimum) throw new Error(`${label}有 ${chars} 字，音频却只有 ${seconds.toFixed(1)} 秒，至少应有 ${minimum.toFixed(1)} 秒，文字可能没有被读出来`)
}

async function assertFile(path, minBytes = 1000) {
  const info = await stat(path).catch(() => null)
  if (!info || info.size < minBytes) throw new Error(`${path} 没有生成或太小`)
}

/** 模型喜欢加说明文字和代码块，只取最外层的 JSON */
export function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`回复里没有 JSON：${text.slice(0, 80)}`)
  return JSON.parse(text.slice(start, end + 1))
}

export function checkScript(script) {
  if (typeof script.title !== 'string' || !script.title.trim()) throw new Error('讲稿缺标题')
  if (!Array.isArray(script.scenes) || script.scenes.length < 3 || script.scenes.length > 6) {
    throw new Error(`讲稿要 3 到 6 个镜头，实际 ${script.scenes?.length}`)
  }
  for (const [i, scene] of script.scenes.entries()) {
    for (const key of ['heading', 'points', 'narration']) {
      if (!scene[key]) throw new Error(`第 ${i + 1} 个镜头缺 ${key}`)
    }
    if (!Array.isArray(scene.points)) throw new Error(`第 ${i + 1} 个镜头的 points 不是数组`)
    if (scene.narration.length > 120) throw new Error(`第 ${i + 1} 个镜头旁白太长`)
  }
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function slideHtml(scene, index, total) {
  return `<!doctype html><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}body{width:1280px;height:720px;background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#f8fafc;font-family:"PingFang SC","Hiragino Sans GB",sans-serif;padding:72px 88px;display:flex;flex-direction:column;overflow:hidden}
.n{color:#38bdf8;font-size:24px;letter-spacing:2px;margin-bottom:20px}h1{font-size:58px;line-height:1.25;margin-bottom:40px}li{font-size:32px;line-height:1.5;margin:0 0 18px 36px;color:#e2e8f0}
</style><div class="n">${index + 1} / ${total}</div><h1>${escapeHtml(scene.heading)}</h1><ul>${scene.points.slice(0, 4).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
}

export async function renderHtml(ctx, html, out) {
  const page = join(ctx.dir, `${out}.html`)
  await writeFile(page, html)
  await ctx.invoke('chrome', {
    argv: ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(tmpdir(), `dsh-cli-flow-${process.pid}-${out}`)}`, CHROME_SIZE, `--screenshot=${join(ctx.dir, out)}`, `file://${page}`],
  })
  await assertFile(join(ctx.dir, out))
}

const BLENDER_SCRIPT = `
import bpy, sys
args = sys.argv[sys.argv.index('--') + 1:]
title = open(args[0], encoding='utf-8').read().strip()
out = args[1]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
scene = bpy.context.scene
scene.render.engine = 'CYCLES'; scene.cycles.samples = 24; scene.cycles.device = 'CPU'
scene.render.resolution_x = 1280; scene.render.resolution_y = 720
scene.render.filepath = out; scene.render.image_settings.file_format = 'PNG'
world = bpy.data.worlds.new('w'); scene.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.02, 0.05, 0.11, 1)
def material(rgb, emit=0):
    m = bpy.data.materials.new('m'); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    if emit:
        b.inputs['Emission Color'].default_value = (*rgb, 1); b.inputs['Emission Strength'].default_value = emit
    return m
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
bpy.context.object.data.materials.append(material((0.03, 0.09, 0.18)))
for i, (x, y, h) in enumerate([(-4.4, 2.1, 1.2), (-3.2, 2.4, 2.2), (3.8, 2.3, 1.7), (4.5, 1.5, 0.9), (-4.5, -2.2, 0.7), (4.4, -2.1, 1.1)]):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, h / 2)); o = bpy.context.object; o.scale = (0.9, 0.9, h)
    o.data.materials.append(material((0.1, 0.55, 0.85), 0.6 if i % 2 else 0))
font = bpy.data.fonts.load('/System/Library/Fonts/STHeiti Medium.ttc')
bpy.ops.object.text_add(location=(0, 0, 0.05)); t = bpy.context.object
t.data.body = title; t.data.font = font; t.data.align_x = 'CENTER'; t.data.align_y = 'CENTER'; t.data.extrude = 0.08; t.data.size = 1.25
t.data.materials.append(material((0.95, 0.98, 1.0), 1.5))
# 镜头距离 14 时画面只有约 10 个单位宽，标题长了要缩小，否则两头被切掉（实测踩过）
bpy.context.view_layer.update()
if t.dimensions.x > 8.5:
    k = 8.5 / t.dimensions.x; t.scale = (k, k, k)
bpy.ops.object.camera_add(location=(0, -1.5, 14)); cam = bpy.context.object; cam.rotation_euler = (0.1, 0, 0); scene.camera = cam
bpy.ops.object.light_add(type='AREA', location=(0, -4, 9)); bpy.context.object.data.energy = 900; bpy.context.object.data.size = 12
bpy.ops.render.render(write_still=True)
`

// —— 视频 ——

export async function durationOf(ctx, file, cwd) {
  // 不依赖 ffprobe：ffmpeg -i 不给输出时退出码是 1，用 null 输出就是 0
  const result = await ctx.invoke('ffmpeg', { argv: ['-hide_banner', '-i', file, '-f', 'null', '-'], cwd })
  const text = `${result.stderr ?? ''}${result.output ?? ''}`
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(text)
  if (!match) throw new Error(`读不到 ${file} 的时长`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

const VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '25', '-c:a', 'aac', '-ar', '44100', '-ac', '2']

/** 把旁白切成字幕行，按字数分配时间 */
export function subtitleLines(text, maxChars = 20) {
  // 英文单词和数字算一个整体，不从中间切开（实测把 Harness 切成过两半）
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9._'-]*|\s+|./gsu) ?? []
  const lines = []
  let line = ''
  const push = () => {
    if (line.trim()) lines.push(line.trim())
    line = ''
  }
  for (const token of tokens) {
    // 标点不放到行首，宁可这一行略微超长
    if (line.length + token.length > maxChars && !/^[，。！？；、：,.!?;:）)]$/.test(token)) push()
    line += token
    if (/[，。！？；,.!?;]$/.test(token) && line.length >= maxChars * 0.6) push()
  }
  push()
  // 最后只剩一两个字（比如“吗？”）时并回上一行，单独一行没法读
  if (lines.length > 1 && lines.at(-1).replace(/[，。！？；、：,.!?;:）)]/g, '').length <= 2) {
    const tail = lines.pop()
    lines[lines.length - 1] += tail
  }
  return lines
}

const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

export function buildSrt(scenes, durations, offset = 0) {
  let clock = offset
  let n = 0
  const out = []
  scenes.forEach((scene, i) => {
    const lines = subtitleLines(scene.narration)
    const total = lines.reduce((sum, l) => sum + l.length, 0) || 1
    let t = clock
    for (const line of lines) {
      const span = durations[i] * (line.length / total)
      n += 1
      out.push(`${n}\n${stamp(t)} --> ${stamp(t + span)}\n${line}\n`)
      t += span
    }
    clock += durations[i]
  })
  return out.join('\n')
}

const COVER_SECONDS = 2.5

export const launchKit = (input) => ({
  id: 'launch-kit',
  title: '开源项目发布包',
  description: '输入产品介绍，产出讲解视频、封面、发布文章、英文版和社交文案。全程用免费工具。',
  labels: LABELS,
  input,
  nodes: [
    {
      id: 'points',
      title: '提炼卖点',
      capability: 'text',
      compare: true,
      candidates: ['opencode-deepseek', 'opencode-glm', 'opencode-pickle', 'lmstudio-local'],
      // 本地模型要加载约 7GB，默认不勾，想比再选
      defaultCompare: ['opencode-deepseek', 'opencode-glm'],
      show: /^points\.md$/,
      produces: { file: 'points.md', kind: 'text' },
      async run(ctx) {
        const { reply } = await ctx.invoke(ctx.target, {
          prompt: `下面是一个开源项目的介绍。提炼 3 到 5 个最打动用户的卖点，每条一行，不超过 40 字，不要编造介绍里没有的内容。只输出卖点本身。\n\n${ctx.brief}`,
        })
        await ctx.write('points.md', reply)
      },
      validate: (ctx) => needText(30)(ctx, 'points.md'),
    },
    {
      id: 'script',
      title: '写讲稿和分镜',
      capability: 'text',
      candidates: WRITERS,
      needs: ['points'],
      show: /^script\.json$/,
      produces: { file: 'script.json', kind: 'text' },
      async run(ctx) {
        const points = await ctx.read('points', 'points.md')
        const { reply } = await ctx.invoke(ctx.target, {
          prompt: `为这个开源项目写一条 40 秒左右的中文讲解短片脚本。只输出 JSON，不要任何其他文字，格式：
{"title":"不超过 12 字的标题","scenes":[{"heading":"这一镜的大标题，不超过 14 字","points":["屏幕要点，2 到 3 条，每条不超过 18 字"],"narration":"这一镜的旁白，30 到 60 字，口语化"}]}
要 4 个镜头。不要编造介绍里没有的内容。

项目介绍：
${ctx.brief}

卖点：
${points}`,
        })
        const script = extractJson(reply)
        checkScript(script)
        await ctx.write('script.json', JSON.stringify(script, null, 2))
      },
    },
    {
      id: 'article',
      title: '写发布文章',
      capability: 'text',
      candidates: ['opencode-glm', 'opencode-deepseek', 'opencode-pickle'],
      needs: ['points'],
      show: /^article\.md$/,
      produces: { file: 'article.md', kind: 'text' },
      async run(ctx) {
        const points = await ctx.read('points', 'points.md')
        const { reply } = await ctx.invoke(ctx.target, {
          prompt: `写一篇 300 字左右的中文发布文章，Markdown 格式，要有标题。语气平实，不要夸张，不要编造介绍里没有的内容。只输出文章。\n\n项目介绍：\n${ctx.brief}\n\n卖点：\n${points}`,
        })
        await ctx.write('article.md', reply)
      },
      validate: (ctx) => needText(150)(ctx, 'article.md'),
    },
    {
      id: 'english',
      title: '翻译成英文',
      capability: 'text',
      candidates: WRITERS,
      needs: ['article'],
      show: /^article\.en\.md$/,
      produces: { file: 'article.en.md', kind: 'text' },
      async run(ctx) {
        const article = await ctx.read('article', 'article.md')
        const { reply } = await ctx.invoke(ctx.target, { prompt: `Translate this Markdown article into natural English. Output only the translation.\n\n${article}` })
        await ctx.write('article.en.md', reply)
      },
      async validate(ctx) {
        const text = await readFile(join(ctx.dir, 'article.en.md'), 'utf8')
        const cjk = (text.match(/[一-鿿]/g) ?? []).length
        if (text.trim().length < 150) throw new Error('译文太短')
        if (cjk > text.length * 0.05) throw new Error('译文里还有大量中文')
      },
    },
    {
      id: 'social',
      title: '写社交文案',
      capability: 'text',
      candidates: ['opencode-pickle', 'opencode-glm', 'opencode-deepseek'],
      needs: ['points'],
      show: /^social\.md$/,
      produces: { file: 'social.md', kind: 'text' },
      async run(ctx) {
        const points = await ctx.read('points', 'points.md')
        const { reply } = await ctx.invoke(ctx.target, { prompt: `根据这些卖点写 3 条中文社交媒体短文案，每条不超过 80 字，用空行分开。只输出文案。\n\n${points}` })
        await ctx.write('social.md', reply)
      },
      validate: (ctx) => needText(50)(ctx, 'social.md'),
    },
    {
      id: 'cover',
      title: '做封面',
      capability: 'render',
      compare: true,
      candidates: ['blender', 'chrome'],
      needs: ['script'],
      show: /^cover\.png$/,
      produces: { file: 'cover.png', kind: '图片' },
      async run(ctx) {
        const { title } = await ctx.readJson('script', 'script.json')
        if (ctx.target === 'blender') {
          await ctx.write('title.txt', title)
          await ctx.write('cover.py', BLENDER_SCRIPT)
          await ctx.invoke('blender', { argv: ['-b', '--factory-startup', '-P', join(ctx.dir, 'cover.py'), '--', join(ctx.dir, 'title.txt'), join(ctx.dir, 'cover.png')] })
          await assertFile(join(ctx.dir, 'cover.png'))
          return
        }
        await renderHtml(ctx, `<!doctype html><meta charset="utf-8"><style>*{margin:0}body{width:1280px;height:720px;background:radial-gradient(circle at 30% 30%,#2563eb,#0f172a);color:#fff;font-family:"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;padding:80px;box-sizing:border-box}h1{font-size:88px;line-height:1.2}</style><h1>${escapeHtml(title)}</h1>`, 'cover.png')
      },
    },
    {
      id: 'slides',
      title: '渲染每个镜头的画面',
      capability: 'render',
      candidates: ['chrome'],
      needs: ['script'],
      show: /^slide-\d+\.png$/,
      async run(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        await pool(scenes, 3, (scene, i) => renderHtml(ctx, slideHtml(scene, i, scenes.length), `slide-${i}.png`))
      },
    },
    {
      id: 'voice',
      title: '配音',
      capability: 'tts',
      compare: true,
      candidates: ['say-tingting', 'say-meijia'],
      needs: ['script'],
      show: /^voice-\d+\.m4a$/,
      async run(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        const voice = { 'say-tingting': 'Tingting', 'say-meijia': 'Meijia', 'say-flo': 'Flo' }[ctx.target]
        await pool(scenes, 3, async (scene, i) => {
          await ctx.invoke('say', { argv: ['-v', voice, '-o', join(ctx.dir, `voice-${i}.aiff`), scene.narration] })
          await assertFile(join(ctx.dir, `voice-${i}.aiff`), 1)
          // 比稿要听，浏览器放不了 aiff
          await ctx.invoke('ffmpeg', { argv: ['-y', '-hide_banner', '-v', 'error', '-i', join(ctx.dir, `voice-${i}.aiff`), '-c:a', 'aac', join(ctx.dir, `voice-${i}.m4a`)] })
        })
      },
      async validate(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        await pool(scenes, 3, async (scene, i) => {
          checkSpeechLength(scene.narration, await durationOf(ctx, join(ctx.dir, `voice-${i}.aiff`), ctx.dir), `第 ${i + 1} 段旁白`)
        })
      },
    },
    {
      id: 'clips',
      title: '合成每个镜头',
      capability: 'media-edit',
      candidates: ['ffmpeg'],
      needs: ['script', 'slides', 'voice'],
      show: /^clip-\d+\.mp4$/,
      async run(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        const slides = ctx.inputDir('slides')
        const voice = ctx.inputDir('voice')
        const durations = await pool(scenes, 3, async (_scene, i) => {
          const audio = join(voice, `voice-${i}.aiff`)
          const seconds = (await durationOf(ctx, audio, ctx.dir)) + 0.4
          const frames = Math.ceil(seconds * 25)
          await ctx.invoke('ffmpeg', {
            argv: ['-y', '-hide_banner', '-loop', '1', '-i', join(slides, `slide-${i}.png`), '-i', audio, '-af', 'apad=pad_dur=0.4',
              '-vf', `zoompan=z='min(zoom+0.0004,1.05)':d=${frames}:s=1280x720:fps=25`, '-t', seconds.toFixed(3), ...VIDEO_ARGS, join(ctx.dir, `clip-${i}.mp4`)],
          })
          await assertFile(join(ctx.dir, `clip-${i}.mp4`))
          return seconds
        })
        await ctx.write('durations.json', JSON.stringify(durations))
      },
    },
    {
      id: 'subtitles',
      title: '做字幕',
      needs: ['script', 'clips'],
      show: /^subs\.srt$/,
      produces: { file: 'subs.srt', kind: 'text' },
      async run(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        const durations = await ctx.readJson('clips', 'durations.json')
        await ctx.write('subs.srt', buildSrt(scenes, durations))
      },
      validate: (ctx) => needText(20)(ctx, 'subs.srt'),
    },
    {
      id: 'final',
      title: '合成成片',
      capability: 'media-edit',
      candidates: ['ffmpeg'],
      needs: ['script', 'cover', 'clips', 'subtitles'],
      show: /^final\.mp4$/,
      produces: { file: 'final.mp4', kind: '视频' },
      async run(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        const clips = ctx.inputDir('clips')
        await copyFile(join(ctx.inputDir('subtitles'), 'subs.srt'), join(ctx.dir, 'subs.srt'))
        await ctx.write('body.txt', scenes.map((_s, i) => `file '${join(clips, `clip-${i}.mp4`)}'`).join('\n'))
        await ctx.invoke('ffmpeg', {
          cwd: ctx.dir,
          argv: ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', 'body.txt',
            '-vf', "subtitles=subs.srt:fontsdir=/System/Library/Fonts:force_style='FontName=STHeiti Medium,FontSize=20,Outline=1,MarginV=28'", ...VIDEO_ARGS, 'body.mp4'],
        })
        await ctx.invoke('ffmpeg', {
          cwd: ctx.dir,
          argv: ['-y', '-hide_banner', '-loop', '1', '-t', String(COVER_SECONDS), '-i', join(ctx.inputDir('cover'), 'cover.png'), '-f', 'lavfi', '-t', String(COVER_SECONDS), '-i', 'anullsrc=r=44100:cl=stereo',
            '-vf', 'scale=1280:720', ...VIDEO_ARGS, 'cover.mp4'],
        })
        await ctx.write('all.txt', "file 'cover.mp4'\nfile 'body.mp4'\n")
        await ctx.invoke('ffmpeg', { cwd: ctx.dir, argv: ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', 'all.txt', '-c', 'copy', 'final.mp4'] })
        await assertFile(join(ctx.dir, 'final.mp4'), 50_000)
      },
    },
    {
      id: 'qa',
      title: '质量检查',
      capability: 'media-edit',
      candidates: ['ffmpeg'],
      needs: ['script', 'final', 'clips', 'subtitles'],
      show: /^(report\.json|frame\.png)$/,
      async run(ctx) {
        const { scenes } = await ctx.readJson('script', 'script.json')
        const durations = await ctx.readJson('clips', 'durations.json')
        // 对照讲稿检查，不能只和自己算出来的时长比：第一次跑时配音没读中文，时长是错的，却和"预期"一致
        scenes.forEach((scene, i) => checkSpeechLength(scene.narration, durations[i], `第 ${i + 1} 个镜头`))
        const final = join(ctx.inputDir('final'), 'final.mp4')
        const info = await ctx.invoke('ffmpeg', { argv: ['-hide_banner', '-i', final, '-f', 'null', '-'] })
        const text = `${info.stderr ?? ''}${info.output ?? ''}`
        const duration = await durationOf(ctx, final, ctx.dir)
        const expected = durations.reduce((a, b) => a + b, 0) + COVER_SECONDS
        const subtitleCount = (await ctx.read('subtitles', 'subs.srt')).split(/\n\n/).filter(Boolean).length
        const report = {
          duration,
          expected,
          hasVideo: /Stream .*Video: h264/.test(text),
          hasAudio: /Stream .*Audio: aac/.test(text),
          size1280x720: /1280x720/.test(text),
          subtitleCount,
        }
        await ctx.write('report.json', JSON.stringify(report, null, 2))
        await ctx.invoke('ffmpeg', { argv: ['-y', '-hide_banner', '-ss', String(COVER_SECONDS + 3), '-i', final, '-frames:v', '1', join(ctx.dir, 'frame.png')] })
        await ctx.invoke('ffmpeg', { argv: ['-y', '-hide_banner', '-ss', '1', '-i', final, '-frames:v', '1', join(ctx.dir, 'frame-cover.png')] })
        if (Math.abs(duration - expected) > 1.5) throw new Error(`成片时长 ${duration}，应该约 ${expected}`)
        if (!report.hasVideo || !report.hasAudio || !report.size1280x720) throw new Error(`成片不合格：${JSON.stringify(report)}`)
      },
    },
    {
      id: 'package',
      title: '打包交付',
      needs: ['final', 'cover', 'article', 'english', 'social', 'script', 'qa'],
      show: /^$/,
      deliverable: 'dist',
      async run(ctx) {
        const out = join(ctx.dir, 'dist')
        await mkdir(out, { recursive: true })
        const copies = [['final', 'final.mp4', '讲解视频.mp4'], ['cover', 'cover.png', '封面.png'], ['article', 'article.md', '发布文章.md'], ['english', 'article.en.md', 'article.en.md'], ['social', 'social.md', '社交文案.md'], ['script', 'script.json', '讲稿.json']]
        for (const [id, file, name] of copies) await copyFile(join(ctx.inputDir(id), file), join(out, name))
      },
    },
  ],
})
