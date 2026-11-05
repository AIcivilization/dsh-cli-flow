# dsh-cli-flow

**给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 加上流程：把短剧、PPT、短视频这类多步骤的工作，一张卡片一张卡片地做完。**

它建在 [dsh-cli](https://github.com/AIcivilization/dsh-cli) 这座桥上，装它会自动带上桥。如果只要调用工具，装 `dsh-cli` 就够了。

## 安装

```bash
dsh plugin --profile desktop add dsh-cli-flow
```

把 `desktop` 换成你用的 profile，然后重启 dsh。对话顶部会多一个「流程」按钮。

## 内置流程

| 流程 | 卡片数 | 产出 |
|---|---|---|
| AI 短剧 | 12 | 创意、大纲、剧本、分镜、人物和场景设定等 |
| PPT 演示 | 6 | 大纲、每页内容、可播放的幻灯片、演讲稿、问答准备 |
| 短视频口播 | 7 | 选题、文案、画面脚本、封面和发布文案 |
| 电商商品上架 | 7 | 卖点、标题、详情页、图片提示词、问答 |
| 开源项目发布包 | 13 | 讲解视频、封面、发布文章、英文版、社交文案 |

步骤的来源见 [流程调研](docs/流程调研.md)。

## 每张卡片都是独立的功能

- **不必走完：** 做到哪一步都能导出，然后结束。
- **从中间开始：** 把已有内容填进某张卡片，接着做下游，前面的卡片不会被拉起来跑。
- **只用一张：** 首页选「只用一张卡片」，输入就是全部上下文。
- **不满意就换：** 比稿时几家都做一遍，你来选；也可以换一家重做，只有下游跟着重跑。
- **出图、出视频的步骤：** 这些卡片的工具还没接进流程，流程会停下来等你填入文件。也可以交给 dsh 的 AI，让它用 `dsh-cli` 找工具生成。

## 让 dsh 的 AI 操作卡片

装好后，你可以直接说「帮我做个 PPT」「给这个流程加一张海报文案的卡片」「看看分镜哪里可以改进」。AI 通过 `cli_flow` 工具操作的是同一份状态，右侧面板会同步显示。

面板上的「交给 AI」只把说明放进对话框，不替你发送。

## 费用和隐私

- **固定的 token 开销：** `cli_flow` 工具的定义每次请求多约 400 token，不用流程的对话也要付。
- **流程本身不经过 dsh 的模型：** 调用工具时花的是各家自己的额度。
- **默认用免费模型：** 文字卡片默认走 OpenCode 的免费模型和本地模型。**免费模型可能用输入改进模型，不要写敏感信息。** 需要先安装 OpenCode。
- **生成类调用会花额度：** 让 AI 出图、出视频前，它应该先告诉你要生成什么，这一点靠模型遵守；实际的花钱确认由 `dsh-cli` 负责。

## 数据放在哪

每个工程一个目录：`~/.dsh/dsh-cli-flow/projects/<工程编号>/`。导出的文件在工程目录的 `exports/` 下。

## 写一个卡片包

要写代码的功能可以做成单独的插件，只往流程里登记卡片，不给模型加工具，所以不增加 token。例子见 [dsh-cli-flow-audio](https://github.com/AIcivilization/dsh-cli-flow-audio)。

```js
import { registerCardPack } from 'dsh-cli-flow/packs'

export const name = 'my-pack'

export function apply(ctx) {
  const dispose = registerCardPack({ id: 'my', title: '我的卡片', cards: [/* ... */] })
  ctx.effect?.(() => dispose, 'my-pack: cards')
}
```

## 开发

```bash
npm install
npm test
```

设置 `DSH_MODULES` 指向装了 `@deepseek-ai/dsh` 的 `node_modules`，可以多跑一项真实校验。设计和验证记录见 [设计方案.md](设计方案.md)。

## License

MIT
