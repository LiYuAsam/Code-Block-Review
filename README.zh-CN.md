# Code Block Review

[English](./README.md) | 简体中文

Code Block Review 是一个 VS Code 扩展，用来把工作区里的代码改动整理成结构化的 review session，让你按“代码块”而不是原始文件 diff 来审查变更。

它适合这些场景：

- AI 辅助生成的代码改动
- 工具自动生成或自动修改的代码
- 人工在 AI 改动基础上的补充修改
- AI 与人工混合编辑的工作流

## 为什么要做它

现在很多编码工具都能在很短时间内改动多个文件，但这些改动最后通常只是普通的 working tree 变化，用户很难快速看清“这轮到底改了什么”。

Code Block Review 在工作区上方补了一层轻量的 review 能力：

- 把一轮改动组织成 review session
- 在编辑器里高亮新增、删除、替换的代码块
- 支持按块、按文件、按全部剩余文件做 review
- review 进行中如果还有新改动，也能继续并入同一个 session

## 功能特性

- 手动启动 review session：`Code Block Review: Start Review Session`
- 自动捕获大改动或 burst 式改动
- 以代码块为中心进行审查，而不是只看文件级 diff
- 在 Explorer 侧边栏按文件和代码块展示待审改动
- 提供专门的 review panel，支持：
  - 上一个 / 下一个代码块
  - 接受 / 拒绝当前代码块
  - 接受 / 拒绝当前文件
  - 接受 / 拒绝全部剩余文件
- 支持忽略 lockfile、生成文件、快照文件等噪音改动

## 使用方式

### 手动模式

1. 执行 `Code Block Review: Start Review Session`
2. 自己修改代码，或者让 AI / 工具修改代码
3. 执行 `Code Block Review: Stop Capture And Review`
4. 在 Explorer 侧边栏或 review panel 中审查待处理的代码块

### 自动模式

开启 auto capture 后，扩展会持续观察看起来更像 AI / 工具批量写入的改动，而不是普通的手动敲字。

当一轮 capture 进入空闲状态后：

- 左下角状态栏会进入 `Ready` 状态
- 你可以直接跳进 review panel
- 或者什么都不做，让这轮改动静默吸收到新的 baseline 中

### 自动捕获判定方式

自动捕获使用的是一个短时间观察窗口，而不是把每一次编辑事件单独拿出来做硬判断。

- `observationWindowSeconds`
  控制首波改动会被观察多久，再决定是否进入 capture。
- `largeChangeLines` / `largeChangeChars`
  单次改动已经很大时，会直接触发 capture。
- `multiFileMinFiles` + `multiFileMinLines`
  跨文件改动会被视为比普通手动输入更可疑。
- `burstMinLines`
  统计观察窗口内触达的唯一行数；同一行上的重复编辑不会无限累加。
- `burstEventWindowMilliseconds` + `burstMinEvents`
  这是高频事件的辅助信号。现在它不会单独触发 capture，只会轻微放宽多文件或 burst 行数阈值。

实际判定顺序可以简化成下面这样：

| 场景 | 主要信号 | 结果 |
| --- | --- | --- |
| 单次改动已经很大 | `largeChangeLines` 或 `largeChangeChars` | 直接进入 capture |
| 多个文件一起发生改动 | `multiFileMinFiles` 和 `multiFileMinLines` | 进入 capture |
| 短窗口内累计改动了很多唯一行 | `burstMinLines` | 进入 capture |
| 编辑事件非常密集 | `burstEventWindowMilliseconds` + `burstMinEvents` | 只作为辅助，不单独触发 |

## 配置项

当前支持的配置主要包括：

- 忽略文件模式
- 常驻自动捕获
- baseline 刷新触发条件
- 进入 review 前的空闲等待时间
- Ready 状态的等待时长
- burst 检测阈值

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
