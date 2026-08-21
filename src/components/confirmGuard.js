import prompt from "@system.prompt";

// 二次确认操作守卫：首次触发仅 toast 提示并记下 key，3 秒内同 key 再次触发才返回 true 放行执行。
// 每个调用点用 createConfirmGuard() 创建独立实例，各自维护待确认状态
export function createConfirmGuard() {
  let pendingKey = null;
  return function confirm(key, message, toastOptions) {
    if (pendingKey !== key) {
      // 第一次点击，提示二次确认
      pendingKey = key;
      prompt.showToast({ message: message, ...toastOptions });
      // 3秒后重置
      setTimeout(() => {
        if (pendingKey === key) {
          pendingKey = null;
        }
      }, 3000);
      return false;
    }
    // 第二次点击，放行执行
    pendingKey = null;
    return true;
  };
}
