# FinPub｜金融酒馆

FinPub 是浏览器内运行的离散时间交易所模拟器。玩家可交易六种酒类资产，并与不同策略的 NPC 在订单簿中撮合。

项目没有后端、数据库、WebSocket 或外部行情源。市场状态、成交、图表和导出数据均只存在于当前浏览器页的内存中；刷新页面、重新开始或重新配置都会创建新市场。

## 启动

```powershell
npm install
npm.cmd run dev
npm.cmd test
npm.cmd run build
```

如 PowerShell 提示 `npm.ps1` 被执行策略阻止，请使用 `npm.cmd`，无需改执行策略。`test` 校验撮合、资金与快照；`build` 做类型检查和生产构建。

## 市场设定

开市前可设置玩家初始现金、每种资产的初始持仓及价格、NPC 数量、手续费、随机种子和模拟起始时间。点击“启动市场”后设定锁定；相同参数和种子会复现同一订单、成交和事件序列。

| 代码 | 名称 | 类别 | 默认价 | 最小变动 |
| --- | --- | --- | ---: | ---: |
| BDX | 波尔多珍藏 | 葡萄酒 | 102.4 | 0.1 |
| ISL | 艾雷岛单一麦芽威士忌 | 威士忌 | 148.6 | 0.1 |
| JDG | 大吟酿 | 清酒 | 86.2 | 0.1 |
| CRM | 加勒比陈年朗姆酒 | 朗姆酒 | 74.8 | 0.1 |
| CHM | 年份香槟 | 香槟 | 126.5 | 0.1 |
| OCR | 果园苹果酒 | 苹果酒 | 39.4 | 0.1 |

## 每秒一轮的交易所流程

市场每秒推进一个 tick，按以下顺序运行：

1. 处理撤单；清理已在簿内停留至少 16 轮的 NPC 限价单。
2. 在预定轮次生成突发事件，再更新公允价值。
3. 随机选择一部分 NPC 生成新订单。
4. 按提交顺序处理本轮待处理订单、撮合并结算。
5. 保存订单簿、账户、总资产和持仓权重快照。

暂停只暂停 tick 推进，不会取消已有订单。

## 委托、撮合与费用

### 委托生命周期

- 玩家订单先进入待撮合队列，在**下一轮**统一处理。
- **限价单**只能从页面买卖五档中选择价格；交叉部分成交，余量继续挂簿。
- **市价单**从最优对手价逐档成交，未成交余量在本轮结束时自动撤销。
- **撤单**在下一轮开始执行；执行前订单仍可能成交。
- 玩家不能卖空。买单冻结委托金额及最高可能费用，卖单冻结对应持仓；成交或撤单后释放未用冻结额。

### 订单簿优先级

- 买单价格越高优先，卖单价格越低优先；同价订单先到先成交。
- 新订单与静态订单交叉时，成交价使用订单簿中对手方（maker）的限价。
- 系统保留全深度，页面仅显示五档。

最新价只在真实成交后更新。没有成交时，公允价值不会直接改写最新成交价。

默认手续费为 maker 0.020%、taker 0.050%。成交额为 `价格 × 数量`；买方现金减少“成交额 + 自身费用”，卖方现金增加“成交额 − 自身费用”。

| 指标 | 计算方式 |
| --- | --- |
| 持仓市值 | 各资产 `数量 × 最新成交价` 之和 |
| 总资产 | 现金 + 持仓市值 |
| 未实现盈亏 | `数量 ×（最新成交价 − 平均成本）` 之和 |
| 已实现盈亏 | 平仓损益减已支付手续费 |
| 总盈亏 | 当前总资产 − 初始净资产 |

## 公允价值、最新价与事件

公允价值供 NPC 估值、报价和生成交易信号；最新价是最后一笔真实成交，用于行情、资产和盈亏。两者不是同一个数字。

```text
公允价值 = 配置后的初始价格 × (1 + 永久冲击 + 短期冲击)
```

结果按最小变动单位取整。短期冲击每轮保留 93%，永久冲击不会自动回退；实际成交价由订单簿、价差、订单量和撮合结果决定。

首个突发事件发生在第 15 轮；之后每隔 15～40 轮。方向约为 53% 利好、47% 利空。约 28% 概率发生关联资产联动：BDX/CHM、ISL/CRM、JDG/OCR 各为一组。

### “初始影响 2.7%”

`BDX · ▲ 利好 · 初始影响 2.7%` 中的 2.7% 是按种子随机生成的**原始估值冲击**，范围为 1.8%～7.5%，以一位小数显示；它不表示最新成交价会直接上涨 2.7%。

```text
永久部分 = 初始影响 × 永久占比
短期部分 = 初始影响 × (1 − 永久占比)
```

永久占比为 16%～38%。短期部分每轮按 93% 衰减，事件产生的额外报价波动每轮按 88% 衰减。事件首先影响公允价值和 NPC 决策，新闻型 NPC 的反应最明显；最终价格仍由真实订单簿撮合决定。

## NPC 规则

每轮产生约 `NPC 数量 × 28%` 次 NPC 决策，最低 12 次、最高 64 次；单个 NPC 最多保留 12 笔未完成委托。NPC 有虚拟无限现金和库存以维持流动性，但现金、仓位、手续费、成交和盈亏仍记入虚拟账本。

每位 NPC 会按种子生成估值偏差（-2.5%～+2.5%）、目标库存（-35～+35）、敏感度（0.65～1.45）和单笔最大量（3～18）。

| 策略 | 行为 |
| --- | --- |
| 做市 | 围绕主观估值双边报价；库存高于目标时降低报价、少买多卖，反之亦然。 |
| 价值 | 主观估值高于中间价/最新价则偏买，反之偏卖。 |
| 趋势 | 根据最近最多 7 笔真实成交价格的涨跌交易。 |
| 新闻 | 放大短期事件冲击，是事件后反应较快的一类。 |
| 随机 | 主要随机选方向，仅轻微受事件影响。 |

非做市策略的信号绝对值超过 1.8% 时，如有对手盘则有 35% 概率发市价单；否则在主观估值和当前参考价附近挂限价单。信号只表示意愿和紧迫程度，不保证成交或同幅度价格变化。

## 自动策略与 Python `on_bar`

“自动策略”页允许玩家直接编辑 Python。浏览器通过 Pyodide 在本地 Web Worker 中执行代码，不会把策略、账户或行情上传到服务器；首次运行需要联网下载 Pyodide 运行时。策略默认关闭，且默认是“模拟执行（Dry run）”：会运行、校验并记录下单或撤单操作，但不会真的改变订单簿。用户主动关闭 Dry run 后，策略操作才会像手动操作一样在下一轮撮合中生效。

策略在**每 5 个 tick 的本轮撮合结束后**执行一次。它生成的订单会在下一 tick 与 NPC 新订单按正常顺序处理，因此不会绕过余额冻结、可用持仓、五档可见价格、价格/时间优先或手续费规则。

```python
def on_bar(ctx):
    bdx = ctx["assets"]["BDX"]
    if bdx["model"]["up_probability"] >= 0.62 and bdx["book"]["best_ask"] is not None:
        return [buy("BDX", quantity=1, price=bdx["book"]["best_ask"])]
    return []
```

`on_bar` 必须返回操作列表。可使用：

```python
# 限价：price 必须是当前可见五档之一
buy(symbol, quantity, price)
sell(symbol, quantity, price)

# 市价：省略 price；本轮未成交的余量会取消
buy(symbol, quantity)
sell(symbol, quantity)

# 撤单：使用 ctx["open_orders"] 中的 id
cancel(order_id)

# 批量撤单：两个过滤条件均可省略
cancel_all(symbol=None, side=None)
```

每个 Bar 最多返回 6 个操作，其中最多 3 笔下单、每笔 1～25 单位。限价单只能使用当前可见买卖五档中的价格；市价单需要当前存在对手方流动性，未成交余量会在本轮撮合结束时取消。撤单申请同样在下一轮撮合处理；`cancel_all` 只会作用于该 Bar 开始时符合过滤条件的有效委托。格式错误、余额不足、可用持仓不足、报价不可见或订单不可撤销的操作会被拒绝并写入策略日志。

### `ctx` 变量字典

| 变量 | 含义 |
| --- | --- |
| `ctx["tick"]` / `ctx["sim_time"]` | 当前撮合轮次与模拟时间。 |
| `ctx["bar_index"]` / `ctx["bar_ticks"]` | 当前策略 Bar 编号与 Bar 长度（固定 5 tick）。 |
| `ctx["model_version"]` | 内置特征模型版本，当前为 `signal_v1`。 |
| `ctx["account"]["cash"]` | 玩家总现金。 |
| `ctx["account"]["available_cash"]` / `frozen_cash` | 可用于新买单的现金 / 已为挂单冻结的现金。 |
| `ctx["account"]["total_asset"]` / `position_value` / `unrealized_pnl` | 总资产、持仓市值、未实现盈亏。 |
| `ctx["open_orders"]` | 玩家当前所有 `queued`、`open`、`partial`、`pending_cancel` 订单；每条含原有订单字段，以及 `order_age_ticks`。对于已在簿内的 `open`/`partial` 限价单，还精确提供 `queue_ahead_volume`、`queue_ahead_order_count`、`queue_rank`、`level_total_volume`、`level_total_order_count`；其他状态的 FIFO 字段为 `None`。可用 `id` 调用 `cancel(id)`。 |
| `ctx["event"]` | 最新事件；无事件为 `None`。事件对象含 `tick`、`direction`、`symbols`、`impact`、`permanent_share`。 |
| `ctx["assets"]["BDX"]["bars"]` | 最近最多 60 根策略 Bar；每根含 `tick`、`open`、`high`、`low`、`close`、`volume`。这是低频 OHLCV 序列，不是盘口历史。 |
| `ctx["assets"]["BDX"]["book"]` | 当前完整五档：除 `best_bid`、`best_ask`、`mid`、`spread`、`bid_quantity`、`ask_quantity` 外，含按最优到最差排序的 `bids`/`asks`。每档含 `level`、`price`、`volume`、`order_count`、`oldest_order_age_ticks`、`newest_order_age_ticks`、`average_order_age_ticks`。`volume` 是未成交挂单量，不是已成交量。 |
| `ctx["assets"]["BDX"]["orderbook_history"]` | 最近最多 **50 个已完成 tick** 的五档订单簿序列，包含当前 tick 和此前最多 49 个 tick。每项含 `tick`、`sim_time`、五档 `bids`/`asks`（每档 `level`、`price`、`volume`）及本 tick 的 `aggressive_buy_volume`、`aggressive_sell_volume`、`aggressive_buy_trades`、`aggressive_sell_trades`。盘口快照取自该 tick 全部撮合完成后的状态。 |
| `ctx["assets"]["BDX"]["order_flow"]` | 根据 `orderbook_history` 精确汇总的 `last_5_ticks`、`last_20_ticks`、`last_50_ticks` 主动买卖成交量和成交笔数。策略也可直接从逐 tick 历史计算任意不超过 50 的窗口。 |
| `ctx["assets"]["BDX"]["fair_value"]` | 当前公允价值，不等于最新成交价。 |
| `ctx["assets"]["BDX"]["position"]` | 本标的的 `quantity`、`available`、`reserved`、`average_cost`。 |
| `ctx["assets"]["BDX"]["model"]` | 内置 `signal_v1` 的 `up_probability`、`expected_return`、`momentum_1`、`momentum_5`、`fair_value_gap`、`book_imbalance`、`spread_bps`、`event_signal`。 |

`signal_v1` 不是外部价格预测服务，而是一个可复现的小型确定性特征模型：它将 1/5 Bar 动量、公允价值偏离、五档量差、价差和最近事件信号组合为预期收益与上涨概率。它只供策略读取；不直接修改成交价或替玩家下单。

当前没有把“最近 N tick 撤单量”作为精确策略字段：订单模型尚未记录撤单发生 tick、撤单剩余量与撤单原因，不能从盘口变化中可靠地区分撤单和成交。该能力需要独立的订单生命周期事件流。

### 加速与 Python 回放包

顶部“加速推进 ×25”会连续执行 25 个完整 tick；它不改变 tick 内规则，只是不等待真实的一秒。若启用了策略，每逢第 5 tick 仍会同步运行一次 `on_bar`。

自动策略页的“下载 Python 回放包”会生成 `finpub-python-replay.zip`，包含当前 `strategy.py`、初始配置、确定性市场/NPC/事件/撮合引擎和 `run.py`。解压后执行 `python run.py`，即可不等待秒数地快速回放，并导出成交、资产和策略 CSV。为了与浏览器从第 0 轮一致，必须使用相同初始配置、种子、模拟起点、策略代码、策略模式与 tick 数；手动网页下单或在中途修改/启用策略不会自动写进回放包，应改写进 `on_bar` 才能被完整复现。

## 数据、图表与导出

- **成交价格走势**：只收录真实成交；无成交时没有价格路径。
- **资产历史**：每轮记录玩家总资产和权重。标的权重 = 标的市值 ÷ 总资产；现金权重 = 现金 ÷ 总资产；二者正常合计 100%。
- **订单簿快照**：每轮记录各资产买卖前五档、最优买卖价、中间价和价差。
- **交易者统计**：每轮记录玩家和 NPC 的现金、持仓市值、盈亏、费用、成交数与净持仓。

“导出数据”会下载：

| 文件 | 内容 |
| --- | --- |
| `trades.csv` | 每笔成交、买卖双方、maker/taker、费用、成交额、现金变化 |
| `orderbook_1s.csv` | 每轮订单簿五档与报价指标 |
| `participant_pnl_1s.csv` | 每轮玩家和 NPC 的账户、持仓市值、盈亏、费用与成交统计 |
| `strategy_bars.csv` | 每个策略 Bar 的 OHLCV、五档摘要、公允价值、模型特征/输出、账户、持仓、事件、5/20/50 tick 主动订单流、当时 `open_orders` JSON，以及策略当时看到的 50 tick `orderbook_history_json` |
| `strategy_runs.csv` | 每次 `on_bar` 的 tick、状态、耗时、输出和错误信息 |
| `strategy_orders.csv` | 策略下单与撤单操作的 dry run / queued / cancel_requested / rejected 结果、订单类型、价格、数量、订单 ID 和原因 |

事件和资产历史权重暂未单独导出 CSV，可在“事件时间线”和“资产历史”查看。

“清除缓存”删除累计成交、已完成委托、事件和历史快照，但保留当前余额、仓位、有效委托和订单簿，并建立新的当前基线；“重新开始”用锁定配置从第 0 轮重建市场；“重新配置”可建立全新市场。

## 边界

FinPub 用于理解订单簿、流动性、策略互动、事件冲击和账户核算。所有价格、事件和 NPC 行为均为程序生成的模拟结果，不提供真实行情、投资建议或真实交易。
