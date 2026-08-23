// 滑窗 + 累计 ACK 发送器：插件侧 transfer.rs WindowedSender 的 JS 镜像。
// 任一时刻最多 window 帧在途；接收方每收一帧回一个累计 ACK
// （ack = 下一个仍缺失的连续 gseq，即 gseq < ack 全部已收）。
// ACK 前进 → 窗口前移补发新帧；ACK 停滞（重复 ACK）→ go-back-N 整窗重发，
// 每个停滞点只重传一次（retxBase 防单次丢片的一串重复 ACK 引发重传风暴）；
// ACK 超时兜底整窗重发（整窗全丢时没有重复 ACK 可依赖）。
// 与 stopWaitQueue 的区别：不要求底层有序，帧顺序由接收方按 gseq 还原。
//
// 使用方（dataBridge）：手表→插件的同步会话（app_data 列表 + 封面切片 + cover_done
// 打平成一条帧流）；插件→手表方向角色相反（手表是接收方），不用本模块。

export function createWindowedSender(options) {
  const frames = options.frames || [];
  const window = Math.max(1, options.window || 4);
  const ackTimeout = options.ackTimeout || 3000;
  const maxRetry = options.maxRetry || 5;
  const sendFrame = options.sendFrame; // (frameObjWithGseq) => void
  const onAllDone = options.onAllDone || function () {};
  const onAbort = options.onAbort || function () {};
  const label = options.label || "传输";

  let base = 0; // 首个未确认帧 = 对端累计 ACK 值
  let next = 0; // 下一个待发帧序号
  let retxBase = -1; // 最近一次 go-back-N 的停滞点（base 单调递增，同点只重传一次）
  let retry = 0;
  let timer = null;
  let finished = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function armTimer() {
    clearTimer();
    timer = setTimeout(function () {
      timer = null;
      if (finished) return;
      retry++;
      if (retry > maxRetry) {
        finished = true;
        console.debug(label + " ACK 超时重发超限，中止");
        onAbort();
        return;
      }
      console.debug(label + " ACK 超时，整窗重发 (" + retry + ")");
      retxBase = base;
      next = base;
      pump();
    }, ackTimeout);
  }

  // 发送窗口内待发帧 [next, min(base+window, frames.length))
  function pump() {
    if (finished) return;
    let sent = false;
    while (next < base + window && next < frames.length) {
      const f = Object.assign({}, frames[next], { gseq: next });
      next++;
      sendFrame(f);
      sent = true;
    }
    // 有在途帧就武装超时；窗口满等待 ACK 期间同样需要超时兜底
    if (sent || base < frames.length) {
      armTimer();
    }
  }

  pump();

  return {
    // 收到对端累计 ACK 时喂入
    notifyAck: function (ack) {
      if (finished || typeof ack !== "number") return;
      if (ack > frames.length) ack = frames.length;
      if (ack > base) {
        base = ack;
        retry = 0;
        if (base >= frames.length) {
          finished = true;
          clearTimer();
          onAllDone();
          return;
        }
        pump();
      } else if (next > base && retxBase !== base) {
        // 停滞：对端在等 base 处的洞，go-back-N 整窗重发（同点一次）
        retxBase = base;
        next = base;
        pump();
      }
    },
    // 新会话/新握手接管时取消：停表 + 后续 ACK 不再生效
    cancel: function () {
      finished = true;
      clearTimer();
    },
    isFinished: function () {
      return finished;
    },
  };
}
