// 停等 ACK 发送队列：严格按序逐条发送，每条发出后等对端 ACK 才推进下一条
// （解决安卓端 QAIC 消息乱序问题）；ACK 超时整包重发（有界，超限跳过防挂死），
// 发送失败跳过本条；代际（epoch）机制让迟到回调自动失效。
//
// 两个使用方（dataBridge）：
//   - sendAppDataBatched：书单/源列表逐消息停等（key = 消息序号）
//   - 封面推送：每张封面"分片连续发 + 末片后等 cover_ack"（key = 封面名，
//     分片子循环留在 sendItem 内部，ctx.sent() 后才进入等 ACK）
// interconnfetch 的接收端累计 ACK（go-back-N）角色相反、无可复用结构，不用本模块。

export function createStopWaitQueue(options) {
  const items = options.items || [];
  const keyOf = options.keyOf; // (item, index) => ack 匹配键
  const sendItem = options.sendItem; // (item, ctx) => void
  const ackTimeout = options.ackTimeout;
  const maxRetry = options.maxRetry; // 每条最多整包重发次数
  const itemPacing = options.itemPacing || 0; // 条间节流间隔 ms
  const onItemSettled = options.onItemSettled || null; // (item, index, ok)
  const onAllDone = options.onAllDone;
  const label = options.label || "消息";

  let index = 0;
  let retry = 0;
  let timer = null;
  let epoch = 0; // 每次推进/重发/取消 +1，sendItem 内迟到回调据此丢弃
  let finished = false;

  function clearAckTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function settle(ok) {
    clearAckTimer();
    if (onItemSettled) {
      onItemSettled(items[index], index, ok);
    }
    index++;
    retry = 0;
    epoch++;
    if (itemPacing > 0) {
      const pacingEpoch = epoch;
      setTimeout(function () {
        if (pacingEpoch === epoch) next();
      }, itemPacing);
    } else {
      next();
    }
  }

  function next() {
    if (finished) return;
    if (index >= items.length) {
      finished = true;
      clearAckTimer();
      onAllDone();
      return;
    }
    epoch++;
    const attemptEpoch = epoch;
    const item = items[index];
    sendItem(item, {
      // 供 sendItem 内部异步回调判断自己是否已过期
      isStale: function () {
        return finished || attemptEpoch !== epoch;
      },
      // 本条发送动作完成，进入等 ACK；超时先整包重发、超限跳过
      sent: function () {
        if (finished || attemptEpoch !== epoch) return;
        clearAckTimer();
        timer = setTimeout(function () {
          timer = null;
          if (retry < maxRetry) {
            retry++;
            console.debug(label + " " + index + " ACK 超时，整包重发 (" + retry + ")");
            next(); // index 不动，重发同一条
          } else {
            console.debug(label + " " + index + " ACK 重发超限，跳过");
            settle(false);
          }
        }, ackTimeout);
      },
      // 本条发送通道失败，直接跳过
      failed: function () {
        if (finished || attemptEpoch !== epoch) return;
        settle(false);
      },
    });
  }

  next();

  return {
    // 收到对端 ACK 时喂入；键与当前等待条目不匹配（迟到/乱序 ACK）则忽略
    notifyAck: function (key) {
      if (finished || !timer) return;
      if (key !== keyOf(items[index], index)) return;
      settle(true);
    },
    // 新会话/新流程接管时取消本队列：停表 + 全部在途回调过期
    cancel: function () {
      finished = true;
      epoch++;
      clearAckTimer();
    },
    isFinished: function () {
      return finished;
    },
  };
}
