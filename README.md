# Ti

Test-focused agent harness, built on the Pi coding agent.

Ti 取自 Test——一个专门用来自动做"代码测试工作"的 harness 平台：给一个仓库和一个测试任务，让 agent 完成它，然后**用测试结果本身**判定成败，不经过模型判断。

## 怎么跑

```bash
cd packages/ti

# 单个任务
node ti.mjs run tasks/demo-python.json

# 批量（shell 展开）
node ti.mjs run tasks/py-*.json tasks/node-*.json
```

`run` 支持两个可选参数：

```bash
node ti.mjs run tasks/py-logstats.json --model deepseek/deepseek-v4-pro
node ti.mjs run tasks/py-logstats.json --runs-dir D:/runs
```

退出码：全部任务通过为 `0`，否则 `1`。

## 两种任务类型

| kind | 场景 | 判定条件 |
|---|---|---|
| `repair`（默认） | 测试已红，让 agent 修好 | 基线有失败 **且** 终局全绿 |
| `write-tests` | 测试全绿但覆盖不足，让 agent 补 | 终局全绿 **且** 覆盖率达 `coverageTarget` **且** 每个变异体都被测试杀死 |

`write-tests` 的变异检查是防作弊的关键：agent 写完测试后，harness 会逐条改坏源码（按 `mutants` 里的 find/replace），每次改完跑一遍测试。测试必须变红，才算真的能发现问题。只写 `assert True` 或只调用一次函数的测试过不了这一关。

## 任务文件格式

```json
{
	"id": "py-textutil-tests",
	"repo": "fixtures/py-textutil",
	"kind": "write-tests",
	"setup": [],
	"testCommand": "python -m pytest -q --junitxml=\"{junit}\" --cov=textutil --cov-report=json:coverage.json",
	"prompt": "为其余函数补测试，覆盖率不低于 95%。",
	"allowedTools": ["read", "edit", "write", "grep", "find", "ls", "bash"],
	"timeoutMs": 600000,
	"coverageTarget": 95,
	"coverageFile": "coverage.json",
	"mutants": [
		{ "file": "textutil.py", "find": "if len(text) <= limit:", "replace": "if len(text) < limit:" }
	]
}
```

| 字段 | 说明 |
|---|---|
| `kind` | `repair` 或 `write-tests`，缺省 `repair` |
| `repo` | 相对本包根目录的仓库路径，或绝对路径 |
| `setup` | 按顺序执行的准备命令，任一失败即中止 |
| `testCommand` | 判分命令。`{junit}` 替换成绝对报告路径，`{repoRoot}` 替换成仓库根 |
| `allowedTools` | agent 可用的工具白名单，其余不可用 |
| `timeoutMs` | setup、测试、agent、每个变异体各自的上限 |
| `coverageTarget` | `write-tests` 必填，总语句覆盖率下限（百分比） |
| `coverageFile` | `write-tests` 必填，覆盖率 JSON 相对仓库根的路径 |
| `coverageFormat` | `python-json`（默认）或 `istanbul-summary` |
| `mutants` | `write-tests` 必填，至少一个；`find` 必须精确匹配源码且唯一 |

覆盖率支持两种报告：`python-json`（coverage.py 的 `--cov-report=json`，读 `totals.percent_covered`）和 `istanbul-summary`（vitest 的 `--coverage.reporter=json-summary`，读 `total.lines.pct`），由 `coverageFormat` 选择。

## 一次运行做了什么

1. 把 `repo` 复制到 `.ti/runs/<时间戳>-<id>/repo`
2. 复制 `~/.pi/agent/auth.json` 到该运行的独立 agent 目录
3. 在副本里 `git init` 并提交基线，用于事后 diff
4. 执行 `setup`
5. 跑 `testCommand`，解析 JUnit XML，记为 **baseline**
6. 启动 pi，工作目录是副本，工具受限，配置目录隔离
7. 再跑 `testCommand`，记为 **final**
8. 判定：`repair` 要红转绿；`write-tests` 要全绿、覆盖率达标、变异体全杀

## 产物

```
.ti/runs/<时间戳>-<id>/
├── repo/            工作副本（含 agent 的改动）
├── agent/           隔离的 pi 配置目录（含复制来的 auth.json）
├── agent.log        agent 的完整输出
├── baseline.xml     基线 JUnit 报告
├── baseline.log     基线测试的原始输出
├── final.xml        复测 JUnit 报告
├── final.log        复测的原始输出
├── mutant-N.xml     每个变异体的 JUnit 报告
├── result.json      结构化结果（含 diff）
└── report.html      汇总报表（写在 runs 目录下）
```

`result.json` 的 `diff` 字段只包含 agent 的改动，已过滤 git 的换行警告。

## 自动生成任务

不用手写任务。`discover` 会扫描一次覆盖率，找出覆盖不足的模块，并为每个模块找"当前测试杀不死"的变异点：

```bash
node ti.mjs discover discover/schema.json
```

配置（`discover/schema.json`）：

```json
{
	"repo": "../schema",
	"discoverCommand": "node \"{repoRoot}/node_modules/vitest/dist/cli.js\" --run ... --coverage --coverage.reporter=json-summary --coverage.reporter=json",
	"taskCommand": "node \"{repoRoot}/node_modules/vitest/dist/cli.js\" --run ... --coverage.include=\"{module}\"",
	"coverageFile": "coverage/coverage-summary.json",
	"coverageDetailFile": "coverage/coverage-final.json",
	"coverageFormat": "istanbul-summary",
	"threshold": 90,
	"mutantsPerTask": 3,
	"maxCandidatesPerFile": 40,
	"minLines": 20,
	"outputDir": "tasks/generated",
	"timeoutMs": 300000,
	"allowedTools": ["read", "edit", "write", "grep", "find", "ls", "bash"]
}
```

流程：

1. 复制仓库到临时目录，跑 `discoverCommand` 得到全量覆盖率
2. 留下 `src/<name>.ts` 这一层（不扫子目录，那里多是第三方代码）、覆盖率低于 `threshold`、行数不少于 `minLines` 的模块
3. 对每个模块用算子（`<=` / `>=` / `===` / `!==` / `&&` / `||` / `??` / `Math.min` / `Math.max` / `+ 1` / `true` / `false`）逐行制造候选变异，算子按轮询分配名额
4. 用 `coverageDetailFile`（istanbul `coverage-final.json`）把候选限制在**从未执行的语句范围**内
5. 逐个应用候选变异并跑测试：**测试仍然通过**的才算"存活"，因为这样的变异必须靠新写的测试才能杀死
6. 存活变异写进任务，输出到 `outputDir`

第 4、5 步缺一不可。第 5 步保证任务不假：已经被现有测试杀死的变异，agent 什么都不写也能通过。第 4 步保证变异落在真正没测到的地方，否则大部分候选都会在第 5 步被淘汰，白跑一遍测试。

`coverageDetailFile` 用的 istanbul 完整报告里，v8 provider 会把 `end.column` 报成 `null`，解析时按"从起始列到行尾"处理。

实测（`packages/schema`，30 秒扫描）：4 个模块低于 90%，`annotations.ts`（58.9%）有 3 个存活变异，`explain.ts`（82.6%）有 1 个，`compiler.ts` / `checks.ts` 的候选变异全部被现有测试捕获，跳过。

`explain.ts` 这个例子说明了第 4 步的必要性：它覆盖率 82.6% 看着最差，但只有落在未执行语句上的变异才能存活，其余全被测试抓住。

## 实测结果

`deepseek/deepseek-flash`，一次串行运行：

| 任务 | 缺陷类型 | 基线 | 结果 | 耗时 |
|---|---|---|---|---|
| demo-python | 算术运算符写错 | 1/3 | FIXED | 14s |
| py-logstats | 字典默认值给了 1 而不是 0 | 1/3 | FIXED | 15s |
| py-inventory | 跨文件漏调用折扣函数 | 1/3 | FIXED | 16s |
| py-pagination | 页码基准 off-by-one | 0/3 | FIXED | 14s |
| node-async | `forEach` 里的 async 没有被等待 | 0/2 | FIXED | 13s |
| node-unique | `Set` 只保留 key，丢了原始元素 | 1/2 | FIXED | 13s |
| py-textutil-tests | 补测试：覆盖 66.7% → 100%，3 个变异体 | 2/2, 66.7% | PASSED | 62s |
| schema-annotations-tests | 真实仓库：`src/annotations.ts` 覆盖 58.9% → 100% | 327/329, 58.9% | PASSED | 209s |
| schema-explain-tests | 自动生成的任务：`src/explain.ts` 覆盖 82.6% → 100% | 327/329, 82.6% | PASSED | 232s |

修复任务 6/6 全过，平均 14 秒。**这批修复任务的难度偏低**：都是单点、可诊断、测试给出明确期望值的缺陷。它证明链路可用，不证明能力上限。

补测试任务更有信息量：`py-textutil-tests` 里 agent 写了 62 个用例，覆盖了 `limit == len(suffix)`、多空格分隔、非字母首字符这些边界，三个变异体全部被杀死。`schema-annotations-tests` 在真实仓库上写了 732 行测试、10 个 describe 块，覆盖全部 17 个导出。

## 已知局限

- **没有容器隔离。** 工作副本在普通目录里，agent 的 shell 命令与宿主同权限。只适合跑你信任的仓库。
- **单任务串行。** 没有队列、并发、重试。
- **只支持能输出 JUnit XML 的测试框架。** pytest 用 `--junitxml`，Maven Surefire、Jest、Go 的 gotestsum 都能输出同样格式；Node 内置 reporter 的扁平格式也已适配（`<testsuites>` 下直接挂 `<testcase>`，没有 `<testsuite>` 属性）。
- **凭证复制是明文。** 每次运行在 `agent/auth.json` 里有一份 key，运行目录要注意访问权限。
- **真实仓库只支持 `write-tests`。** `repair` 仍受限于"注入什么缺陷才会被测试命中"：试过改 `packages/schema` 里 `anyOf` 的循环边界，40 个测试全程全绿。`write-tests` 没有这个限制，它不需要构造缺陷。
- **`packages/schema` 的接入方式**：用 `--exclude "**/conformance.test.ts"` 排除那个固有 936 个失败的官方套件，用 `--coverage.include="src/x.ts"` 把覆盖率统计锁定到目标模块，`total` 就是该模块的数字。副本里能直接跑 vitest，因为它的配置用 `conditions: ["source"]` 解析源码，不需要预先构建。

## 下一步

按 `HARNESS-PLAN.zh-CN.md` 的阶段推进：并发执行 → 测试领域工具（`run_tests` / `list_failures`）→ 容器隔离 → 结果库。

已完成的：阶段 1（MVP）、阶段 2（补测试 + 覆盖率 + 变异检查）、阶段 5 的报表部分，以及计划外的"覆盖率驱动的任务生成器"。
