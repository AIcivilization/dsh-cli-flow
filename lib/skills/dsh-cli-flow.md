# 用流程和卡片把一件事做完

用户要做多步骤的工作时，用 `cli_flow` 工具操作流程和卡片。右侧栏的流程面板显示同一份状态，用户能看到你做的每一步，也能自己操作。

**每张卡片都是独立的功能。** 不必走完全程：只做其中一张、从中间开始、做到一半导出，都是正常用法。

## 常用操作

| 要做的事 | action | 参数 |
|---|---|---|
| 看有哪些流程和卡片 | `flows` | |
| 看已有工程 | `projects` | |
| 开始一个流程 | `create` | `flow`、`input` |
| 单独用一张卡片 | `create` | `card`（如 `short-drama/script`）、`input` |
| 现场拼一个流程 | `create` | `cards`、`title`、`input` |
| 看进度 | `status` | `project` |
| 读卡片的产物 | `read` | `project`、`card`，可选 `v` |
| 做到某张卡片就停 | `run` | `project`、`card` |
| 做完全部 | `run` | `project` |
| 比稿选一版 | `choose` | `project`、`card`、`v` |
| 换一家重做 | `redo` | `project`、`card`、`tool` |
| 给卡片加要求 | `note` | `project`、`card`、`text` |
| 改卡片的提示词 | `prompt` | `project`、`card`、`text` |
| 自己写内容填进卡片 | `fill` | `project`、`card`、`text` |
| 把文件填进卡片 | `fill` | `project`、`card`、`path` |
| 加一张卡片 | `add_card` | `project`、`card_def` |
| 导出 | `export` | `project`，可选 `card` |
| 停止 | `stop` | `project` |

卡片定义：`{ "id": "poster", "title": "海报文案", "needs": ["script"], "prompt": "根据剧本写海报文案。\n\n{{up.script}}" }`。提示词里 `{{brief}}` 是用户的输入，`{{up.卡片编号}}` 是上游卡片的产物，用到的上游必须写进 `needs`。不接工具的卡片写 `"external": true`，不用写提示词。

卡片包里的卡片（`flows` 的结果里能看到）可以这样接进流程：`{ "id": "voice", "use": "audio/voice-subtitles", "needs": ["script"] }`，它会处理上游的产物。卡片定义在没有装对应的包时会报错。

## 你应该主动做的事

- **把用户的话变成好输入：** 用户只说一句话时，先问清或补全，再 `create`。
- **看结果：** 卡片做完后用 `read` 看内容，觉得不好就说明哪里不好，用 `note` 加要求后 `redo`，或者自己写好用 `fill` 填进去。
- **补流程：** 缺步骤时用 `add_card` 补上。
- **选比稿要谨慎：** 比稿本来是给用户看的。用户明确让你选时才 `choose`，否则告诉用户各版差别和你的建议，让用户选。

## 标着 external 的卡片

这些卡片（出图、出视频、配音）的工具还没接进流程，流程会停在那里。你可以用 `cli_list` 按能力找工具，用 `cli_run` 生成，再用 `fill` 把文件路径填进卡片。**生成类调用会花用户的额度，先告诉用户要生成什么。** 没有工具时如实说，让用户自己填入。

## 注意

- `run` 是后台跑的，马上返回。用 `status` 看进度，不要连续查询：一次查询就是一次模型请求。
- 流程本身不花你的 token，工具的额度由各家自己算。能让流程做的就交给流程，不要一步步替它做。
- 上游没做也能从中间进入：把上游卡片的内容 `fill` 进去，再 `run` 下游。
