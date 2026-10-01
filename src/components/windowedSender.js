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
  const window = Math.max(1, options.window || 4);
  const bufferLimit = Math.max(window, options.maxBufferedFrames || window * 2);
  const ackTimeout = options.ackTimeout || 3000;
  const readTimeout = options.readTimeout || 20000;
  const maxRetry = options.maxRetry || 5;
  const sendFrame = options.sendFrame; // (frameObjWithGseq) => void
  const onAllDone = options.onAllDone || function () {};
  const onAbort = options.onAbort || function () {};
  const onStop = options.onStop || function () {};
  const label = options.label || "传输";

  // readFrame()异步返回一帧，null表示EOF。只存未ACK/少量预读帧，支持未知总长。
  // frames参数保留旧调用兼容；按需供帧方不构建整次传输的数组。
  let sourceFrames = options.frames || [];
  let sourceIndex = 0;
  let readFrame = options.readFrame || (() => sourceFrames[sourceIndex++] || null);
  const frames = new Map();
  let base = 0; // 首个未确认帧 = 对端累计 ACK 值
  let next = 0; // 下一个待发帧序号
  let produced = 0;
  let sentFrontier = 0; // 实际发送过的最大连续前沿，ACK不得越过
  let retxBase = -1; // 最近一次 go-back-N 的停滞点（base 单调递增，同点只重传一次）
  let retry = 0;
  let timer = null;
  let readTimer = null;
  let reading = false;
  let ended = false;
  let pumping = false;
  let finished = false;

  function clearTimer() {
    clearTimeout(timer);
    timer = null;
  }

  function stop(done, err) {
    if (finished) return;
    finished = true;
    clearTimer();
    clearTimeout(readTimer);
    readTimer = null;
    frames.clear();
    sourceFrames = readFrame = null;
    onStop();
    if (done) onAllDone();
    else if (err) onAbort(err);
  }

  function checkDone() {
    if (ended && base === produced) stop(true);
  }

  function armTimer() {
    if (timer || finished || base >= sentFrontier) return;
    timer = setTimeout(function () {
      timer = null;
      if (finished) return;
      retry++;
      if (retry > maxRetry) {
        console.debug(label + " ACK 超时重发超限，中止");
        stop(false, new Error("ACK timeout"));
        return;
      }
      console.debug(label + " ACK 超时，整窗重发 (" + retry + ")");
      retxBase = base;
      next = base;
      pump();
    }, ackTimeout);
  }

  // 发送已生成的窗口帧；生产暂时为空时等待读盘，不当成EOF或ACK超时。
  function pump() {
    if (finished || pumping) return;
    pumping = true;
    try {
      while (!finished && next < base + window && next < produced) {
        const f = Object.assign({}, frames.get(next), { gseq: next });
        next++;
        sentFrontier = Math.max(sentFrontier, next);
        sendFrame(f);
      }
      armTimer();
      checkDone();
    } catch (e) {
      stop(false, e);
    } finally {
      pumping = false;
    }
  }

  function fill() {
    if (finished || ended || reading || frames.size >= bufferLimit) return;
    reading = true;
    // 预留一个槽给正在生成的帧；生产端最多一个file.get/readArrayBuffer在途。
    readTimer = setTimeout(() => stop(false, new Error("frame read timeout")), readTimeout);
    let result;
    try {
      result = readFrame();
    } catch (e) {
      stop(false, e);
      return;
    }
    Promise.resolve(result).then(
      (frame) => {
        if (finished) return;
        reading = false;
        clearTimeout(readTimer);
        readTimer = null;
        if (frame === null) ended = true;
        else frames.set(produced++, frame);
        pump();
        fill();
      },
      (err) => stop(false, err || new Error("frame read failed"))
    );
  }

  // 先返回句柄，让调用方挂好ACK/取消路由，再开始供帧。
  Promise.resolve().then(fill);

  return {
    // 收到对端累计 ACK 时喂入
    notifyAck: function (ack) {
      if (finished || !Number.isSafeInteger(ack) || ack < 0 || ack > sentFrontier) return;
      if (ack > base) {
        for (let seq = base; seq < ack; seq++) frames.delete(seq);
        base = ack;
        next = Math.max(next, base);
        retry = 0;
        clearTimer();
        pump();
        fill();
      } else if (ack === base && next > base && retxBase !== base) {
        // 严格重复 ACK 才算停滞（P2-35⑤）：过期 ACK（ack < base，QAIC 乱序迟到）整段
        // 忽略，否则被当停滞触发整窗重传白耗带宽；对端在等 base 处的洞时
        // go-back-N 整窗重发（retxBase 同点一次）
        retxBase = base;
        next = base;
        pump();
      }
    },
    // 新会话/新握手接管时取消：停表 + 后续 ACK 不再生效
    cancel: function () {
      stop(false);
    },
    isFinished: function () {
      return finished;
    },
  };
}
