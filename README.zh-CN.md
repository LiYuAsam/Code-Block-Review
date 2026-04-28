# Code Block Review

[English](./README.md) | 简体中文

Code Block Review 是一个 VS Code 扩展，用来把工作区里的代码改动整理成结构化的 review session，让你按“代码块”而不是原始文件 diff 来审查变更。

它适合这些场景：

- AI 辅助生成的代码改动
- 工具自动生成或自动修改的代码
- 人工在 AI 改动基础上的补充修改
- AI 与人工混合编辑的工作流

## Demo 演示页

在线演示页地址：[code-block-review-demo.html](https://liyuasam.github.io/Code-Block-Review/code-block-review-demo.html)。

### 使用示意图

VS Code 中的代码块高亮、Explorer 待审树和右侧 review panel：

![Code Block Review 使用示意图](./images/code-block-review-usage.png)

## 为什么要做它

现在很多编码工具都能在很短时间内改动多个文件，但这些改动最后通常只是普通的 working tree 变化，用户很难快速看清“这轮到底改了什么”。

Code Block Review 在工作区上方补了一层轻量的 review 能力：

- 把一轮改动组织成 review session
- 在编辑器里高亮新增、删除、替换的代码块
- 支持按块、按文件、按全部剩余文件做 review
- review 进行中如果还有新改动，也能继续并入同一个 session

## 功能特性

- 手动启动 review session，或让常驻自动捕获识别 AI / 工具式批量改动。
- 以新增、替换、删除代码块为单位审查改动，而不是只看整文件 diff。
- 直接在编辑器里通过行内高亮、删除摘要和 CodeLens 操作完成 review。
- 通过 Explorer 待审树或专门的 review panel 做块级导航和对比。
- 支持接受 / 拒绝单个代码块、当前文件，或全部剩余待处理改动。
- 支持忽略规则、范围化 baseline 和本地化设置，适配噪音较多或体量较大的工作区。

## 使用方式

### 手动模式

1. 执行 `Code Block Review: Start Review Session`
2. 自己修改代码，或者让 AI / 工具修改代码
3. 执行 `Code Block Review: Stop Capture And Review`
4. 直接在编辑器内、Explorer 侧边栏，或 review panel 中审查待处理的代码块

### 编辑器内审查流程

每个待审代码块都会被高亮出来，并在代码块下方提供一组紧凑操作按钮：

- `Accept`：保留当前代码块，并自动跳到下一条 pending block
- `Reject`：恢复 baseline 内容，并自动跳到下一条 pending block
- `Prev Block` / `Next Block`：不离开编辑器，直接在待审代码块之间切换
- `Review`：打开右侧专门的 review panel，查看更完整的块级对比

### 自动模式

开启 auto capture 后，扩展会持续观察看起来更像 AI / 工具批量写入的改动，而不是普通的手动敲字。

当一轮 capture 进入空闲状态后：

- 左下角状态栏会进入 `Ready` 状态
- 通知里的 `Start Review` 会直接进入 review，并跳到第一条 pending block
- 你仍然可以随时打开专门的 review panel
- 或者什么都不做，让这轮改动静默吸收到新的 baseline 中
- 默认 Ready 等待时间是 120 秒
- 将 `codexReview.autoCapture.reviewOfferSeconds` 设置为 `0` 时，会关闭自动超时，Ready 会一直等待你手动 review 或 skip
- 如果这期间 Git HEAD/ref 发生变化，例如切分支，capture / Ready 会话会自动释放，避免继续 review 过期改动

### 自动捕获判定方式

自动捕获使用短时间观察窗口来判断一轮改动是否更像 AI / 工具批量写入。它主要关注单次大改动、跨文件协同改动，以及短时间内大量唯一行发生变化；特别密集的编辑事件只作为辅助信号，不会单独触发 capture。

实际判定顺序可以简化成下面这样：

| 场景 | 主要信号 | 结果 |
| --- | --- | --- |
| 单次改动已经很大 | `largeChangeLines` 或 `largeChangeChars` | 直接进入 capture |
| 多个文件一起发生改动 | `multiFileMinFiles` 和 `multiFileMinLines` | 进入 capture |
| 短窗口内累计改动了很多唯一行 | `burstMinLines` | 进入 capture |
| 编辑事件非常密集 | `burstEventWindowMilliseconds` + `burstMinEvents` | 只作为辅助，不单独触发 |

对于大型多项目工作区，`codexReview.autoCapture.scope` 可以控制 baseline 扫描范围。默认的 `touchedProjects` 会聚焦当前项目和近期触达过的项目。

## 配置项

当前支持的配置主要包括：

- 忽略文件模式
- 可选的行内代码块标签
- 自动捕获行为、范围和时序
- Ready 状态等待时长；`codexReview.autoCapture.reviewOfferSeconds = 0` 会持续保留当前 review session 直到手动处理
- burst 检测阈值和诊断日志

完整配置请直接在扩展设置面板中查看。

## 本地开发

1. 用 VS Code 打开这个目录
2. 按 `F5` 启动 Extension Development Host

快速校验：

```bash
npm run check
```

## 当前状态

Code Block Review 已经可以实际使用，并且还在持续迭代中。当前版本的重点，是把 AI 辅助编码场景下的 review 流程真正做顺。

## 相关链接

- 仓库地址：https://github.com/LiYuAsam/Code-Block-Review
- 问题反馈：https://github.com/LiYuAsam/Code-Block-Review/issues
