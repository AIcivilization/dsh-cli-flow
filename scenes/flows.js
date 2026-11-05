// scenes/flows.js — 用数据写的流程。节点划分参考国内同类产品和教程（见 docs/流程调研.md）
//
// 文字卡片现在就能用免费模型跑。出图、出视频这类卡片的工具还没接进流程，先标 external：
// 流程停在那里，由用户填入文件，或者让 dsh 的 AI 调桥生成后填入。

const JSON_ONLY = '只输出 JSON，不要任何其他文字。'
const NO_FAKE = '不要编造输入里没有的事实。'

export const shortDrama = {
  id: 'short-drama',
  title: 'AI 短剧',
  description: '从创意到成片：大纲、剧本、拆解、角色和场景设定、分镜、定妆照、镜头视频、配音、配乐、剪辑清单。',
  placeholder: '写下你的创意，或者直接贴小说片段：题材、主角、核心冲突、想要的集数和时长。',
  defaultInput: '都市悬疑短剧，3 集，每集约 1 分钟。女主是深夜便利店店员，发现每晚同一时间来买东西的客人，其实是三年前失踪的人。',
  cards: [
    { id: 'idea', title: '创意梗概', description: '把想法变成一段完整的故事梗概', compare: true, prompt: '根据下面的创意写一段 200 字以内的故事梗概，要有主角、冲突、反转和结局。只输出梗概。\n\n{{brief}}' },
    { id: 'outline', title: '分集大纲', description: '每集讲什么、结尾的钩子', needs: ['idea'], prompt: '根据梗概写分集大纲。每集包含：标题、主要事件、结尾钩子。短剧要节奏快，每集结尾必须有悬念。\n\n{{up.idea}}' },
    { id: 'script', title: '剧本', description: '场次、动作和对白', needs: ['outline'], prompt: '根据大纲写短剧剧本，按场次组织：场景、时间、动作描写、角色对白。对白要口语化，每集对白不超过 150 字。\n\n{{up.outline}}' },
    { id: 'breakdown', title: '剧本拆解', description: '列出全部角色、场景和道具', file: 'breakdown.json', needs: ['script'], prompt: `拆解下面的剧本。${JSON_ONLY}格式：{"characters":[{"name":"","role":"","appearance":""}],"scenes":[{"name":"","time":"","mood":""}],"props":[{"name":"","use":""}]}\n\n{{up.script}}` },
    { id: 'characters', title: '角色设定', description: '外貌、服装，用于保持人物一致', needs: ['breakdown'], prompt: '为每个角色写一段可直接用于文生图的外貌描述：年龄、脸型、发型、服装、气质。同一角色全剧不变，要写得足够具体。\n\n{{up.breakdown}}' },
    { id: 'locations', title: '场景设定', description: '每个场景的画面描述', needs: ['breakdown'], prompt: '为每个场景写一段可直接用于文生图的描述：地点、时间、光线、色调、陈设。\n\n{{up.breakdown}}' },
    { id: 'storyboard', title: '分镜脚本', description: '逐镜头：景别、运镜、画面、对白、时长', file: 'storyboard.json', needs: ['script', 'characters', 'locations'], prompt: `把剧本拆成分镜，每个镜头 4 到 15 秒。${JSON_ONLY}格式：{"shots":[{"no":1,"scene":"","shot":"景别","camera":"运镜","image":"画面描述，含角色和场景的完整外观","line":"对白或旁白","seconds":6}]}\n\n剧本：\n{{up.script}}\n\n角色：\n{{up.characters}}\n\n场景：\n{{up.locations}}` },
    { id: 'portraits', title: '人物定妆照', description: '每个角色一张定妆照，后面的镜头都参考它', capability: 'image', file: 'portraits', external: true, needs: ['characters'] },
    { id: 'frames', title: '分镜画面', description: '每个镜头一张关键帧', capability: 'image', file: 'frames', external: true, needs: ['storyboard', 'portraits'] },
    { id: 'clips', title: '镜头视频', description: '把关键帧变成视频片段', capability: 'video', file: 'clips', external: true, needs: ['storyboard', 'frames'] },
    { id: 'voice', title: '配音', description: '对白和旁白', capability: 'audio', file: 'voice', external: true, needs: ['storyboard'] },
    { id: 'edit-list', title: '剪辑清单', description: '镜头顺序、转场、字幕和配乐建议', needs: ['storyboard'], prompt: '根据分镜写一份剪辑清单：镜头顺序、每处转场、字幕文字、配乐和音效建议、片头片尾。方便在剪映里照着做。\n\n{{up.storyboard}}' },
  ],
}

export const presentation = {
  id: 'presentation',
  title: 'PPT 演示',
  description: '从主题到可播放的幻灯片：受众分析、大纲、每页内容、演讲稿、问答准备。',
  placeholder: '写下主题、给谁讲、讲多久，也可以直接贴文档内容。',
  defaultInput: '给公司新员工讲一次信息安全培训，20 分钟，重点是钓鱼邮件和密码管理。',
  cards: [
    { id: 'audience', title: '受众和目标', description: '讲给谁、讲完希望对方怎样', prompt: `分析这次演示：受众是谁、他们已经知道什么、讲完希望他们记住什么和做什么。不超过 150 字。${NO_FAKE}\n\n{{brief}}` },
    { id: 'outline', title: '大纲', description: '章节和每页标题', compare: true, needs: ['audience'], prompt: '写演示大纲，用 Markdown，二级标题是章节，列表是每页标题。总页数和时长匹配，每页约 1 分钟。\n\n主题：{{brief}}\n\n受众和目标：\n{{up.audience}}' },
    { id: 'slides', title: '每页内容', description: '每页的标题和要点', file: 'slides.json', needs: ['outline'], prompt: `把大纲写成幻灯片内容。每页不超过 4 条要点，每条不超过 20 字，要具体，不要空话。${JSON_ONLY}格式：{"title":"演示标题","slides":[{"heading":"","points":[""],"visual":"这页建议放什么图"}]}\n\n{{up.outline}}` },
    { id: 'deck', title: '渲染幻灯片', description: '生成可在浏览器播放和打印的幻灯片', capability: 'render', builtin: 'render-deck', file: 'deck.html', needs: ['slides'] },
    { id: 'notes', title: '演讲稿', description: '每页要说的话', needs: ['slides'], prompt: '为每页写演讲稿，口语化，每页约 150 字，开头标明页码和标题。\n\n{{up.slides}}' },
    { id: 'qa', title: '问答准备', description: '听众可能问什么、怎么答', needs: ['slides'], prompt: '列出听众最可能问的 5 个问题和简短回答。不知道的内容要写明需要核实。\n\n{{up.slides}}' },
  ],
}

export const shortVideo = {
  id: 'short-video',
  title: '短视频口播',
  description: '选题、文案、分镜、封面和发布文案。配音和成片可以接着做。',
  placeholder: '写下账号定位和想讲的主题。',
  defaultInput: '程序员副业账号，讲一个普通人也能上手的 AI 提效小技巧。',
  cards: [
    { id: 'topics', title: '选题', description: '几个选题和各自的看点', prompt: `给出 5 个选题，每个写标题和为什么有人想看。${NO_FAKE}\n\n{{brief}}` },
    { id: 'hook', title: '开头钩子', description: '前三秒说什么', needs: ['topics'], prompt: '选最好的一个选题，写 5 个不同的开头，每个不超过 25 字，要让人想继续看。\n\n{{up.topics}}' },
    { id: 'script', title: '口播文案', description: '完整的口播稿', compare: true, needs: ['topics', 'hook'], prompt: '写一条 60 秒口播文案，约 250 字，口语化，用最好的开头，结尾有行动号召。只输出文案。\n\n选题：\n{{up.topics}}\n\n开头：\n{{up.hook}}' },
    { id: 'storyboard', title: '画面脚本', description: '每句话配什么画面', needs: ['script'], prompt: '把文案逐句拆成画面脚本：这句话、配什么画面、字幕重点词。\n\n{{up.script}}' },
    { id: 'cover', title: '封面文案', description: '封面大字和画面建议', needs: ['script'], prompt: '写 3 组封面方案：封面大字（不超过 10 字）、副标题、画面建议。\n\n{{up.script}}' },
    { id: 'publish', title: '发布文案', description: '各平台的标题和标签', needs: ['script'], prompt: '写抖音、小红书、视频号三个平台的标题、正文和话题标签。\n\n{{up.script}}' },
    { id: 'footage', title: '配音和成片', description: '配音、画面和剪辑的成品', capability: 'video', file: 'footage', external: true, needs: ['storyboard'] },
  ],
}

export const ecommerce = {
  id: 'ecommerce',
  title: '电商商品上架',
  description: '从商品信息到卖点、标题、详情页文案、主图和场景图提示词。',
  placeholder: '写下商品名、品类、材质、规格、价格和目标人群。',
  defaultInput: '便携折叠电水壶，600ml，304 不锈钢内胆，硅胶可折叠，适合出差和露营，售价 129 元。',
  cards: [
    { id: 'points', title: '卖点提炼', description: '人群、痛点和卖点', compare: true, prompt: `提炼这个商品的目标人群、使用场景、3 到 5 个卖点。每个卖点对应一个具体痛点。${NO_FAKE}\n\n{{brief}}` },
    { id: 'titles', title: '商品标题', description: '搜索标题和短标题', needs: ['points'], prompt: '写 5 个电商搜索标题（30 字以内，含核心关键词）和 3 个短标题。\n\n{{up.points}}' },
    { id: 'detail', title: '详情页文案', description: '按屏写的详情页', needs: ['points'], prompt: `按屏写详情页文案：首屏主张、卖点逐屏展开、参数、使用场景、常见问题。不要写输入里没有的参数和认证。${NO_FAKE}\n\n商品：{{brief}}\n\n卖点：\n{{up.points}}` },
    { id: 'image-prompts', title: '图片提示词', description: '主图、场景图和细节图怎么拍', needs: ['points'], prompt: '写 5 条可直接用于文生图的提示词：1 张白底主图、2 张场景图、2 张细节图。按"产品一致性、场景、光影、材质、用途"来写。\n\n商品：{{brief}}\n\n卖点：\n{{up.points}}' },
    { id: 'images', title: '商品图', description: '主图和场景图的成品', capability: 'image', file: 'images', external: true, needs: ['image-prompts'] },
    { id: 'video-script', title: '短视频脚本', description: '15 秒商品短视频', needs: ['points'], prompt: '写一条 15 秒商品短视频脚本：逐镜头写画面、字幕和时长。\n\n{{up.points}}' },
    { id: 'faq', title: '客服话术', description: '常见问题的回答', needs: ['detail'], prompt: '列出买家最常问的 8 个问题和回答。不确定的写"以实际商品为准"。\n\n{{up.detail}}' },
  ],
}

export const DATA_FLOWS = [shortDrama, presentation, shortVideo, ecommerce]
